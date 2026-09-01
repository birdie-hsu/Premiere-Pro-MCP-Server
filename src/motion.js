import { spawn } from 'node:child_process';

const MOTION_WIDTH = 96;
const MOTION_HEIGHT = 54;
const MOTION_FRAME_BYTES = MOTION_WIDTH * MOTION_HEIGHT;

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function quantile(values, percentile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * percentile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function frameDifference(previous, current) {
  let total = 0;
  for (let index = 0; index < current.length; index += 1) {
    total += Math.abs(current[index] - previous[index]);
  }
  return total / (255 * current.length);
}

function groupEventTimes(times, gapSeconds = 2) {
  const events = [];
  for (const time of times) {
    const previous = events.at(-1);
    if (previous && time - previous.endSeconds <= gapSeconds) {
      previous.endSeconds = time;
      previous.centerSeconds = (previous.startSeconds + previous.endSeconds) / 2;
    } else {
      events.push({ startSeconds: time, endSeconds: time, centerSeconds: time });
    }
  }
  return events;
}

function spawnMotionProbe(mediaPath, durationSeconds, config, onFrame) {
  const sampleRate = Math.max(0.25, Math.min(2, Number(config.motionSampleRate) || 1));
  const filter = `fps=${sampleRate},scale=${MOTION_WIDTH}:${MOTION_HEIGHT},format=gray`;
  const child = spawn(config.ffmpegBin, [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', mediaPath,
    '-an',
    '-vf', filter,
    '-f', 'rawvideo',
    '-pix_fmt', 'gray',
    'pipe:1',
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

  return new Promise((resolve, reject) => {
    let pending = Buffer.alloc(0);
    let stderr = '';
    let frameIndex = 0;
    let settled = false;
    let previous = null;
    const timeoutMs = Math.max(10 * 60 * 1000, Math.min(4 * 60 * 60 * 1000, (durationSeconds || 60) * 4_000));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('Motion analysis timed out and was killed.'));
    }, timeoutMs);

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    child.on('error', (error) => {
      if (error?.code === 'ENOENT') finish(new Error('ffmpeg was not found. Set HIGHLIGHT_FFMPEG_BIN to an absolute ffmpeg path.'));
      else finish(error);
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4_000);
    });
    child.stdout.on('data', (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= MOTION_FRAME_BYTES) {
        const frame = pending.subarray(0, MOTION_FRAME_BYTES);
        pending = pending.subarray(MOTION_FRAME_BYTES);
        if (previous) {
          const timestamp = frameIndex / sampleRate;
          onFrame({ timestamp, difference: frameDifference(previous, frame) });
        }
        previous = Buffer.from(frame);
        frameIndex += 1;
        if (durationSeconds > 0) {
          onFrame({ progress: Math.min(97, 96 + Math.round((frameIndex / Math.max(durationSeconds * sampleRate, 1)))) });
        }
      }
    });
    child.on('close', (code, signal) => {
      if (code !== 0) {
        finish(new Error(`FFmpeg motion probe failed${stderr ? `: ${stderr.trim()}` : ` with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`}`));
        return;
      }
      finish(null, { sampleRate, frameCount: frameIndex });
    });
  });
}

/**
 * Measure low-resolution frame-to-frame change locally with FFmpeg. This is a
 * deliberately weak visual signal: it detects change, not semantic action.
 */
export async function detectMotion(mediaPath, durationSeconds, config, onProgress) {
  const differences = [];
  const probe = await spawnMotionProbe(mediaPath, durationSeconds, config, (value) => {
    if (typeof value.difference === 'number') differences.push(value.difference);
    if (typeof value.progress === 'number') onProgress?.(value.progress, 'measuring low-resolution motion');
  });
  if (differences.length === 0) {
    return { sampleRate: probe.sampleRate, frameCount: probe.frameCount, threshold: 0, metrics: [], events: [], peaks: [] };
  }

  const baseline = quantile(differences, 0.5);
  const mad = quantile(differences.map((value) => Math.abs(value - baseline)), 0.5);
  const upper = Math.max(quantile(differences, 0.9), baseline + 0.01);
  const configuredThreshold = Number(config.motionDiffThreshold);
  const threshold = Math.max(
    Number.isFinite(configuredThreshold) && configuredThreshold > 0 ? configuredThreshold : 0.08,
    baseline + Math.max(mad * 3, 0.015),
  );
  const scale = Math.max(upper - baseline, mad * 3, 0.01);
  const metrics = differences.map((difference, index) => ({
    startSeconds: index / probe.sampleRate,
    durationSeconds: 1 / probe.sampleRate,
    difference: Math.round(difference * 10_000) / 10_000,
    score: Math.round(clamp((difference - baseline) / scale) * 100) / 100,
    event: difference >= threshold,
    peak: difference >= Math.max(threshold, upper),
  }));
  const eventTimes = metrics.filter((metric) => metric.event).map((metric) => metric.startSeconds);
  const peakTimes = metrics.filter((metric) => metric.peak).map((metric) => metric.startSeconds);
  const events = groupEventTimes(eventTimes).map((event) => ({
    startSeconds: Math.round(event.startSeconds * 1000) / 1000,
    endSeconds: Math.round((event.endSeconds + 1 / probe.sampleRate) * 1000) / 1000,
    centerSeconds: Math.round(event.centerSeconds * 1000) / 1000,
  }));
  onProgress?.(97, `found ${events.length} motion events`);
  return {
    sampleRate: probe.sampleRate,
    frameCount: probe.frameCount,
    baseline: Math.round(baseline * 10_000) / 10_000,
    threshold: Math.round(threshold * 10_000) / 10_000,
    metrics,
    events,
    peaks: peakTimes.map((time) => Math.round(time * 1000) / 1000),
  };
}
