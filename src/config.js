import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

function expandHome(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~' + delimiter)) return join(homedir(), value.slice(2));
  if (value.startsWith('~\\') || value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

function absolute(value, name) {
  const expanded = expandHome(value);
  if (!isAbsolute(expanded)) {
    throw new Error(`${name} must be an absolute path: ${expanded}`);
  }
  return resolve(expanded);
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/**
 * Configuration is intentionally explicit. The server does not search the
 * whole machine for media and does not start a network listener.
 */
export function loadConfig(env = process.env, cwd = process.cwd()) {
  const projectRoot = absolute(env.HIGHLIGHT_PROJECT_ROOT ?? cwd, 'HIGHLIGHT_PROJECT_ROOT');
  const configuredRoots = env.HIGHLIGHT_ALLOWED_ROOTS
    ? env.HIGHLIGHT_ALLOWED_ROOTS.split(delimiter).map((value) => value.trim()).filter(Boolean)
    : [projectRoot];

  const allowedRoots = configuredRoots.map((value) => absolute(value, 'HIGHLIGHT_ALLOWED_ROOTS'));
  const cacheDir = absolute(
    env.HIGHLIGHT_CACHE_DIR ?? join(projectRoot, '.cache', 'highlight-mcp'),
    'HIGHLIGHT_CACHE_DIR',
  );
  const asrMode = env.HIGHLIGHT_ASR_MODE ?? 'auto';
  if (!['auto', 'sidecar', 'transformers', 'none'].includes(asrMode)) {
    throw new Error(`HIGHLIGHT_ASR_MODE must be auto, sidecar, transformers, or none; got ${asrMode}`);
  }

  return {
    projectRoot,
    allowedRoots,
    cacheDir,
    ffmpegBin: env.HIGHLIGHT_FFMPEG_BIN ?? 'ffmpeg',
    ffprobeBin: env.HIGHLIGHT_FFPROBE_BIN ?? 'ffprobe',
    sceneThreshold: positiveNumber(env.HIGHLIGHT_SCENE_THRESHOLD, 0.35),
    maxVideoBytes: positiveNumber(env.HIGHLIGHT_MAX_VIDEO_BYTES, 200 * 1024 * 1024 * 1024),
    maxDurationSeconds: positiveNumber(env.HIGHLIGHT_MAX_DURATION_SECONDS, 12 * 60 * 60),
    asrMode,
    asrModel: env.HIGHLIGHT_ASR_MODEL ?? 'Xenova/whisper-base.en',
    asrRevision: env.HIGHLIGHT_ASR_REVISION ?? '95bf40a508535962c6483ead40270b2e32267508',
    asrCacheDir: absolute(
      env.HIGHLIGHT_ASR_CACHE_DIR ?? join(cacheDir, 'transformers'),
      'HIGHLIGHT_ASR_CACHE_DIR',
    ),
    transformersRuntime: env.HIGHLIGHT_TRANSFORMERS_RUNTIME
      ? absolute(env.HIGHLIGHT_TRANSFORMERS_RUNTIME, 'HIGHLIGHT_TRANSFORMERS_RUNTIME')
      : null,
    maxCandidates: Math.min(100, Math.max(1, Math.floor(positiveNumber(env.HIGHLIGHT_MAX_CANDIDATES, 10)))),
  };
}

export const SERVER_NAME = 'premiere-highlight-mcp';
export const VERSION = '0.1.0';
