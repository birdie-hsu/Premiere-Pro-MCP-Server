# Local livestream highlight solution

This repository is a three-MCP workflow, not a single Premiere server. The
canonical operator procedure is
.agents/skills/local-livestream-premiere/SKILL.md. It is written for a small
Hermes local model. Follow it literally.

## Three servers

- video_context: optional local transcript search and timeline evidence.
- highlight_local: default local scoring and JSON/FCP7 handoff. It never edits
  Premiere.
- premiere_cep: live Adobe Premiere Pro work through the CEP bridge.

The three registrations are all required for a complete installation, but a
normal analysis uses highlight_local first and a normal edit uses premiere_cep
only after approval.

## Required reading

- Always read .agents/skills/local-livestream-premiere/SKILL.md first.
- For a new machine, missing MCP, config, or bridge, read
  .agents/skills/local-livestream-premiere/references/mcp-setup-windows.md
  before changing the environment.
- For analysis or editing, read
  .agents/skills/local-livestream-premiere/references/operational-playbook.md
  after the main skill.
- For scoring changes or signal questions, read
  .agents/skills/local-livestream-premiere/references/scoring-profile.md.

## 9B execution contract

1. Keep VIDEO_PATH, STYLE, CLIP_SECONDS, MAX_CANDIDATES, KEYWORDS, and
   ANALYSIS_ID. Defaults are general, 45, 5, and [].
2. Ask for the absolute local VIDEO_PATH if it is missing. Never scan the
   computer. The path must be inside HIGHLIGHT_ALLOWED_ROOTS.
3. Analyse with highlight_local.server_info, analyze_video, then poll
   get_analysis_status. Poll only while queued/running; stop at 30 polls.
4. Return candidate IDs, source start/end, duration, score, reasons, quote, and
   evidence. Scores are ranking aids.
5. Stop and ask for explicit candidate IDs. Analysis is not editing approval.
6. After approval, call Premiere tools in this exact order:
   get_capabilities(checkConnection=false) →
   verify_premiere_connection →
   choose a source sequence →
   duplicate_sequence(clearContents=true) →
   import_media →
   add_to_timeline_batch(linkAudio=true) →
   set_active_sequence →
   list_sequence_tracks →
   validate_project_for_export.
7. Require bridge.cep.status=installed, then
   verify_premiere_connection success=true and status=connected.
8. If no active sequence exists, use list_sequences only:
   count=1 uses sequences[0].id; count=0 stops; count>1 stops and asks the
   user to open the desired source sequence. Do not guess.
9. For this simple route, never use create_sequence, create_sequence_from_clips,
   a guessed .sqpreset, add_marker, UXP, raw ExtendScript, or a network
   listener.
10. Any success=false, isError=true, partial result, or failed verification is
    a stop condition. Do not retry blindly.
11. Saving the .prproj and rendering a video require separate explicit approval.

## Environment contract

The only project config is .codex/config.toml in TOML format. Do not create a
project YAML config or commit .codex, .cache, media, models, tools, projects,
exports, or user-specific paths.

Use the skill script
.agents/skills/local-livestream-premiere/scripts/ensure-hermes-config.ps1.
Run preview first. Use -Apply only when setup was requested or approved.
Install the CEP extension only with the explicit
-Apply -InstallPremiereCep option; it backs up the current MCPBridgeCEP before
replacement.

Premiere readiness has four separate checks:

1. Bootstrap preview: local paths, packages, tools, and runtime exist.
2. hermes mcp test premiere_cep: stdio MCP starts. This does not prove Premiere
   is connected.
3. premiere_cep.get_capabilities(checkConnection=false):
   bridge.cep.status must be installed.
4. In Premiere open Window > Extensions > MCP Bridge (CEP), set the exact
   generated PREMIERE_TEMP_DIR, click Save Configuration, Start Bridge, and
   Test Connection, then call verify_premiere_connection.

Do not claim Premiere is ready from the process test alone. Keep media and
analysis artifacts local. Preserve the original sequence and report clearly
when a new sequence is not saved or exported.
