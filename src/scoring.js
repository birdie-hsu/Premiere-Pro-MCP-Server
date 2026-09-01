const BASE_TERMS = [
  ['no way', 2.2], ['oh my god', 2.2], ['omg', 2.2], ['wow', 1.8], ['wait', 1.3],
  ['what', 1.0], ['why', 0.8], ['look', 0.9], ['watch this', 1.8], ['insane', 2.0],
  ['crazy', 1.6], ['unbelievable', 2.0], ['finally', 1.3], ['let\'s go', 1.9],
  ['clutch', 2.0], ['headshot', 1.7], ['victory', 1.2], ['win', 1.0], ['won', 1.0],
  ['fail', 1.0], ['oops', 1.2], ['haha', 1.1], ['laugh', 1.1],
  ['天啊', 2.1], ['不可能', 2.2], ['太扯', 1.8], ['笑死', 1.7], ['真的假的', 1.8],
  ['好扯', 1.7], ['逆轉', 2.0], ['絕殺', 2.0], ['贏了', 1.2], ['哇', 1.5], ['等等', 1.1],
];

const STYLE_TERMS = {
  gaming: [['kill', 1.5], ['play', 0.6], ['rank', 0.8], ['boss', 0.8], ['combo', 1.1], ['連殺', 1.8], ['遊戲', 0.6]],
  reaction: [['react', 1.3], ['reaction', 1.5], ['真的嗎', 1.4], ['真的假的', 1.8]],
  comedy: [['joke', 1.2], ['funny', 1.3], ['笑', 1.4], ['搞笑', 1.5], ['哈哈', 1.5]],
  debate: [['agree', 0.8], ['disagree', 1.0], ['actually', 0.7], ['重點', 1.0], ['問題是', 1.0]],
};

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

