# Windows Hermes/MCP setup

This repository uses the project-scoped Hermes configuration at:

```text
<REPO_ROOT>\.codex\config.toml
```

The format is TOML. Do not use the old YAML `config.yaml` example or paste a block containing unresolved `<REPO_ROOT>`/`<HERMES_ROOT>` placeholders into a live config.

## Required local layout

The bootstrap expects these paths unless explicit overrides are supplied:

```text
<REPO_ROOT>\src\index.js
<REPO_ROOT>\tools\bin\ffmpeg.exe
<REPO_ROOT>\tools\bin\ffprobe.exe
<REPO_ROOT>\tools\bin\yt-dlp.exe
%LOCALAPPDATA%\hermes\node\node.exe
%LOCALAPPDATA%\hermes\node\node_modules\@smallthinkingmachines\video-context-mcp\dist\index.js
%LOCALAPPDATA%\hermes\node\node_modules\adobe-premiere-pro-mcp\dist\index.js
%LOCALAPPDATA%\hermes\node\node_modules\@smallthinkingmachines\video-context-mcp\vendor\transformers.node.min.mjs
```

`<VIDEO_ROOT>` must be an existing absolute folder containing the source videos. It is added to the local highlight server's allowlist; do not use a machine-wide root.

## Bootstrap

From the repository root, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\hermes-skills\media\local-livestream-premiere\scripts\ensure-hermes-config.ps1" -VideoRoot "C:\path\to\videos" -Apply
```

Use `-RepoRoot`, `-HermesRoot`, `-FfmpegBin`, or `-FfprobeBin` when the default layout differs. Without `-Apply`, the script only validates paths and prints the TOML it would write. With `-Apply`, it preserves unrelated config, replaces only the three managed `mcp_servers` sections, and creates a timestamped `.bak-*` file before writing.

Use `-Apply` only when environment setup has been requested or explicitly approved. Preview is the correct mode for an analysis-only task.

## Registered servers

The generated TOML must contain all three entries:

| Server | Command/entrypoint | Required environment |
|---|---|---|
| `video_context` | Hermes Node → `@smallthinkingmachines\video-context-mcp\dist\index.js` | system toolchain, local FFmpeg/FFprobe/yt-dlp, local cache, Transformers ASR/OCR |
| `highlight_local` | Hermes Node → `<REPO_ROOT>\src\index.js` | project root, semicolon-separated allowlist, local FFmpeg/FFprobe, ASR runtime/cache, motion enabled |
| `premiere_cep` | Hermes Node → `adobe-premiere-pro-mcp\dist\index.js` | local `PREMIERE_TEMP_DIR` for the CEP bridge |

Each server needs its `cwd`, `startup_timeout_sec`, `tool_timeout_sec`, and `default_tools_approval_mode = 'writes'`. The analysis entrypoint is `src\index.js`; do not point `highlight_local` at the skill directory.

## Verification

Start a fresh Hermes session after applying the config:

```powershell
hermes mcp list
hermes mcp test video_context
hermes mcp test highlight_local
hermes mcp test premiere_cep
```

Expected `highlight_local` `server_info` values include `localOnly: true`, `uxp: false`, and `networkListener: false`. The Premiere test needs the CEP bridge panel open; a closed panel is an operational dependency, not a reason to switch to UXP.

## Troubleshooting

- `server not found` or no tools: restart Hermes and confirm the process was started from the repository/project context that loads `.codex\config.toml`.
- `Cannot find module`: verify the Hermes Node path and the package entrypoint under the same `node_modules` tree; do not use a different global Node installation unless its dependencies are installed there.
- FFmpeg/FFprobe errors: provide absolute `-FfmpegBin`/`-FfprobeBin` paths and confirm both files exist.
- ASR unavailable: provide a local `.srt`/`.vtt` sidecar or verify the bundled Transformers runtime and cache paths.
- Allowlist denied: pass the parent directory of the video as `-VideoRoot`; keep the path absolute and local.
- CEP unavailable: open Premiere Pro and the CEP bridge panel, then rerun only `hermes mcp test premiere_cep`.

Never solve a setup failure with cloud video processing, UXP, raw ExtendScript, a network listener, or by widening the allowlist to the whole machine.
