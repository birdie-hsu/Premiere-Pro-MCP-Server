import { createReadStream } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SAMPLE_RATE = 8_000;
const BUCKET_SECONDS = 1;

function nullDevice() {
  return process.platform === 'win32' ? 'NUL' : '/dev/null';
}

function timeoutFor(durationSeconds, minimum = 10 * 60 * 1000) {
  return Math.max(minimum, Math.min(4 * 60 * 60 * 1000, (durationSeconds || 60) * 4_000));
}

export async function probeMedia(mediaPath, config) {
  try {
    const { stdout } = await execFileAsync(config.ffprobeBin, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      mediaPath,
    ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60_000, windowsHide: true });
    const data = JSON.parse(stdout);
    const format = data.format ?? {};
    const streams = Array.isArray(data.streams) ? data.streams : [];
    const video = streams.find((stream) => stream.codec_type === 'video') ?? null;
    const audio = streams.find((stream) => stream.codec_type === 'audio') ?? null;
    const duration = Number(format.duration ?? video?.duration ?? audio?.duration ?? 0);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('ffprobe returned no usable duration');
    return {
      durationSeconds: duration,
      formatName: format.format_name ?? null,
      sizeBytes: Number(format.size ?? 0) || null,
      video: video ? {
        codec: video.codec_name ?? null,
        width: Number(video.width ?? 0) || null,
        height: Number(video.height ?? 0) || null,
        frameRate: parseFrameRate(video.r_frame_rate ?? video.avg_frame_rate),
        timeBase: video.time_base ?? null,
      } : null,
      audio: audio ? {
        codec: audio.codec_name ?? null,
        channels: Number(audio.channels ?? 0) || null,
        sampleRate: Number(audio.sample_rate ?? 0) || null,
      } : null,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`ffprobe was not found. Set HIGHLIGHT_FFPROBE_BIN to an absolute ffprobe path.`);
    }
    if (error instanceof SyntaxError) throw new Error(`ffprobe returned invalid JSON for ${mediaPath}`);
    throw new Error(`Could not inspect media with ffprobe: ${error?.message ?? String(error)}`);
  }
}

export function parseFrameRate(value) {
  if (typeof value !== 'string' || !value) return 30;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 30;
  const fps = numerator / denominator;
  return Number.isFinite(fps) && fps > 0 ? fps : 30;
}

async function writeAudioPcm(mediaPath, pcmPath, durationSeconds, config) {
  try {
    await execFileAsync(config.ffmpegBin, [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', mediaPath,
      '-map', '0:a:0?',
      '-vn',
      '-ac', '1',
      '-ar', String(SAMPLE_RATE),
      '-f', 'f32le',
      pcmPath,
    ], {
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutFor(durationSeconds),
      killSignal: 'SIGKILL',
      windowsHide: true,
    });
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('ffmpeg was not found. Set HIGHLIGHT_FFMPEG_BIN to an absolute ffmpeg path.');
    if (error?.killed) throw new Error('Audio extraction timed out and was killed.');
    throw new Error(`FFmpeg could not extract audio: ${error?.message ?? String(error)}`);
  }
}

/** Extract one-second RMS/peak buckets without loading the whole audio file into memory. */
export async function readAudioMetrics(mediaPath, durationSeconds, pcmPath, config, onProgress) {
  await writeAudioPcm(mediaPath, pcmPath, durationSeconds, config);
  const metrics = [];
  let leftover = Buffer.alloc(0);
  let samplesInBucket = 0;
  let sumSquares = 0;
  let peak = 0;
  let totalSamples = 0;
  const samplesPerBucket = SAMPLE_RATE * BUCKET_SECONDS;
  const flush = () => {
    if (samplesInBucket === 0) return;
    const rms = Math.sqrt(sumSquares / samplesInBucket);
    metrics.push({
      startSeconds: (totalSamples - samplesInBucket) / SAMPLE_RATE,
      durationSeconds: samplesInBucket / SAMPLE_RATE,
      rms,
      peak,
      db: 20 * Math.log10(Math.max(rms, 1e-7)),
    });
    samplesInBucket = 0;
    sumSquares = 0;
    peak = 0;
  };

  for await (const chunk of createReadStream(pcmPath)) {
    const data = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
    const usable = data.length - (data.length % 4);
    for (let offset = 0; offset < usable; offset += 4) {
      const sample = Math.max(-1, Math.min(1, data.readFloatLE(offset)));
      const magnitude = Math.abs(sample);
      sumSquares += sample * sample;
      peak = Math.max(peak, magnitude);
      samplesInBucket += 1;
      totalSamples += 1;
      if (samplesInBucket >= samplesPerBucket) flush();
    }
    leftover = usable < data.length ? data.subarray(usable) : Buffer.alloc(0);
    if (durationSeconds > 0) onProgress?.(Math.min(45, Math.round((totalSamples / SAMPLE_RATE / durationSeconds) * 45)), 'measuring audio energy');
  }
  flush();
  await rm(pcmPath, { force: true });
  return metrics;
}

export async function detectScenes(mediaPath, durationSeconds, threshold, config, onProgress) {
  try {
    const { stderr } = await execFileAsync(config.ffmpegBin, [
      '-hide_banner',
      '-loglevel', 'info',
      '-i', mediaPath,
      '-an',
      '-vf', `select='gt(scene,${threshold})',showinfo`,
      '-f', 'null',
      nullDevice(),
    ], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutFor(durationSeconds),
      killSignal: 'SIGKILL',
      windowsHide: true,
    });
    const scenes = [];
    const pattern = /pts_time\s*:\s*(-?\d+(?:\.\d+)?)/g;
    for (const match of stderr.matchAll(pattern)) {
      const time = Number(match[1]);
      if (Number.isFinite(time) && time >= 0 && time <= durationSeconds && scenes.at(-1) !== time) scenes.push(time);
      if (scenes.length >= 1_000) break;
    }
    onProgress?.(55, `found ${scenes.length} scene changes`);
    return scenes;
  } catch (error) {
    // Scene detection is a supporting signal. A codec/filter failure should
    // not prevent audio/transcript-based highlight detection.
    onProgress?.(55, 'scene detection unavailable; continuing with audio and transcript');
    return [];
  }
}

export async function extractFrame(mediaPath, seconds, outputPath, config) {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  try {
    await execFileAsync(config.ffmpegBin, [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-ss', String(safeSeconds),
      '-i', mediaPath,
      '-frames:v', '1',
      '-vf', 'scale=640:-2',
      '-q:v', '4',
      outputPath,
    ], { maxBuffer: 8 * 1024 * 1024, timeout: 120_000, windowsHide: true });
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('ffmpeg was not found. Set HIGHLIGHT_FFMPEG_BIN to an absolute ffmpeg path.');
    throw new Error(`Could not extract frame: ${error?.message ?? String(error)}`);
  }
  const data = await readFile(outputPath);
  return { data, mimeType: 'image/jpeg', seconds: safeSeconds };
}
