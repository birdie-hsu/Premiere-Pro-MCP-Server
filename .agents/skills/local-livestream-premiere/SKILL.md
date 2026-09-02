---
name: local-livestream-premiere
description: Run a local livestream highlight workflow with three local MCP servers, then assemble user-approved clips in Adobe Premiere Pro through the CEP bridge.
metadata:
  hermes:
    category: media
    tags: [video, livestream, highlight, premiere-pro, MCP]
---

# Local video highlights in Premiere Pro

This file is an operator procedure for a small local model. Follow the numbered
steps exactly. Use one tool call at a time. Do not invent a tool name, an input
field, an ID, or a file path.

## Rules that never change

1. Use only an absolute local video path supplied by the user. Never scan the
   computer for videos.
2. The three servers have different jobs:
   - video_context: optional transcript search and timeline evidence.
   - highlight_local: default local scoring. It scores transcript, audio, scene
     changes, and low-weight motion. It does not edit Premiere.
   - premiere_cep: Premiere Pro editing through the CEP bridge.
3. Do not call premiere_cep while analysing or showing candidates.
4. Do not edit until the user explicitly names candidate IDs, for example
   使用 highlight-001 和 highlight-003 剪輯.
5. Do not save a project or render a video unless the user gives a separate
   explicit save/export instruction.
6. Never use UXP, raw ExtendScript, a cloud video service, or a network
   listener. Never call execute_extendscript or evaluate_expression.
7. If any tool returns success: false, isError: true, or an error status,
   stop. Show the error. Do not retry in a loop.

## Keep these six values

Set these values before analysis. Use the defaults when the user did not give a
value.

| Name | Value |
|---|---|
| VIDEO_PATH | The user's absolute local video path. Ask if missing. |
| STYLE | User's style; otherwise general. |
| CLIP_SECONDS | User's target length; otherwise 45. |
| MAX_CANDIDATES | 5. |
| KEYWORDS | User's words; otherwise []. |
| ANALYSIS_ID | Returned by highlight_local.analyze_video. |

Do not change CLIP_SECONDS below 10 or above 600. Do not use a different
MAX_CANDIDATES unless the user asks for it.

## Choose the next mode

- Missing server, package, config, or CEP extension → SETUP.
- No explicit approved candidate IDs yet → ANALYZE.
- The user explicitly approved candidate IDs → EDIT.
- The user asks to save or render after editing → read the save/export section
  in [references/operational-playbook.md](references/operational-playbook.md)
  and ask for the exact output path before changing anything.

If the user says “analyse and edit”, do ANALYZE, show candidates, and stop.
The next user message must approve IDs before EDIT.

## SETUP: one-time Windows setup

Read [references/mcp-setup-windows.md](references/mcp-setup-windows.md) before
changing the environment. Do not skip the preview command.

1. REPO_ROOT is the folder containing package.json and src\index.js.
   VIDEO_ROOT is the user's real absolute video folder. If either is unknown,
   ask the user for it and stop.
2. From REPO_ROOT, run:

~~~powershell
hermes skills trust "<REPO_ROOT>"
$Bootstrap = "<REPO_ROOT>\.agents\skills\local-livestream-premiere\scripts\ensure-hermes-config.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap -RepoRoot "<REPO_ROOT>" -VideoRoot "<VIDEO_ROOT>"
~~~

3. If preview reports no errors and the user requested setup, run:

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap -RepoRoot "<REPO_ROOT>" -VideoRoot "<VIDEO_ROOT>" -Apply
~~~

   For non-English media, pass the same -AsrModel value in both commands.
4. If preview says the CEP extension is missing, install it only when setup is
   authorized:

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap -RepoRoot "<REPO_ROOT>" -VideoRoot "<VIDEO_ROOT>" -Apply -InstallPremiereCep
~~~

5. Start a new Hermes session, then run these checks:

~~~powershell
hermes mcp list
hermes mcp test video_context
hermes mcp test highlight_local
hermes mcp test premiere_cep
~~~

6. A process test only proves that an MCP process starts. Before editing, in
   Premiere Pro open Window > Extensions > MCP Bridge (CEP), set its Temp
   Directory to the exact generated PREMIERE_TEMP_DIR, then click in order:
   Save Configuration → Start Bridge → Test Connection.