function textUnits(text) {
  const words = text.match(/[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
  const cjk = text.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  return words + cjk;
}

function termsFor(style, keywords) {
  const terms = [...BASE_TERMS];
  const styleKey = String(style ?? '').toLowerCase();
  for (const [key, values] of Object.entries(STYLE_TERMS)) {
    if (styleKey.includes(key)) terms.push(...values);
  }
  for (const keyword of keywords ?? []) {
    if (typeof keyword === 'string' && keyword.trim()) terms.push([keyword.trim(), 1.7]);
  }
  return terms;
}

function excitementScore(text, style, keywords) {
  if (!text) return { score: 0, matches: [] };
  const lower = text.toLowerCase();
  let total = 0;
  const matches = [];
  for (const [term, weight] of termsFor(style, keywords)) {
    if (lower.includes(term.toLowerCase())) {
      total += weight;
      matches.push(term);
    }
  }
  const exclamations = (text.match(/[!！?？]+/g) ?? []).join('').length;
  total += Math.min(2, exclamations * 0.15);
  return { score: clamp(total / 5), matches: [...new Set(matches)].slice(0, 6) };
}

function overlapSeconds(cue, start, end) {
  return Math.max(0, Math.min(cue.endSeconds, end) - Math.max(cue.startSeconds, start));
}

function metricStats(metrics, start, end, baseline, upper) {
  const selected = metrics.filter((metric) => metric.startSeconds < end && metric.startSeconds + metric.durationSeconds > start);
  if (!selected.length) return { energy: 0, peak: 0, averageRms: 0, selected: [] };
  const averageRms = selected.reduce((sum, metric) => sum + metric.rms, 0) / selected.length;
  const peak = Math.max(...selected.map((metric) => metric.peak));
  const averageEnergy = clamp((averageRms - baseline) / Math.max(upper - baseline, 1e-5));
  const peakEnergy = clamp((peak - baseline) / Math.max(upper - baseline, 1e-5));
  return { energy: clamp(averageEnergy * 0.65 + peakEnergy * 0.35), peak: peakEnergy, averageRms, selected };
}

function windowStats(start, end, metrics, scenes, cues, style, keywords, audioBaseline, audioUpper) {
  const duration = Math.max(end - start, 0.001);
  const transcriptCues = cues.filter((cue) => cue.startSeconds < end && cue.endSeconds > start);
  const quote = transcriptCues.map((cue) => cue.text).join(' ').replace(/\s+/g, ' ').trim();
  const words = textUnits(quote);
  const speechSeconds = transcriptCues.reduce((sum, cue) => sum + overlapSeconds(cue, start, end), 0);
  const speechDensity = clamp(speechSeconds / duration);
  const speakingRate = clamp(words / Math.max(duration * 2.4, 1));
  const excitement = excitementScore(quote, style, keywords);
  const punctuation = clamp(((quote.match(/[!！?？]/g) ?? []).length / Math.max(words, 1)) * 2.5);
  const audio = metricStats(metrics, start, end, audioBaseline, audioUpper);
  const sceneCount = scenes.filter((time) => time >= start && time <= end).length;
  const sceneScore = clamp(sceneCount / 3);
  const hasTranscript = cues.length > 0;
  const score = hasTranscript
    ? 100 * (audio.energy * 0.30 + excitement.score * 0.34 + speechDensity * 0.16 + speakingRate * 0.08 + sceneScore * 0.07 + punctuation * 0.05)
    : 100 * (audio.energy * 0.62 + sceneScore * 0.23 + punctuation * 0.15);
  const reasons = [];
  if (audio.energy >= 0.55) reasons.push(`音訊能量高於片段基線（${Math.round(audio.energy * 100)}%）`);
  if (excitement.matches.length) reasons.push(`字幕出現 ${excitement.matches.slice(0, 3).join('、')}`);
  if (speechDensity >= 0.65) reasons.push('說話覆蓋率高');
  if (speakingRate >= 0.65) reasons.push('語句密度高');
  if (sceneCount) reasons.push(`偵測到 ${sceneCount} 個畫面切換`);
  if (punctuation >= 0.45) reasons.push('字幕有明顯驚嘆或提問');
  if (!hasTranscript) reasons.push('未取得字幕；此候選主要依音訊與畫面切換評分');
  return {
    score: Math.round(Math.max(0, Math.min(100, score)) * 10) / 10,
    quote: quote ? quote.slice(0, 240) : null,
    reasons: reasons.length ? reasons : ['符合目前的候選時間窗'],
    evidence: {
      audioEnergy: Math.round(audio.energy * 100) / 100,
      audioPeak: Math.round(audio.peak * 100) / 100,
      speechDensity: Math.round(speechDensity * 100) / 100,
      speakingRate: Math.round(speakingRate * 100) / 100,
      excitement: Math.round(excitement.score * 100) / 100,
      sceneChanges: sceneCount,
      punctuation: Math.round(punctuation * 100) / 100,
    },
  };
}

function overlapRatio(left, right) {
  const overlap = Math.max(0, Math.min(left.endSeconds, right.endSeconds) - Math.max(left.startSeconds, right.startSeconds));
  return overlap / Math.min(left.endSeconds - left.startSeconds, right.endSeconds - right.startSeconds);
}

/**
 * Rank windows using transparent local signals. This is intentionally not a
 * black-box claim of semantic truth: every score is returned with evidence.
 */
export function rankHighlights({ durationSeconds, metrics = [], scenes = [], cues = [], style = '', keywords = [], clipLengthSeconds = 45, maxCandidates = 10 }) {
  const length = Math.min(Math.max(Number(clipLengthSeconds) || 45, 10), Math.max(10, durationSeconds));
  const baseline = quantile(metrics.map((metric) => metric.rms), 0.5);
  const upper = Math.max(quantile(metrics.map((metric) => metric.rms), 0.95), baseline + 1e-5);
  const starts = new Set();
  const addStart = (value) => {
    const start = Math.max(0, Math.min(Math.max(0, durationSeconds - length), Number(value) || 0));
    starts.add(Math.round(start * 2) / 2);
  };

  if (durationSeconds <= length + 0.01) addStart(0);
  const peakMetrics = [...metrics]
    .sort((left, right) => (right.rms + right.peak * 0.35) - (left.rms + left.peak * 0.35))
    .slice(0, 80);
  for (const metric of peakMetrics) addStart(metric.startSeconds - length * 0.38);
  for (const cue of cues) addStart(cue.startSeconds - length * 0.12);
  for (const scene of scenes.slice(0, 500)) addStart(scene - length * 0.3);

  const gridStep = Math.max(5, Math.min(30, length / 2));
  for (let start = 0; start <= durationSeconds - length + 0.01; start += gridStep) addStart(start);
  if (!starts.size) addStart(0);

  const ranked = [...starts].map((start) => {
    const end = Math.min(durationSeconds, start + length);
    const stats = windowStats(start, end, metrics, scenes, cues, style, keywords, baseline, upper);
    return {
      startSeconds: Math.round(start * 1000) / 1000,
      endSeconds: Math.round(end * 1000) / 1000,
      durationSeconds: Math.round((end - start) * 1000) / 1000,
      ...stats,
    };
  }).sort((left, right) => right.score - left.score);

  const selected = [];
  for (const candidate of ranked) {
    if (selected.some((existing) => overlapRatio(existing, candidate) > 0.65)) continue;
    selected.push(candidate);
    if (selected.length >= Math.min(100, Math.max(1, maxCandidates))) break;
  }
  return selected.map((candidate, index) => ({
    id: `highlight-${String(index + 1).padStart(3, '0')}`,
    ...candidate,
  }));
}

export { clamp, excitementScore, textUnits };
