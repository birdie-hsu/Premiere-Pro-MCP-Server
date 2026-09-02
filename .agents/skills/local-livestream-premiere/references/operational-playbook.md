# Operational playbook: exact 9B route

Read this file only after loading the canonical skill. It is a detailed reminder
of the same route; it is not a second route. The canonical skill wins if text
appears different.

## 1. Fixed inputs

Keep these values in the conversation:

| Variable | Required value |
|---|---|
| VIDEO_PATH | Absolute local video path supplied by the user |
| STYLE | User value, or general |
| CLIP_SECONDS | User value from 10 to 600, or 45 |
| MAX_CANDIDATES | 5 |
| KEYWORDS | User values, or [] |
| ANALYSIS_ID | Returned by analyze_video |
| APPROVED_IDS | IDs explicitly approved by the user |

If VIDEO_PATH is missing, ask for it. Never search the computer. If the path is
outside HIGHLIGHT_ALLOWED_ROOTS, stop and report that setup must add its parent
folder.

## 2. Default analysis

Use highlight_local first. It is the only server in the default analysis path
that directly returns a 0–100 score.

Call the tools in this order:

1. mcp_highlight_local_server_info with {}.
2. Continue only if localOnly=true, uxp=false, and networkListener=false.
3. mcp_highlight_local_analyze_video with:

~~~json
{
  "video_path": "VIDEO_PATH",
  "clip_length_seconds": 45,
  "max_candidates": 5,
  "style": "STYLE",
  "keywords": []
}
~~~

4. Save the returned analysisId. Call
   mcp_highlight_local_get_analysis_status with:

~~~json
{
  "analysis_id": "ANALYSIS_ID",
  "include_transcript": false
}
~~~

5. Poll only while status is queued or running. Stop at 30 polls. Continue
   only for status completed. Stop for status error.
6. Read result.candidates. Copy id, startSeconds, endSeconds,
   durationSeconds, score, reasons, quote, and evidence.

The score is a local ranking aid. It is not a claim that a human would like the
clip. Evidence can contain transcriptSignal, audioEnergy, audioBurst,
sceneBoundary, and motionEnergy. Motion is weak evidence. A scene boundary or
audio peak alone is not a reason to select a clip. Do not claim an object or
action unless the evidence says it.

### Optional transcript search

Use video_context only if the user specifically asks for topic/transcript
search or the local scorer cannot run. This is evidence gathering, not scoring.

Call in this order:

1. mcp_video_context_ingest_video with
   url_or_path=VIDEO_PATH, visual=false, embed=false, whisper_fallback=true.
2. Poll mcp_video_context_get_ingest_status until stage=done.
3. mcp_video_context_get_video_timeline once.
4. mcp_video_context_search_videos with one short query and limit=5.
5. mcp_video_context_get_transcript around a promising timestamp.

Do not assign a score to a search hit. If a scored table is needed, return to
the default highlight_local route.

If the user asks for a handoff file after approving IDs, call
mcp_highlight_local_export_premiere_plan once with the last ANALYSIS_ID,
approved candidate_ids, a local output_dir, include_xml=true, and
overwrite=false. Require success=true. The generated JSON/FCP7 files are not a
Premiere edit.

## 3. Review gate

Return one row per candidate:

| ID | Source start–end | Duration | Score | Reason | Quote / evidence | Limit |
|---|---|---:|---:|---|---|---|

Then write:

~~~text
請只回覆要剪的候選 ID，例如：使用 highlight-001、highlight-003。
我在收到 ID 前不會修改 Premiere。
~~~

Stop. Do not call any premiere_cep tool. An instruction to “find” or
“analyse” is not approval.

## 4. Premiere preconditions

Only enter this section when APPROVED_IDS are present in the last candidate
table. Use the approval order.

Premiere must have the desired source sequence open. If the bridge reports no
active sequence, use list_sequences:

- count=1: use sequences[0].id.
- count=0: stop and ask the user to create/open one sequence.
- count>1: stop and ask the user to open the desired sequence, then run EDIT
  again.
- tool error: stop; do not loop.

For the minimal route, do not use create_sequence, create_sequence_from_clips,
or a guessed .sqpreset. A real source sequence is required so its frame rate,
resolution, and track layout can be copied safely.

## 5. Premiere edit calls

Call only these tools in this order:

### 5.1 Installed CEP

Call mcp_premiere_cep_get_capabilities with:

~~~json
{"checkConnection":false}
~~~

Require success=true and bridge.cep.status=installed. If
update.available=true and the update is not snoozed, ask the user
Update now or Later and stop.

### 5.2 Live connection

Call mcp_premiere_cep_verify_premiere_connection with {}.

Require success=true and status=connected. A connected response with
activeSequence=null is allowed, but it requires the sequence selection rule in
section 4. If this call fails, ask the user to start the CEP panel and stop.

### 5.3 Duplicate the source

Call mcp_premiere_cep_duplicate_sequence with:

~~~json
{
  "sequenceId": "SOURCE_SEQUENCE_ID",
  "newName": "AI Highlights",
  "clearContents": true
}
~~~

Require success=true and newSequenceId. Set TARGET_SEQUENCE_ID to
newSequenceId. Never use SOURCE_SEQUENCE_ID as the timeline destination.

### 5.4 Import media

Call mcp_premiere_cep_import_media with:

~~~json
{"filePath":"VIDEO_PATH"}
~~~

Require success=true and id. Set MEDIA_ID to id. alreadyImported=true is
successful and still supplies the correct id.

### 5.5 Place clips

Make one object per APPROVED_ID. Use the candidate source times. Start the
timeline cursor at zero and add each candidate durationSeconds to get the next
time. Then call mcp_premiere_cep_add_to_timeline_batch once:

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

Require success=true, status=success, failed=0, and placed=total.
A partial result is not completion. Report results and stop; do not retry.

### 5.6 Activate and verify

Call these three tools:

1. mcp_premiere_cep_set_active_sequence with
   {"sequenceId":"TARGET_SEQUENCE_ID"}; require success=true.
2. mcp_premiere_cep_list_sequence_tracks with
   {"sequenceId":"TARGET_SEQUENCE_ID"}.
3. mcp_premiere_cep_validate_project_for_export with:

~~~json
{
  "sequenceId": "TARGET_SEQUENCE_ID",
  "requireNonEmptyTimeline": true,
  "checkGaps": true
}
~~~

Require success=true, readyForExport=true, summary.offlineMediaCount=0,
and summary.gapCount=0. Report any failed requirement.

Markers are not part of the minimal route. Call add_marker only when the user
explicitly asks for markers.

## 6. Save/export is a separate request

The edit approval does not approve saving or rendering.

- Do not call save_project after E7 unless the user separately says to save.
- Ask for an exact output path before rendering.
- Do not overwrite a project, plan, or video output without explicit approval.
- An unconfirmed save/render is not success.
- If no save/render was requested, report: sequence created, project not saved,
  video not exported.

## 7. One-shot failure handling

| Failure | Action |
|---|---|
| Missing server/tool | Stop and use the setup reference |
| Invalid or disallowed path | Stop and ask for an allowed local path |
| Analysis status error | Show error; do not poll forever |
| CEP not installed | Stop; run setup only with authorization |
| Bridge not connected | Stop; user starts the CEP panel |
| No usable source sequence | Stop; user creates/opens one |
| Any success=false or isError=true | Show result; no blind retry |
| Verification has errors/gaps/offline media | Report unfinished; do not save/export |

The local artifacts remain on the machine. Never replace the CEP path with UXP,
raw ExtendScript, a cloud service, or a network listener.
