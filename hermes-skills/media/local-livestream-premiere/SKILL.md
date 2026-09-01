---
name: local-livestream-premiere
description: Analyze local livestreams with ASR-first evidence, select viral or product highlights, and assemble non-destructive Adobe Premiere Pro sequences through local CEP MCP servers; never use UXP or cloud services.
metadata:
  hermes:
    category: media
    tags: [video, livestream, ASR, highlight, viral-cut, premiere-pro, MCP]
---

# Local Livestream → Highlight → Premiere Pro

Use this skill when the user wants a local livestream searched for product information, viral moments, gaming highlights, reactions, or other short clips, and wants the result assembled in Adobe Premiere Pro.

## Hard boundaries

- Work only on an absolute local video path supplied by the user or already in the configured allowlist.
- Use local `video_context` for transcript/timeline/search work and local `premiere_cep` for Premiere operations. Use `highlight_local` as the local heuristic fallback or for JSON/FCP7 handoff files.
- Never use UXP, raw ExtendScript, a cloud video service, or a network listener as a fallback.
- Analysis and editing are separate phases. During analysis, do not change Premiere. Present timestamped candidates first and wait for the user to approve candidate IDs or ranges before creating/editing a sequence.
- Preserve the source sequence. After approval, duplicate an existing sequence or create a new one; do not clear, delete, or overwrite the original sequence.
- Saving the current `.prproj` overwrites the existing project file. Ask for explicit approval immediately before `save_project`; prefer Save As when the user gives a new path.
- Do not overwrite an existing export or plan file unless the user explicitly requests it.

## Default local scoring profile

- Keep transcript/ASR as the primary semantic signal. Preserve cue timestamps, short quotes, speech coverage, speaking rate, excitement terms, and punctuation evidence; treat noisy ASR as an approximation.
- Enable the first three visual/audio signals by default: scene boundaries, low-weight motion, and relative audio bursts. Scene boundaries prefer clean clip edges; motion is a weak frame-difference signal rather than proof of an action; audio bursts are measured against the video's local baseline rather than a fixed dB threshold.
- Score these signals in one-second evidence bins and return per-candidate evidence. A signal timeline is kept as a local analysis artifact for re-ranking and debugging; candidates remain the review-facing output.
- Use scene boundaries for trimming and candidate generation, not as a standalone claim that a moment is interesting. Avoid double-counting correlated audio peak and loudness signals.
- Objects and actions remain opt-in, label-driven detectors. Do not enable them merely because a model is available.

See [references/scoring-profile.md](references/scoring-profile.md) for the signal schema and weighting policy.

## MCP tool map

Hermes registers MCP tools as `mcp_<server_name>_<tool_name>`. The expected servers are:

- `video_context`: `list_videos`, `ingest_video`, `get_ingest_status`, `get_video_timeline`, `search_videos`, `get_transcript`, and optionally `peek_frame`.
- `highlight_local`: `server_info`, `analyze_video`, `get_analysis_status`, `get_frame`, and optionally `export_premiere_plan`.
- `premiere_cep`: `verify_premiere_connection`, `import_media`, `duplicate_sequence`, `add_to_timeline_batch`, `add_marker`, `set_active_sequence`, `list_sequence_tracks`, `validate_project_for_export`, plus `save_project`/export tools only when the user asks to persist or render.

If a tool is not exposed, report the missing server/tool and continue only with a safe, clearly labeled fallback. Do not replace CEP with UXP.

## Default runbook

1. Confirm the absolute local video path and the requested cut style/length. If either materially changes the result and cannot be inferred, ask before analysis.
2. Follow [references/operational-playbook.md](references/operational-playbook.md) for the low-token ASR search, candidate scoring, review gate, and Premiere assembly.
3. For Hermes setup or missing tools, read [references/mcp-setup-windows.md](references/mcp-setup-windows.md). Merge its MCP block into the existing Hermes config; never replace the whole config.
4. Return an analysis table containing ID, source start/end, duration, score, reason, short quote or visual cue, and evidence limitations. Include transcript, audio burst, scene boundary, and motion evidence when available.
5. Stop after the candidate table until the user approves. “Analyze” alone is not permission to mutate Premiere; “use candidates V-02, V-05” or an equivalent explicit instruction is.
6. After approval, verify CEP, assemble the approved ranges in a new/duplicated sequence, add navigation markers, set the new sequence active, and verify tracks, gaps, offline media, and duration.
7. Report what was changed, what remains unsaved/unexported, and the exact next approval needed.

## Token-saving defaults

- Reuse an indexed `video_id` when the local path matches.
- For a long video, ingest with `visual=false`, `embed=false`, and `whisper_fallback=true` first. This provides fast transcript search without building a large keyframe/OCR index.
- Use `get_video_timeline` once, then run several short one- or two-term `search_videos` queries with a small limit and merge hits by timestamp. When semantic search is unavailable, compound queries can return no matches.
- Slice `get_transcript` around promising hits instead of requesting the full transcript.
- Only inspect frames for the final shortlist. If the index has no keyframes, use `highlight_local.get_frame` for a few timestamps or state that the score is transcript/audio-based.

## Completion criteria

A task is complete only when the approved clips are in the requested new sequence and a read-only verification reports the expected clip counts, linked audio, no blocking gaps/offline media, and the actual duration. Do not claim that an MP4 or `.prproj` was saved unless the relevant operation succeeded.