The project config is <REPO_ROOT>\.codex\config.toml (TOML). Do not create a
YAML config and do not commit .codex, cache, media, models, tools, projects,
exports, or user-specific paths.

## ANALYZE: default five-call route

This route uses highlight_local because it already returns ranked candidates
with scores and evidence. It enables the requested first three practical
signals: scene boundary, low-weight motion, and relative audio burst. It also
uses transcript/ASR when available.

Use these Hermes tool names (the exact prefix may be shown by Hermes as
mcp_highlight_local_*).

### A1. Check the local scorer

Call mcp_highlight_local_server_info with this input:

~~~json
{}
~~~

Continue only when the result says:

~~~text
localOnly = true
uxp = false
networkListener = false
~~~

### A2. Start analysis

Call mcp_highlight_local_analyze_video with exactly these fields:

~~~json
{
  "video_path": "VIDEO_PATH",
  "clip_length_seconds": 45,
  "max_candidates": 5,
  "style": "STYLE",
  "keywords": []
}
~~~

Replace the quoted values with the values in the table above. Save the returned
analysisId as ANALYSIS_ID. Do not use analysis_id here.

### A3. Poll analysis

Call mcp_highlight_local_get_analysis_status with:

~~~json
{
  "analysis_id": "ANALYSIS_ID",
  "include_transcript": false
}
~~~

If status is queued or running, call the same tool again later. Stop after 30
polls. If status is error, stop. Continue only when status is completed.

### A4. Make the candidate table

Read result.candidates. For every candidate, copy these exact fields:

~~~text
id, startSeconds, endSeconds, durationSeconds, score, reasons, quote, evidence
~~~

Return this table and nothing that implies a visual fact not present in
evidence:

| ID | Source start–end | Seconds | Score | Reason | Quote / visual evidence | Limit |
|---|---|---:|---:|---|---|---|

Say that the score is a local ranking aid, not truth. Say whether transcript,
audio burst, scene boundary, and motion evidence were available. If transcript
is missing, say no transcript; audio/scene/motion only.

### A5. Stop for approval

End with this exact request:

~~~text
請只回覆要剪的候選 ID，例如：使用 highlight-001、highlight-003。
我在收到 ID 前不會修改 Premiere。
~~~

Do not call any Premiere tool after A5.

### Optional video_context route

Use video_context only when the user specifically asks for transcript/topic
search, or when highlight_local cannot provide analysis. Do not invent a
0–100 score from search hits. Use this order only:

1. mcp_video_context_ingest_video with
   {"url_or_path":"VIDEO_PATH","visual":false,"embed":false,"whisper_fallback":true}.
2. Poll mcp_video_context_get_ingest_status with the returned video_id
   until stage is done; stop on error.
3. Call mcp_video_context_get_video_timeline once.
4. Call mcp_video_context_search_videos with one short query and limit: 5.
5. Call mcp_video_context_get_transcript only around a promising hit.

Use the results as transcript evidence, then run the default highlight_local
route if a scored candidate table is required.

### Optional JSON/FCP7 handoff

Use this only when the user explicitly asks for a local handoff file. Require
approved candidate IDs first, then call
mcp_highlight_local_export_premiere_plan once:

~~~json
{
  "analysis_id": "ANALYSIS_ID",
  "candidate_ids": ["highlight-001"],
  "output_dir": "LOCAL_OUTPUT_DIR",
  "name": "ai-highlights",
  "sequence_name": "AI Highlights",
  "include_xml": true,
  "overwrite": false
}
~~~

Require success=true. This creates local JSON/FCP7 files only; it does not
connect to or edit Premiere. Do not set overwrite=true unless the user asks to
replace an existing file.

## EDIT: fixed non-destructive Premiere route

Enter this section only after the user approved IDs that exist in the last
candidate table. Use the approval order as the timeline order.

For 9B mode, the user must have the desired source sequence open in Premiere,
or the project must contain exactly one sequence. This avoids guessing a
sequence and avoids an unknown native preset. If there are multiple sequences
and no active sequence ID, stop and ask the user to open the source sequence.

Use only these premiere_cep tools, in this order:

### E1. Check CEP installation

