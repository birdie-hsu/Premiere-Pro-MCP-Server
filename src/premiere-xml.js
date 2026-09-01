import { pathToFileURL } from 'node:url';

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function frameCount(seconds, fps) {
  return Math.max(0, Math.round(Number(seconds) * fps));
}

function rateBlock(timebase, ntsc) {
  return `<rate><timebase>${timebase}</timebase><ntsc>${ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
}

function sampleCharacteristics(metadata, timebase, ntsc) {
  const width = metadata.video?.width ?? 1920;
  const height = metadata.video?.height ?? 1080;
  return `<samplecharacteristics>${rateBlock(timebase, ntsc)}<width>${width}</width><height>${height}</height><pixelaspectratio>Square Pixels</pixelaspectratio><fielddominance>none</fielddominance><codec><name>H.264</name><appspecificdata><appname>Premiere Pro</appname><appmanufacturer>Adobe Systems Incorporated</appmanufacturer><appversion>1.0</appversion></appspecificdata></codec><colordepth>24</colordepth></samplecharacteristics>`;
}

function fileDefinition(mediaPath, metadata, mediaFrames, timebase, ntsc) {
  const url = escapeXml(pathToFileURL(mediaPath).href);
  const channels = metadata.audio?.channels ?? 2;
  const sampleRate = metadata.audio?.sampleRate ?? 48_000;
  return `<file id="file-1"><name>${escapeXml(mediaPath.split(/[/\\]/).pop())}</name><pathurl>${url}</pathurl><duration>${mediaFrames}</duration>${rateBlock(timebase, ntsc)}<timecode>${rateBlock(timebase, ntsc)}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode><media><video>${sampleCharacteristics(metadata, timebase, ntsc)}</video><audio><samplecharacteristics><depth>16</depth><samplerate>${sampleRate}</samplerate></samplecharacteristics><channelcount>${channels}</channelcount></audio></media></file>`;
}

function clipItem({ id, name, start, end, sourceIn, sourceOut, mediaType, fileMarkup, fileId = 'file-1', timebase, ntsc }) {
  return `<clipitem id="${escapeXml(id)}"><name>${escapeXml(name)}</name><enabled>TRUE</enabled><duration>${end - start}</duration>${rateBlock(timebase, ntsc)}<start>${start}</start><end>${end}</end><in>${sourceIn}</in><out>${sourceOut}</out>${mediaType === 'video' ? '<pixelaspectratio>Square Pixels</pixelaspectratio>' : ''}${fileMarkup ?? `<file id="${fileId}"/>`}</clipitem>`;
}

/** Build a conservative FCP 7 XML handoff that Premiere Pro can import. */
export function buildPremiereXml({ mediaPath, metadata, candidates, sequenceName = 'AI Highlight Reel' }) {
  const fps = metadata.video?.frameRate ?? 30;
  const timebase = Math.max(1, Math.round(fps));
  const ntsc = Math.abs(fps - timebase) > 0.01;
  const mediaFrames = frameCount(metadata.durationSeconds, fps);
  let cursor = 0;
  const videoClips = [];
  const audioClips = [];
  const markers = [];
  for (const candidate of candidates) {
    const sourceIn = Math.max(0, Math.min(mediaFrames, frameCount(candidate.startSeconds, fps)));
    const sourceOut = Math.max(sourceIn + 1, Math.min(mediaFrames, frameCount(candidate.endSeconds, fps)));
    const duration = sourceOut - sourceIn;
    const clipStart = cursor;
    const clipEnd = cursor + duration;
    const name = `${candidate.id ?? 'highlight'}${candidate.quote ? ` - ${candidate.quote.slice(0, 50)}` : ''}`;
    const fileMarkup = cursor === 0 ? fileDefinition(mediaPath, metadata, mediaFrames, timebase, ntsc) : undefined;
    videoClips.push(clipItem({ id: `video-${candidate.id ?? cursor}`, name, start: clipStart, end: clipEnd, sourceIn, sourceOut, mediaType: 'video', fileMarkup, timebase, ntsc }));
    audioClips.push(clipItem({ id: `audio-${candidate.id ?? cursor}`, name, start: clipStart, end: clipEnd, sourceIn, sourceOut, mediaType: 'audio', timebase, ntsc }));
    markers.push(`<marker><name>${escapeXml(candidate.id ?? 'highlight')}</name><in>${clipStart}</in><out>${clipEnd}</out><comment>${escapeXml((candidate.reasons ?? []).join('；'))}</comment></marker>`);
    cursor = clipEnd;
  }

  const dimensions = metadata.video?.width && metadata.video?.height
    ? `<width>${metadata.video.width}</width><height>${metadata.video.height}</height>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="5">
  <sequence id="highlight-sequence">
    <name>${escapeXml(sequenceName)}</name>
    <duration>${cursor}</duration>
    ${rateBlock(timebase, ntsc)}
    <media>
      <video>
        <format><samplecharacteristics>${rateBlock(timebase, ntsc)}${dimensions}<pixelaspectratio>Square Pixels</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>
        <track>${videoClips.join('')}</track>
      </video>
      <audio>
        <track>${audioClips.join('')}</track>
      </audio>
    </media>
    ${markers.join('')}
  </sequence>
</xmeml>
`;
}

export function buildPremierePlan({ mediaPath, metadata, analysisId, candidates, sequenceName }) {
  return {
    schema: 'premiere-highlight-plan/v1',
    analysisId,
    createdAt: new Date().toISOString(),
    sequenceName: sequenceName ?? 'AI Highlight Reel',
    source: {
      path: mediaPath,
      durationSeconds: metadata.durationSeconds,
      video: metadata.video,
      audio: metadata.audio,
    },
    clips: candidates.map((candidate, index) => ({
      order: index + 1,
      id: candidate.id,
      sourceInSeconds: candidate.startSeconds,
      sourceOutSeconds: candidate.endSeconds,
      durationSeconds: candidate.durationSeconds,
      score: candidate.score,
      quote: candidate.quote,
      reasons: candidate.reasons,
      evidence: candidate.evidence,
    })),
    importInstructions: [
      'Import the generated XML into Premiere Pro.',
      'If Premiere asks to locate the source media, choose the original local video.',
      'Review the marked clips before publishing; scores are heuristic and the original sequence is not modified.',
    ],
  };
}

export { escapeXml, frameCount };
