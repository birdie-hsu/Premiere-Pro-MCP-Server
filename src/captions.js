import { access, readFile } from 'node:fs/promises';
import { dirname, extname, join, parse } from 'node:path';
import { assertAllowedFile } from './security.js';

function parseTimestamp(value) {
  const normalized = value.trim().replace(',', '.');
  const parts = normalized.split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 3) return parts[0] * 3_600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

function cleanText(lines) {
  return lines
    .join(' ')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseCaptionText(raw, sourcePath = null) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '').replace(/\r/g, '');
  const blocks = text.split(/\n\s*\n/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0) continue;
    const [startRaw, endRawWithSettings] = lines[timingIndex].split('-->');
    const endRaw = endRawWithSettings.trim().split(/\s+/)[0];
    const startSeconds = parseTimestamp(startRaw);
    const endSeconds = parseTimestamp(endRaw);
    const cueText = cleanText(lines.slice(timingIndex + 1));
    if (startSeconds === null || endSeconds === null || endSeconds <= startSeconds || !cueText) continue;
    cues.push({ startSeconds, endSeconds, text: cueText, source: sourcePath });
  }
  return cues.sort((left, right) => left.startSeconds - right.startSeconds);
}

export async function findSidecar(mediaPath, config = null) {
  const parsed = parse(mediaPath);
  const base = join(dirname(mediaPath), parsed.name);
  const candidates = [
    `${base}.vtt`,
    `${base}.srt`,
    `${mediaPath}.vtt`,
    `${mediaPath}.srt`,
  ];
  for (const candidate of candidates) {
    try {
      const safeCandidate = config
        ? (await assertAllowedFile(candidate, config, { extensions: ['.vtt', '.srt'] })).path
        : candidate;
      await access(safeCandidate);
      const raw = await readFile(safeCandidate, 'utf8');
      const cues = parseCaptionText(raw, safeCandidate);
      if (cues.length) return { path: safeCandidate, format: extname(safeCandidate).slice(1).toLowerCase(), cues };
    } catch {
      // Missing or invalid sidecars are not fatal; ASR can be tried next.
    }
  }
  return null;
}

export function cuesToVtt(cues) {
  const time = (seconds) => {
    const milliseconds = Math.max(0, Math.round(seconds * 1_000));
    const hours = Math.floor(milliseconds / 3_600_000);
    const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
    const secondsPart = Math.floor((milliseconds % 60_000) / 1_000);
    const millis = milliseconds % 1_000;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secondsPart).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
  };
  return `WEBVTT\n\n${cues.map((cue, index) => `${index + 1}\n${time(cue.startSeconds)} --> ${time(cue.endSeconds)}\n${cue.text}`).join('\n\n')}\n`;
}
