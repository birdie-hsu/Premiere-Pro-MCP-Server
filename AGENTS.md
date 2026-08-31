# Local livestream highlight workflow

Use the project-scoped `video_context` MCP for local video analysis and the `premiere_cep` MCP for Premiere Pro actions. Do not use UXP or any cloud video service.

## Safety and workflow

1. Ask for the absolute local video path and the desired highlight style/length when they are not already provided.
2. Ingest the source with `video_context`, wait for analysis completion, and use its transcript, timeline, semantic search, keyframes, OCR, and scene information to propose timestamped candidates.
3. Return candidates with start/end time, duration, score, reason, and a short quote or visual cue. Do not modify Premiere during this analysis phase.
4. Only after explicit approval, verify the Premiere CEP connection, preserve the original sequence, and create a duplicate or new highlight sequence before making edits.
5. Use `premiere_cep` for media import, timeline assembly, trimming, captions, reframing, and export. Never invoke UXP tools or raw ExtendScript unless the user explicitly requests that advanced operation.

Keep all source media and analysis artifacts local. Prefer non-destructive edits and ask before overwriting an existing project, sequence, or export file.
