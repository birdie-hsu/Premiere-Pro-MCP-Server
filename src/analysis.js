import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { findSidecar } from './captions.js';
import { detectScenes, probeMedia, readAudioMetrics } from './ffmpeg.js';
import { rankHighlights } from './scoring.js';
import { getTranscript } from './transcribe.js';
import { assertAllowedFile } from './security.js';

export const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi', '.ts', '.mts', '.m2ts', '.wmv', '.flv'];

function shortError(error) {
  return error instanceof Error ? error.message.slice(0, 600) : String(error).slice(0, 600);
}

export async function analyseVideo({
  analysisId = `analysis-${randomUUID()}`,
  videoPath,
  clipLengthSeconds = 45,
  maxCandidates = 10,
  style = '',
  keywords = [],
}, config, onProgress) {
  const warnings = [];
  onProgress?.(2, 'validating local video path');
  const source = await assertAllowedFile(videoPath, config, { extensions: VIDEO_EXTENSIONS });
  const workDir = join(config.cacheDir, 'analyses', analysisId);
  await mkdir(workDir, { recursive: true });
  const resultPath = join(workDir, 'analysis.json');
  try {
    onProgress?.(8, 'reading media metadata');
    const metadata = await probeMedia(source.path, config);
    if (metadata.durationSeconds > config.maxDurationSeconds) {
      throw new Error(`Video duration exceeds the configured limit (${config.maxDurationSeconds} seconds).`);
    }

    onProgress?.(12, 'checking local subtitle sidecars');
    const sidecar = await findSidecar(source.path, config);
    let metrics = [];
    if (metadata.audio) {
      try {
        metrics = await readAudioMetrics(source.path, metadata.durationSeconds, join(workDir, 'audio.pcm'), config, onProgress);
      } catch (error) {
        warnings.push(`audio analysis unavailable: ${shortError(error)}`);
      }
    } else {
      warnings.push('the source has no audio stream; audio energy and ASR signals are unavailable');
    }

    const scenes = await detectScenes(source.path, metadata.durationSeconds, config.sceneThreshold, config, onProgress);
    let transcript = { cues: [], source: 'none' };
    try {
      transcript = await getTranscript(source.path, metadata.durationSeconds, sidecar, config, onProgress);
    } catch (error) {
      warnings.push(`transcription unavailable: ${shortError(error)}`);
    }

    onProgress?.(97, 'ranking highlight candidates');
    const candidates = rankHighlights({
      durationSeconds: metadata.durationSeconds,
      metrics,
      scenes,
      cues: transcript.cues,
      style,
      keywords,
      clipLengthSeconds,
      maxCandidates: Math.min(maxCandidates, config.maxCandidates),
    });

    const result = {
      schema: 'premiere-highlight-analysis/v1',
      analysisId,
      createdAt: new Date().toISOString(),
      engine: {
        name: 'premiere-highlight-mcp',
        version: '0.1.0',
        scoring: 'transparent-heuristic-v1',
      },
      source: {
        path: source.path,
        sizeBytes: source.info.size,
        modifiedAt: source.info.mtime.toISOString(),
      },
      metadata,
      parameters: {
        clipLengthSeconds,
        maxCandidates,
        style,
        keywords,
        sceneThreshold: config.sceneThreshold,
      },
      transcript: {
        source: transcript.source,
        path: transcript.path ?? null,
        model: transcript.model ?? null,
        cueCount: transcript.cues.length,
        cues: transcript.cues,
      },
      signals: {
        audioBucketCount: metrics.length,
        sceneChangeCount: scenes.length,
        sceneChangeSeconds: scenes,
      },
      candidates,
      warnings,
      artifacts: { analysisJson: resultPath },
    };
    await writeFile(resultPath, JSON.stringify(result, null, 2), 'utf8');
    onProgress?.(100, 'analysis complete');
    return result;
  } finally {
    await rm(join(workDir, 'audio.pcm'), { force: true }).catch(() => {});
  }
}

export async function readAnalysis(analysisId, config) {
  const safeId = String(analysisId);
  if (!/^analysis-[a-f0-9-]+$/i.test(safeId)) throw new Error(`Invalid analysis_id: ${safeId}`);
  const path = join(config.cacheDir, 'analyses', safeId, 'analysis.json');
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error(`Analysis not found: ${safeId}`);
  }
}

export function publicAnalysis(result, includeTranscript = false) {
  const { transcript, ...rest } = result;
  return {
    ...rest,
    transcript: includeTranscript
      ? transcript
      : { source: transcript.source, path: transcript.path, model: transcript.model, cueCount: transcript.cueCount },
  };
}