Call mcp_premiere_cep_get_capabilities:

~~~json
{
  "checkConnection": false
}
~~~

Continue only when:

~~~text
success = true
bridge.cep.status = "installed"
~~~

If update.available=true and the update is not snoozed, ask Update now or Later
and stop.

### E2. Check the live bridge

Call mcp_premiere_cep_verify_premiere_connection with {}. Continue only when
success=true and status=connected. A successful result may have
activeSequence=null; that means only that no sequence is active.

If this call fails, tell the user to start the CEP panel. Do not retry in a
loop and do not edit.

### E3. Find the source sequence

- If E2 returned activeSequence.id, set SOURCE_SEQUENCE_ID to that value.
- Otherwise call mcp_premiere_cep_list_sequences with {}.
- If the result has count=1, set SOURCE_SEQUENCE_ID to sequences[0].id.
- If the result has count=0, stop and ask the user to create/open one source
  sequence.
- If the result has more than one sequence, stop and ask the user to open the
  desired source sequence, then run EDIT again.
- If list_sequences returns an error, stop. Do not keep calling it.

### E4. Duplicate, never clear the original

Call mcp_premiere_cep_duplicate_sequence:

~~~json
{
  "sequenceId": "SOURCE_SEQUENCE_ID",
  "newName": "AI Highlights",
  "clearContents": true
}
~~~

Continue only when success=true and newSequenceId is present. Set
TARGET_SEQUENCE_ID to newSequenceId. The original sequence ID must never be
used as the destination.

### E5. Import the source media

Call mcp_premiere_cep_import_media:

~~~json
{
  "filePath": "VIDEO_PATH"
}
~~~

Continue when success=true and save the returned id as MEDIA_ID.
alreadyImported=true is okay; still use its returned id.

### E6. Place approved clips in one batch

Create one clip object per approved candidate. Start CURSOR at 0. For each
candidate in approval order, use the previous cursor as time, then add that
candidate's durationSeconds to the cursor for the next clip.

Call mcp_premiere_cep_add_to_timeline_batch once with this shape:

~~~json
{
  "sequenceId": "TARGET_SEQUENCE_ID",
  "clips": [
    {
      "projectItemId": "MEDIA_ID",
      "trackIndex": 0,
      "time": 0,
      "linkAudio": true,
      "sourceInPoint": 12.5,
      "sourceOutPoint": 57.5
    }
  ]
}
~~~

Replace the example values with every approved candidate. Continue only when
success=true, status=success, failed=0, and placed=total.
If the result is partial, failure, or success=false, stop and report the
per-clip results; do not retry automatically.

### E7. Show and verify the new sequence

1. Call mcp_premiere_cep_set_active_sequence with
   {"sequenceId":"TARGET_SEQUENCE_ID"}. Require success=true.
2. Call mcp_premiere_cep_list_sequence_tracks with
   {"sequenceId":"TARGET_SEQUENCE_ID"}.
3. Call mcp_premiere_cep_validate_project_for_export with:

~~~json
{
  "sequenceId": "TARGET_SEQUENCE_ID",
  "requireNonEmptyTimeline": true,
  "checkGaps": true
}
~~~

Require success=true, readyForExport=true, summary.offlineMediaCount=0,
and summary.gapCount=0. If any requirement fails, report it as unfinished.

Do not add markers in the minimal 9B route. Add add_marker only if the user
explicitly asks for markers; it is optional and does not replace verification.

## EDIT completion message

After E7, report:

~~~text
完成：已建立新 sequence「AI Highlights」並放入 N 個核准片段。
原始 sequence 未修改。
Premiere sequence 已驗證；專案尚未儲存，影片尚未輸出。
~~~

Replace N with the verified count. Never say that a project or MP4 was saved
unless the save/render tool returned success after separate approval.

## What is intentionally not enabled

Do not call object or action detectors. They are not part of the current
default local scorer. The current transparent score uses transcript when
available, relative audio energy/burst, scene boundaries, and low-weight motion;
the evidence returned by highlight_local is the source of truth for the
candidate table.

For signal definitions and weights, read
[references/scoring-profile.md](references/scoring-profile.md). For save,
export, or detailed troubleshooting, read
[references/operational-playbook.md](references/operational-playbook.md).
