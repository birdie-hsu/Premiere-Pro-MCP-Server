# Local livestream highlight solution

This repository is a three-MCP workflow, not a single Premiere server. Use:

- `video_context` for local ingest, ASR/transcript, timeline, search, keyframes, and OCR;
- `highlight_local` (`src/index.js`) for transparent transcript/audio/scene/motion scoring and JSON/FCP7 handoff;
- `premiere_cep` for live Adobe Premiere Pro work through the CEP bridge, only after approval.

The canonical project skill is `.agents/skills/local-livestream-premiere/SKILL.md`. A fresh Hermes installation must trust this repository with `hermes skills trust <REPO_ROOT>` so the repo-local skill wins over any stale user-level copy.

## Required reading

- For a new machine, missing MCP, config, or bridge: read `.agents/skills/local-livestream-premiere/references/mcp-setup-windows.md` before changing the environment.
- For an analysis/editing request: read `.agents/skills/local-livestream-premiere/references/operational-playbook.md`.
- For scoring behavior or changes: read `.agents/skills/local-livestream-premiere/references/scoring-profile.md`.

## Environment contract

The project-scoped MCP config is `.codex/config.toml` in TOML format. Do not create a project YAML config or commit `.codex`, `.cache`, media, models, tools, projects, exports, or user-specific paths.

Use the skill's `ensure-hermes-config.ps1` in preview mode first. Use `-Apply` only for requested/approved setup. Installing the CEP extension is a separate explicit action through `-Apply -InstallPremiereCep`; it replaces the current user's `MCPBridgeCEP` extension after making a backup.

Premiere readiness has distinct levels:

1. `hermes mcp test premiere_cep` proves only that the stdio MCP process starts.
2. `get_capabilities(checkConnection=false)` checks the local package/bridge installation without editing.
3. In Premiere, open `Window > Extensions > MCP Bridge (CEP)`, set the exact `PREMIERE_TEMP_DIR`, then click `Save Configuration`, `Start Bridge`, and `Test Connection`.
4. `verify_premiere_connection` must succeed before any Premiere mutation.

Do not claim Premiere is ready from the MCP process test alone.

## Runtime state machine

1. **DISCOVER** — obtain the absolute local video path plus highlight style/length. Do not scan the machine; the path must be inside the configured allowlist.
2. **ANALYZE** — prefer `video_context` ASR-first analysis, and use `highlight_local` for transparent scoring/fallback. Return candidate ID, source start/end, duration, 0–100 score, reason, quote/visual cue, and evidence limits. Do not modify Premiere.
3. **REVIEW** — stop until the user explicitly approves candidate IDs or time ranges. Analysis requests are not editing permission.
4. **ASSEMBLE** — check capabilities and live CEP connection; inspect the project read-only; preserve the original sequence. A connected response may have `activeSequence: null`. Duplicate only a real sequence ID; otherwise use `create_sequence_from_clips` or a real `.sqpreset`. Import media and place only approved source ranges with `add_to_timeline_batch(linkAudio=true)`.
5. **VERIFY** — after every mutation, use the narrowest read-only check. Finish with `list_sequence_tracks` and `validate_project_for_export(requireNonEmptyTimeline=true, checkGaps=true)`. Treat `success:false` as a stop condition, not a retry loop.
6. **PERSIST/EXPORT** — editing approval does not authorize save or export. Ask again before `save_project`, overwriting a project/export, or rendering.

Keep all media and analysis artifacts local. Never substitute UXP, direct raw ExtendScript, a cloud video service, or a network listener for the CEP workflow. Prefer non-destructive edits and report clearly when a sequence is created but remains unsaved or unexported.
