---
name: local-livestream-premiere
description: Set up and operate three local MCP servers to analyze livestreams with ASR-first evidence, review highlights, and assemble non-destructive Adobe Premiere Pro sequences through a verified CEP bridge; never use UXP or cloud video services.
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

## Environment bootstrap (read this section before using the workflow)

For a brand-new Windows machine, read [references/mcp-setup-windows.md](references/mcp-setup-windows.md) first. It covers one-time host provisioning, skill discovery, MCP config generation, verification, and the boundary between setup and the daily editing workflow.

This skill is intended to be sufficient to configure the local environment. The canonical Hermes configuration for this repository is the project-scoped `<REPO_ROOT>\.codex\config.toml` in TOML format. Do not create a YAML `config.yaml` for this project and do not assume that merely listing the three server names registers them.

When any server is missing or the project has not been set up, resolve:

- `<REPO_ROOT>`: the folder containing `package.json` and `src\index.js`;
- `<VIDEO_ROOT>`: the user's absolute local video folder;
- `<HERMES_ROOT>`: normally `%LOCALAPPDATA%\hermes`;
- local tools: `<REPO_ROOT>\tools\bin\ffmpeg.exe`, `ffprobe.exe`, and `yt-dlp.exe`.

First trust the repository so Hermes loads this project-local copy instead of a stale user-level skill, then run the bootstrap script with the user's actual video folder. Preview before applying:

```powershell
Set-Location -LiteralPath "<REPO_ROOT>"
hermes skills trust "<REPO_ROOT>"
$Bootstrap = "<REPO_ROOT>\.agents\skills\local-livestream-premiere\scripts\ensure-hermes-config.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap -RepoRoot "<REPO_ROOT>" -VideoRoot "<VIDEO_ROOT>"
powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap -RepoRoot "<REPO_ROOT>" -VideoRoot "<VIDEO_ROOT>" -Apply
```

The script validates the Hermes Node runtime, the three local entrypoints, and the local FFmpeg/FFprobe/yt-dlp tools; writes/merges `<REPO_ROOT>\.codex\config.toml`, preserves unrelated settings, and backs up an existing project config before applying the managed server block. It registers the following servers:

| Server | Local entrypoint | Purpose |
|---|---|---|
| `video_context` | Hermes Node + `@smallthinkingmachines\video-context-mcp\dist\index.js` | transcript, timeline, search, keyframes/OCR; local FFmpeg/FFprobe/yt-dlp |
| `highlight_local` | `<REPO_ROOT>\src\index.js` | local audio/scene/motion/transcript scoring and JSON/FCP7 handoff |
| `premiere_cep` | Hermes Node + `adobe-premiere-pro-mcp\dist\index.js` | Premiere CEP connection and non-destructive assembly |

Only use `-Apply` when the user has requested environment setup or explicitly approved writing the project config. For an analysis-only request, run the script in preview mode or report the missing setup instead.

The generated environment also points both analysis servers at the local FFmpeg/FFprobe binaries, local cache directories, and the bundled Transformers runtime. `<VIDEO_ROOT>` is added to `HIGHLIGHT_ALLOWED_ROOTS`; never widen the allowlist to the whole machine. Do not commit the generated `.codex` config, cache, media, or user-specific paths.

The bootstrap defaults to the English `Xenova/whisper-base.en` model. For multilingual or non-English media, pass an appropriate `-AsrModel` in both preview and apply so `video_context` and `highlight_local` stay aligned.

If the Premiere CEP extension is missing, read the setup reference and—only when environment setup was requested or approved—run the same command with `-Apply -InstallPremiereCep`. This uses the installed Premiere MCP package's official Windows installer, backs up an existing `MCPBridgeCEP`, and does not write VS Code or Claude Desktop MCP configs.

After applying the config, start a fresh Hermes session and verify all three server processes:

```powershell
hermes mcp list
hermes mcp test video_context
hermes mcp test highlight_local
hermes mcp test premiere_cep
```

An MCP process test is not a live Premiere test. Before editing, call `get_capabilities(checkConnection=false)`, then have the user open `Window > Extensions > MCP Bridge (CEP)`, set the exact generated `PREMIERE_TEMP_DIR`, and click `Save Configuration`, `Start Bridge`, and `Test Connection`. Finally call `verify_premiere_connection`; only a successful response authorizes the live editing phase. If a required executable, package entrypoint, FFmpeg binary, ASR runtime, extension, or connection is missing, report the exact failure and stop; do not substitute UXP, raw ExtendScript, cloud processing, or a network listener.

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
- `premiere_cep`: `get_capabilities`, `verify_premiere_connection`, project/sequence inspection tools, `import_media`, `duplicate_sequence`, `create_sequence_from_clips`, `add_to_timeline_batch`, `add_marker`, `set_active_sequence`, `list_sequence_tracks`, `validate_project_for_export`, plus `save_project`/export tools only when the user asks to persist or render.

All three server registrations are required for the complete workflow. If a tool is not exposed, run the bootstrap/verification checks first, then report the missing server/tool and continue only with a safe, clearly labeled fallback. Do not replace CEP with UXP.

## Default runbook

1. Confirm the absolute local video path and the requested cut style/length. If either materially changes the result and cannot be inferred, ask before analysis.
2. Follow [references/operational-playbook.md](references/operational-playbook.md) for the low-token ASR search, candidate scoring, review gate, and Premiere assembly.
3. If any MCP server is not already available, read [references/mcp-setup-windows.md](references/mcp-setup-windows.md) and complete the bootstrap/verification there. For non-default Hermes locations, pass the documented path overrides; the reference must agree with the generated TOML config.
4. Return an analysis table containing ID, source start/end, duration, score, reason, short quote or visual cue, and evidence limitations. Include transcript, audio burst, scene boundary, and motion evidence when available.
5. Stop after the candidate table until the user approves. “Analyze” alone is not permission to mutate Premiere; “use candidates highlight-002 and highlight-005” or an equivalent explicit instruction is.
6. After approval, check capabilities, verify the live CEP connection, assemble the approved ranges in a new/duplicated sequence, add navigation markers, set the new sequence active, and verify tracks, gaps, offline media, and duration.
7. Report what was changed, what remains unsaved/unexported, and the exact next approval needed.

## Token-saving defaults

- Reuse an indexed `video_id` when the local path matches.
- For a long video, ingest with `visual=false`, `embed=false`, and `whisper_fallback=true` first. This provides fast transcript search without building a large keyframe/OCR index.
- Use `get_video_timeline` once, then run several short one- or two-term `search_videos` queries with a small limit and merge hits by timestamp. When semantic search is unavailable, compound queries can return no matches.
- Slice `get_transcript` around promising hits instead of requesting the full transcript.
- Only inspect frames for the final shortlist. If the index has no keyframes, use `highlight_local.get_frame` for a few timestamps or state that the score is transcript/audio-based.

## Completion criteria

A task is complete only when the approved clips are in the requested new sequence and a read-only verification reports the expected clip counts, linked audio, no blocking gaps/offline media, and the actual duration. Do not claim that an MP4 or `.prproj` was saved unless the relevant operation succeeded.
