import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { parseCaptionText } from './captions.js';

const execFileAsync = promisify(execFile);
const WINDOW_SECONDS = 30;
const OVERLAP_SECONDS = 5;
const SAMPLE_RATE = 16_000;
const BYTES_PER_SECOND = SAMPLE_RATE * 4;

let cachedPipeline = null;
let cachedPipelineKey = '';
let transformerQueue = Promise.resolve();

async function readPcmWindow(mediaPath, startSeconds, config) {
  try {
    const { stdout } = await execFileAsync(config.ffmpegBin, [
      '-hide_banner',
      '-loglevel', 'error',
      '-ss', String(startSeconds),
      '-i', mediaPath,
      '-t', String(WINDOW_SECONDS),
      '-vn',
      '-ar', String(SAMPLE_RATE),
      '-ac', '1',
      '-c:a', 'pcm_f32le',
      '-f', 'f32le',
      'pipe:1',
    ], {
      encoding: 'buffer',
      maxBuffer: WINDOW_SECONDS * BYTES_PER_SECOND + 1 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
      killSignal: 'SIGKILL',
      windowsHide: true,
    });
    const usable = stdout.length - (stdout.length % 4);
    const bytes = Uint8Array.from(stdout.subarray(0, usable));
    return new Float32Array(bytes.buffer);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('ffmpeg was not found for local transcription.');
    if (error?.killed) throw new Error('Audio decoding for transcription timed out.');
    throw new Error(`FFmpeg could not decode audio for transcription: ${error?.message ?? String(error)}`);
  }
}

async function loadPipeline(config, onProgress) {
  if (!config.transformersRuntime) {
    throw new Error('Local Transformers ASR is not configured. Set HIGHLIGHT_TRANSFORMERS_RUNTIME or provide a .srt/.vtt sidecar.');
  }
  const key = `${config.transformersRuntime}|${config.asrModel}|${config.asrRevision}|${config.asrCacheDir}`;
  if (cachedPipeline && cachedPipelineKey === key) return cachedPipeline;
  let runtime;
  try {
    runtime = await import(pathToFileURL(config.transformersRuntime).href);
  } catch (error) {
    throw new Error(`Could not load the local Transformers runtime: ${error?.message ?? String(error)}`);
  }
  const { pipeline, env } = runtime;
  if (typeof pipeline !== 'function') throw new Error('The configured Transformers runtime does not export pipeline().');
  env.cacheDir = config.asrCacheDir;
  // This project is local-first: a missing model should fail with a useful
  // message instead of silently downloading from the network during editing.
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  onProgress?.(60, 'loading local speech model');
  cachedPipelineKey = key;
  cachedPipeline = pipeline('automatic-speech-recognition', config.asrModel, {
    dtype: 'q8',
    revision: config.asrRevision,
    progress_callback: (progress) => {
      if (typeof progress?.progress === 'number') onProgress?.(60 + Math.min(15, Math.round(progress.progress / 7)), 'loading local speech model');
    },
  }).catch((error) => {
    cachedPipeline = null;
    cachedPipelineKey = '';
    throw new Error(`Could not load local ASR model ${config.asrModel}: ${error?.message ?? String(error)}. Verify the model cache or add a local sidecar caption file.`);
  });
  return cachedPipeline;
}

function ownChunks(chunks, windowStart, isLast) {
  const left = windowStart === 0 ? Number.NEGATIVE_INFINITY : windowStart + OVERLAP_SECONDS / 2;
  const right = isLast ? Number.POSITIVE_INFINITY : windowStart + WINDOW_SECONDS - OVERLAP_SECONDS / 2;
  return chunks.map((chunk) => {
    const timestamp = Array.isArray(chunk?.timestamp) ? chunk.timestamp : [0, 0];
    const start = Number(timestamp[0]);
    const end = Number(timestamp[1]);
    return {
      startSeconds: windowStart + (Number.isFinite(start) ? start : 0),
      endSeconds: windowStart + (Number.isFinite(end) && end > 0 ? end : Math.max(start, 0) + 0.2),
      text: String(chunk?.text ?? '').trim(),
    };
  }).filter((chunk) => {
    const midpoint = (chunk.startSeconds + chunk.endSeconds) / 2;
    return chunk.text && midpoint >= left && midpoint < right;
  });
}

async function transcribeWithTransformers(mediaPath, durationSeconds, config, onProgress) {
  let release;
  const previous = transformerQueue;
  transformerQueue = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    const transcriber = await loadPipeline(config, onProgress);
    const cues = [];
    const step = WINDOW_SECONDS - OVERLAP_SECONDS;
    for (let start = 0; start < durationSeconds; start += step) {
      const audio = await readPcmWindow(mediaPath, start, config);
      if (audio.length === 0) break;
      const decodedSeconds = audio.length / SAMPLE_RATE;
      const isLast = start + WINDOW_SECONDS >= durationSeconds || decodedSeconds < WINDOW_SECONDS - 0.05;
      const raw = await transcriber(audio, { return_timestamps: true });
      const output = Array.isArray(raw) ? raw[0] : raw;
      const chunks = Array.isArray(output?.chunks) && output.chunks.length
        ? output.chunks
        : [{ timestamp: [0, decodedSeconds], text: output?.text ?? '' }];
      cues.push(...ownChunks(chunks, start, isLast));
      onProgress?.(75 + Math.min(20, Math.round(((start + decodedSeconds) / Math.max(durationSeconds, 1)) * 20)), 'transcribing local audio');
      if (isLast) break;
    }
    const unique = [];
    for (const cue of cues.sort((left, right) => left.startSeconds - right.startSeconds)) {
      const previousCue = unique.at(-1);
      if (previousCue && Math.abs(previousCue.startSeconds - cue.startSeconds) < 0.05 && previousCue.text === cue.text) continue;
      if (cue.endSeconds > cue.startSeconds && cue.text) unique.push(cue);
    }
    onProgress?.(95, `transcription produced ${unique.length} cues`);
    return { cues: unique, source: 'local-transformers', model: config.asrModel };
  } finally {
    release?.();
  }
}

export async function getTranscript(mediaPath, durationSeconds, sidecar, config, onProgress) {
  if (sidecar?.cues?.length) return { cues: sidecar.cues, source: 'sidecar', path: sidecar.path };
  if (config.asrMode === 'none' || config.asrMode === 'sidecar') return { cues: [], source: 'none' };
  if (config.asrMode === 'transformers' || (config.asrMode === 'auto' && config.transformersRuntime)) {
    return transcribeWithTransformers(mediaPath, durationSeconds, config, onProgress);
  }
  return { cues: [], source: 'none' };
}

export { parseCaptionText };
