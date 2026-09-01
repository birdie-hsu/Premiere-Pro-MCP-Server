import { mkdir, writeFile, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { analyseVideo, publicAnalysis, readAnalysis } from './analysis.js';
import { extractFrame, probeMedia } from './ffmpeg.js';
import { buildPremierePlan, buildPremiereXml } from './premiere-xml.js';
import { assertAllowedDirectory, assertAllowedFile, assertSafeChildName } from './security.js';
import { SERVER_NAME, VERSION } from './config.js';

function ok(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }],
  };
}

function jobView(job, includeTranscript = false) {
  const view = {
    analysisId: job.analysisId,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
  if (job.status === 'completed' && job.result) view.result = publicAnalysis(job.result, includeTranscript);
  if (job.status === 'error') view.error = job.error;
  return view;
}

function timestamp() {
  return new Date().toISOString();
}

function startJob(args, config, state) {
  const analysisId = `analysis-${randomUUID()}`;
  const job = {
    analysisId,
    status: 'queued',
    progress: 0,
    stage: 'queued',
    createdAt: timestamp(),
    updatedAt: timestamp(),
    result: null,
    error: null,
  };
  state.jobs.set(analysisId, job);
  const run = state.queue.then(async () => {
    job.status = 'running';
    job.stage = 'starting';
    job.updatedAt = timestamp();
    try {
      job.result = await analyseVideo({ ...args, analysisId }, config, (progress, stage) => {
        job.progress = progress;
        job.stage = stage;
        job.updatedAt = timestamp();
      });
      job.status = 'completed';
      job.progress = 100;
      job.stage = 'complete';
    } catch (error) {
      job.status = 'error';
      job.error = error instanceof Error ? error.message : String(error);
      job.stage = 'error';
    }
    job.updatedAt = timestamp();
  });
  // Keep the serial queue alive after one failed job. The error is represented
  // in the job status and must not become an unhandled rejection.
  state.queue = run.catch(() => {});
  return job;
}

async function loadCompletedAnalysis(analysisId, config, state) {
  const job = state.jobs.get(analysisId);
  if (job?.status === 'completed' && job.result) return job.result;
  if (job?.status === 'running' || job?.status === 'queued') throw new Error(`Analysis is still ${job.status}: ${analysisId}`);
  return readAnalysis(analysisId, config);
}

async function writeExport(path, contents, overwrite) {
  if (!overwrite) {
    try {
      await access(path);
      throw new Error(`Refusing to overwrite existing file: ${path}. Set overwrite=true after reviewing it.`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  await writeFile(path, contents, { encoding: 'utf8', flag: overwrite ? 'w' : 'wx' });
}

export function buildServer(config, state = { jobs: new Map(), queue: Promise.resolve() }) {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION }, {
    instructions: 'Local-only livestream highlight workflow. Analyze only allowlisted local files, return timestamped candidates with evidence, and wait for explicit review before exporting. export_premiere_plan creates non-destructive JSON/FCP XML files; it never changes Premiere and never uses UXP or a network listener.',
  });

  server.registerTool('server_info', {
    description: 'Show the local-only Highlight MCP configuration and available workflow stages.',
    inputSchema: {},
  }, async () => ok({
    server: SERVER_NAME,
    version: VERSION,
    localOnly: true,
    uxp: false,
    networkListener: false,
    allowedRoots: config.allowedRoots,
    cacheDir: config.cacheDir,
    asr: {
      mode: config.asrMode,
      model: config.asrModel,
      localRuntimeConfigured: Boolean(config.transformersRuntime),
    },
    scoring: {
      enabledSignals: ['transcript', 'audio_relative_burst', 'scene_boundary', ...(config.motionEnabled ? ['motion_low_weight'] : [])],
      motionEnabled: config.motionEnabled,
      motionSampleRate: config.motionSampleRate,
    },
    workflow: ['analyze_video', 'get_analysis_status', 'export_premiere_plan', 'get_frame'],
  }));

  server.registerTool('analyze_video', {
    description: 'Queue a local video analysis. It combines local transcript/ASR, relative audio bursts, scene boundaries, and optional low-weight frame-difference motion to rank timestamped highlight candidates with evidence. It never changes Premiere.',
    inputSchema: {
      video_path: z.string().describe('Absolute local path to the source video.'),
      clip_length_seconds: z.number().int().min(10).max(600).default(45).describe('Target duration for each highlight clip.'),
      max_candidates: z.number().int().min(1).max(100).default(10).describe('Maximum ranked candidates to return.'),
      style: z.string().max(200).default('').describe('Optional style such as gaming, reaction, comedy, or debate.'),
      keywords: z.array(z.string().min(1).max(80)).max(20).default([]).describe('Optional words or phrases that should raise a candidate score.'),
    },
  }, async ({ video_path, clip_length_seconds, max_candidates, style, keywords }) => {
    try {
      await assertAllowedFile(video_path, config, { extensions: ['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi', '.ts', '.mts', '.m2ts', '.wmv', '.flv'] });
      const job = startJob({ videoPath: video_path, clipLengthSeconds: clip_length_seconds, maxCandidates: max_candidates, style, keywords }, config, state);
      return ok({ ...jobView(job), message: 'Analysis queued. Poll get_analysis_status with this analysisId before exporting.' });
    } catch (error) {
      return fail(error);
    }
  });

  server.registerTool('get_analysis_status', {
    description: 'Poll a queued or completed highlight analysis. Completed results include candidate timestamps, scores, reasons, and signal evidence.',
    inputSchema: {
      analysis_id: z.string().min(10),
      include_transcript: z.boolean().default(false).describe('Include all local transcript cues in the response; leave false for a compact response.'),
    },
  }, async ({ analysis_id, include_transcript }) => {
    try {
      const job = state.jobs.get(analysis_id);
      if (job) return ok(jobView(job, include_transcript));
      const result = await readAnalysis(analysis_id, config);
      return ok({ analysisId: analysis_id, status: 'completed', progress: 100, stage: 'complete', result: publicAnalysis(result, include_transcript) });
    } catch (error) {
      return fail(error);
    }
  });

  server.registerTool('export_premiere_plan', {
    description: 'Write a non-destructive JSON edit plan and optional FCP 7 XML handoff for Premiere Pro. It does not connect to or modify Premiere and refuses to overwrite files unless overwrite=true.',
    inputSchema: {
      analysis_id: z.string().min(10),
      candidate_ids: z.array(z.string().min(1)).max(100).default([]).describe('Candidate IDs to export; empty exports all ranked candidates.'),
      output_dir: z.string().optional().describe('Absolute allowlisted output directory. Defaults to the project exports folder.'),
      name: z.string().min(1).max(120).default('highlight-reel').describe('Base filename without extension.'),
      sequence_name: z.string().min(1).max(120).default('AI Highlight Reel'),
      include_xml: z.boolean().default(true),
      overwrite: z.boolean().default(false),
    },
  }, async ({ analysis_id, candidate_ids, output_dir, name, sequence_name, include_xml, overwrite }) => {
    try {
      const result = await loadCompletedAnalysis(analysis_id, config, state);
      const candidates = candidate_ids.length
        ? candidate_ids.map((id) => result.candidates.find((candidate) => candidate.id === id)).filter(Boolean)
        : result.candidates;
      if (!candidates.length) throw new Error('No matching candidates to export.');
      if (candidate_ids.length && candidates.length !== candidate_ids.length) throw new Error('One or more candidate_ids were not found in the analysis.');
      const directory = await assertAllowedDirectory(output_dir ?? join(config.projectRoot, 'exports'), config, { create: true });
      const safeName = assertSafeChildName(name, 'name');
      const plan = buildPremierePlan({ mediaPath: result.source.path, metadata: result.metadata, analysisId: result.analysisId, candidates, sequenceName: sequence_name });
      const jsonPath = join(directory, `${safeName}.highlight-plan.json`);
      await writeExport(jsonPath, JSON.stringify(plan, null, 2), overwrite);
      const files = { json: jsonPath };
      if (include_xml) {
        const xmlPath = join(directory, `${safeName}.xml`);
        const xml = buildPremiereXml({ mediaPath: result.source.path, metadata: result.metadata, candidates, sequenceName: sequence_name });
        await writeExport(xmlPath, xml, overwrite);
        files.xml = xmlPath;
      }
      return ok({ analysisId, files, candidateCount: candidates.length, nonDestructive: true, premiereAction: 'import_xml_or_execute_plan_after_review' });
    } catch (error) {
      return fail(error);
    }
  });

  server.registerTool('get_frame', {
    description: 'Extract a small local JPEG preview at a timestamp for visual verification of a candidate.',
    inputSchema: {
      video_path: z.string(),
      seconds: z.number().min(0),
    },
  }, async ({ video_path, seconds }) => {
    try {
      const source = await assertAllowedFile(video_path, config, { extensions: ['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi', '.ts', '.mts', '.m2ts', '.wmv', '.flv'] });
      const metadata = await probeMedia(source.path, config);
      if (seconds > metadata.durationSeconds) throw new Error(`seconds is outside the video duration (${metadata.durationSeconds.toFixed(2)} seconds).`);
      const frameDir = join(config.cacheDir, 'frames');
      await mkdir(frameDir, { recursive: true });
      const framePath = join(frameDir, `${randomUUID()}.jpg`);
      const frame = await extractFrame(source.path, seconds, framePath, config);
      const payload = { videoPath: source.path, seconds: frame.seconds, framePath, mimeType: frame.mimeType };
      return {
        content: [
          { type: 'text', text: JSON.stringify(payload, null, 2) },
          { type: 'image', data: frame.data.toString('base64'), mimeType: frame.mimeType },
        ],
        structuredContent: payload,
      };
    } catch (error) {
      return fail(error);
    }
  });

  return server;
}
