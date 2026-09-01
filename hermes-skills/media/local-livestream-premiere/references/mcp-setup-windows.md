# Windows Hermes setup for this local workflow

This reference is for a Windows installation. It keeps the skill and all media processing local, and exposes only the MCP tools required by the workflow. Hermes reads MCP configuration under `mcp_servers` in its config file and prefixes exposed tools as `mcp_<server>_<tool>`.

In the examples below, replace `<REPO_ROOT>`, `<HERMES_ROOT>`, `<HERMES_NODE_MODULES>`, `<VIDEO_ROOT>`, `<FFMPEG_BIN>`, and `<FFPROBE_BIN>` with paths on the local machine. Do not commit the resulting Hermes user configuration or media files to the repository.

## 1. Skill discovery

The portable skill is stored in the project at:

`<REPO_ROOT>\hermes-skills\media\local-livestream-premiere\SKILL.md`

The Hermes user config is normally outside the repository, for example:

`%LOCALAPPDATA%\hermes\config.yaml`

Add this external skill directory under the existing `skills:` mapping. Keep existing skill settings such as `creation_nudge_interval`:

```yaml
skills:
  external_dirs:
    - '<REPO_ROOT>\hermes-skills'
```

Restart Hermes or start a new session, then verify with:

```powershell
hermes skills list --source all | Select-String local-livestream-premiere
```

If the installed Hermes build supports project skill trust, run this from the project root instead of making the skill global:

```powershell
hermes skills trust '<REPO_ROOT>'
```

## 2. MCP server block

Merge the following under the existing top-level `mcp_servers:` mapping. Do not replace unrelated Hermes configuration. These are the paths verified on this machine; update them if the Hermes installation moves.

```yaml
mcp_servers:
  video_context:
    command: '<HERMES_ROOT>\node\node.exe'
    args:
      - '<HERMES_NODE_MODULES>\@smallthinkingmachines\video-context-mcp\dist\index.js'
    connect_timeout: 30
    timeout: 900
    sampling:
      enabled: false
    supports_parallel_tool_calls: false
    tools:
      include:
        - list_videos
        - ingest_video
        - get_ingest_status
        - get_video_timeline
        - search_videos
        - get_transcript
        - peek_frame
    env:
      VCM_TOOLCHAIN_MODE: 'system'
      VCM_FFMPEG_BIN: '<FFMPEG_BIN>'
      VCM_FFPROBE_BIN: '<FFPROBE_BIN>'
      VCM_CACHE_DIR: '<REPO_ROOT>\.cache\video-context-mcp'
      VCM_OCR_BACKEND: 'wasm'
      VCM_ASR_BACKEND: 'transformers'

  premiere_cep:
    command: '<HERMES_ROOT>\node\node.exe'
    args:
      - '<HERMES_NODE_MODULES>\adobe-premiere-pro-mcp\dist\index.js'
    connect_timeout: 30
    timeout: 300
    sampling:
      enabled: false
    supports_parallel_tool_calls: false
    tools:
      include:
        - verify_premiere_connection
        - import_media
        - duplicate_sequence
        - add_to_timeline
        - add_to_timeline_batch
        - add_marker
        - set_active_sequence
        - list_sequence_tracks
        - validate_project_for_export
        - save_project
        - save_project_as
        - export_sequence
        - add_to_render_queue
    env:
      PREMIERE_TEMP_DIR: 'C:\Users\NAFISA~1\AppData\Local\Temp\premiere-mcp-bridge'

  highlight_local:
    command: '<HERMES_ROOT>\node\node.exe'
    args:
      - '<REPO_ROOT>\src\index.js'
    connect_timeout: 30
    timeout: 3600
    sampling:
      enabled: false
    supports_parallel_tool_calls: false
    tools:
      include:
        - server_info
        - analyze_video
        - get_analysis_status
        - get_frame
        - export_premiere_plan
    env:
      HIGHLIGHT_PROJECT_ROOT: '<REPO_ROOT>'
      HIGHLIGHT_ALLOWED_ROOTS: '<REPO_ROOT>;<VIDEO_ROOT>'
      HIGHLIGHT_FFMPEG_BIN: '<FFMPEG_BIN>'
      HIGHLIGHT_FFPROBE_BIN: '<FFPROBE_BIN>'
      HIGHLIGHT_CACHE_DIR: '<REPO_ROOT>\.cache\highlight-mcp'
      HIGHLIGHT_ASR_MODE: 'auto'
      HIGHLIGHT_ASR_CACHE_DIR: '<REPO_ROOT>\.cache\video-context-mcp\transformers'
      HIGHLIGHT_TRANSFORMERS_RUNTIME: '<HERMES_NODE_MODULES>\@smallthinkingmachines\video-context-mcp\vendor\transformers.node.min.mjs'
```

The tool `include` lists are intentional. They prevent destructive or rarely used operations from consuming the local model's context. Keep `supports_parallel_tool_calls` false because ingestion, analysis jobs, Premiere state, and cache files are shared state.

## 3. Verify the servers

From a fresh PowerShell window:

```powershell
hermes mcp list
hermes mcp test video_context
hermes mcp test premiere_cep
hermes mcp test highlight_local
```

The CEP test still requires the Adobe Premiere CEP bridge panel to be running. A successful `highlight_local` `server_info` should report local-only operation, `uxp: false`, and `networkListener: false`.

## 4. Example Hermes prompts

```text
/local-livestream-premiere
分析 C:\path\to\stream.mp4，找出 15–60 秒的 viral cuts。先只回傳候選，不要修改 Premiere。
```

```text
/local-livestream-premiere
使用剛才核准的 V-02、V-05、V-10，建立新的 Viral Activity Cuts 序列；保留影片與音訊、加入 markers、驗證後先不要儲存專案或輸出 MP4。
```

For a long video, explicitly ask for ASR-first analysis if token/compute budget matters. If a visual review is needed, ask for a small shortlist rather than a full visual re-index.
