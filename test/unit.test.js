import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCaptionText } from '../src/captions.js';
import { buildPremierePlan, buildPremiereXml } from '../src/premiere-xml.js';
import { rankHighlights } from '../src/scoring.js';
import { isWithin } from '../src/security.js';

test('parses SRT and VTT-style timestamps, including CJK captions', () => {
  const cues = parseCaptionText(`1\n00:00:10,250 --> 00:00:12,500\n等等！\n\n2\n00:01:00.000 --> 00:01:03.000\nNo way!`);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].startSeconds, 10.25);
  assert.equal(cues[0].text, '等等！');
  assert.equal(cues[1].endSeconds, 63);
});

test('ranks an audio/transcript burst above quiet windows', () => {
  const metrics = Array.from({ length: 120 }, (_, index) => ({
    startSeconds: index,
    durationSeconds: 1,
    rms: index >= 55 && index < 75 ? 0.8 : 0.12,
    peak: index >= 55 && index < 75 ? 1 : 0.2,
  }));
  const cues = [
    { startSeconds: 58, endSeconds: 61, text: 'WAIT! NO WAY! That was completely insane!' },
    { startSeconds: 64, endSeconds: 68, text: "Let's go, we finally won!" },
  ];
  const candidates = rankHighlights({
    durationSeconds: 120,
    metrics,
    scenes: [60, 70],
    cues,
    style: 'gaming',
    clipLengthSeconds: 20,
    maxCandidates: 3,
  });
  assert.equal(candidates.length, 3);
  assert.ok(candidates[0].startSeconds <= 60);
  assert.ok(candidates[0].endSeconds >= 68);
  assert.ok(candidates[0].score > 40);
  assert.ok(candidates[0].reasons.length > 0);
  assert.ok(candidates[0].evidence.excitement > 0);
});

test('allowlist containment rejects traversal outside the root', () => {
  const root = 'C:\\work\\premiere-highlight';
  assert.equal(isWithin(root, 'C:\\work\\premiere-highlight\\media\\clip.mp4'), true);
  assert.equal(isWithin(root, 'C:\\work\\premiere-highlight\\media\\..\\..\\secret.mp4'), false);
});

test('builds an escaped Premiere XML handoff and JSON plan', () => {
  const metadata = {
    durationSeconds: 120,
    video: { width: 1920, height: 1080, frameRate: 29.97 },
    audio: { channels: 2, sampleRate: 48_000 },
  };
  const candidates = [{
    id: 'highlight-001',
    startSeconds: 10,
    endSeconds: 30,
    durationSeconds: 20,
    score: 82.5,
    quote: 'No way & wow',
    reasons: ['audio peak'],
    evidence: { audioEnergy: 0.9 },
  }];
  const xml = buildPremiereXml({ mediaPath: 'C:\\work\\premiere-highlight\\media\\clip one.mp4', metadata, candidates, sequenceName: 'Test & Reel' });
  assert.match(xml, /<xmeml version="5">/);
  assert.match(xml, /Test &amp; Reel/);
  assert.match(xml, /No way &amp; wow/);
  assert.match(xml, /<pathurl>file:\/\/\//);
  const plan = buildPremierePlan({ mediaPath: 'C:\\work\\premiere-highlight\\media\\clip one.mp4', metadata, analysisId: 'analysis-test', candidates });
  assert.equal(plan.clips[0].sourceInSeconds, 10);
  assert.equal(plan.schema, 'premiere-highlight-plan/v1');
});
