# Operational playbook

This reference contains the detailed procedure behind `local-livestream-premiere`. Keep the main skill short; load this file when the workflow is actually requested.

## 1. State machine

Use these states and do not skip the review gate:

| State | Allowed actions | Required output |
|---|---|---|
| DISCOVER | Resolve a local path and inspect available MCP tools | Source path, requested style/length, available servers |
| ANALYZE | Ingest, poll, search transcript/timeline, inspect a few frames | Ranked candidate table; no Premiere mutation |
| REVIEW | Ask the user to approve IDs/ranges and any clean-language or aspect-ratio preference | Explicit approval |
| ASSEMBLE | Verify CEP, duplicate/new sequence, import media, place approved ranges, add markers | New sequence ID and placement results |
| VERIFY | Inspect tracks and run export-readiness audit | Counts, duration, gaps, offline-media status |
| PERSIST/EXPORT | Save or render only after the user asks and supplies/approves the path | Saved/exported path or a clear unsaved/unexported notice |

## 2. Input handling

Ask for an absolute local path if it is missing. Never search the whole machine or silently copy a large video. If the path is outside the server allowlist, explain that the user must add its parent directory to `HIGHLIGHT_ALLOWED_ROOTS` (or use a configured `video_context` path) before analysis.

Infer a useful default only when it is safe:

- “Find product information” → product-introduction, specification, comparison, demonstration, and product-manager language.
- “Find viral cuts” → reactions, laughter, cheering, surprises, reversals, clutch outcomes, failures with a clear payoff, and quotable lines.
- Missing target length → 15–60 seconds per short-form candidate; allow a longer window when the setup-to-payoff arc needs it, but explain why.
- Missing output shape → make one new stringout/highlight sequence with clips in source order and markers at each clip start. Ask before exporting separate files.

## 3. Low-token ASR-first analysis

### Preferred route: `video_context`

Use the Hermes-prefixed versions of these server tools (the prefix is normally automatic):

1. `list_videos` to see whether the local file is already indexed. Reuse the matching `video_id`.
2. If needed, call `ingest_video` with the absolute path. For a long local recording use:

   - `visual: false`
   - `embed: false`
   - `whisper_fallback: true`

   Poll `get_ingest_status` until `stage=done` or an error is returned. Do not repeatedly request a full result while the job is running.

3. Call `get_video_timeline` once for duration, transcript source, chapters/outline, and keyframe availability.
4. Search with short queries and `limit` around 5–8. Run terms separately when needed, for example:

   - Viral: `cheering`, `laughing`, `scream`, `wow`, `no way`, `clutch`, `headshot`, `victory`, `missed`, `dramatic music`, `last chance`.
   - Product: the brand/product name, `product manager`, `features`, `specs`, `OLED`, `battery`, `DPI`, `upgrade`.
   - Event: `show begins`, `challenge`, `versus`, `round`, `dragon`, `final`, `winner`.

   Merge hits that are within roughly 10–30 seconds and follow each hit with a narrow `get_transcript` slice. Compound natural-language queries are less reliable when `semantic_search.available` is false, so use several cheap searches instead of one large query.

5. For a visual check, call `peek_frame` only on the shortlist when indexed keyframes exist. If the timeline says there are no keyframes, use `highlight_local.get_frame` at one or two timestamps per candidate, or mark visual evidence as unavailable. Do not re-index a multi-gigabyte video visually just to improve a preliminary ranking without telling the user about the extra cost.

### Fallback route: `highlight_local`

Use this local MCP when `video_context` is unavailable, when a transparent audio/scene heuristic is useful, or when the user requests a reusable plan:

1. `server_info` to verify `localOnly=true`, `uxp=false`, and `networkListener=false`.
2. `analyze_video` with the local path, target `clip_length_seconds`, `max_candidates`, `style`, and optional `keywords`.
3. Poll `get_analysis_status` until `status=completed`. Keep `include_transcript=false` for compact polling; request full transcript only for a selected range.
4. Treat the returned score as a transparent heuristic, not semantic truth. Preserve its `reasons` and `evidence` in the candidate report.
5. After approval, `export_premiere_plan` may write a non-destructive JSON/FCP7 XML handoff. It refuses existing files unless `overwrite=true`; never turn this into a silent overwrite.

## 4. Candidate scoring and reporting

Score candidates on a 0–100 scale and state that the score is a prioritization aid. A useful rubric is:

| Signal | Weight | What to reward |
|---|---:|---|
| Payoff / narrative arc | 30% | A recognizable hook, tension, and outcome inside the window |
| Energy / reaction | 25% | Cheering, laughter, screams, fast exchange, music hit, or audio peak |
| Standalone clarity | 20% | A viewer can understand the moment without the entire livestream |
| Quotable hook | 15% | A short memorable line, surprise, joke, or challenge |
| Visual/scene evidence | 10% | Scene changes, visible action, on-screen result, or verified frame cue |

Subtract or flag candidates with long setup and no payoff, product-ad-only content when the request is for activities, ambiguous ASR, long silence, or an unclear ending. Do not invent visual facts from transcript alone.

The local fallback additionally records one-second evidence for transcript signal, relative audio burst, scene boundary, and low-weight frame-difference motion. Use `audioBurst` for a sudden rise over the video's local level, `sceneBoundary` as an edge/candidate-generation cue, and `motionEnergy` only as supporting visual evidence. A scene cut or motion event alone is not sufficient reason to select a clip. Treat audio peak and audio burst as one audio family when checking multi-signal agreement.

Return this minimum table:

| ID | Source start–end | Duration | Score | Why it may travel | Quote / visual cue | Confidence |
|---|---|---:|---:|---|---|---|

Include the source `video_id`, analysis method, and whether frames/OCR were available. If ASR is noisy, preserve the original wording and label it as an ASR approximation rather than silently correcting names.

## 5. Approval gate

After presenting candidates, stop and ask for an explicit selection. Examples of sufficient approval:

- “剪 V-02、V-05、V-10。”
- “Use the recommended six clips.”
- “Put 00:39:34–00:40:20 and 01:52:25–01:53:25 in a new sequence.”

Do not treat a request to “analyze” or “show me candidates” as approval. If the user already asked to edit but did not select a range, present the shortlist and ask which IDs to use; do not guess a materially different set.

## 6. Premiere CEP assembly

Only after approval:

1. Call `verify_premiere_connection`. If it fails, tell the user to open the CEP bridge panel and stop; do not retry indefinitely or switch to UXP.
2. Use the returned active sequence ID as the duplication source unless the user names another sequence. `duplicate_sequence` with `clearContents=true` creates a new empty sequence while preserving the source.
3. Call `import_media` with the exact absolute source path. It is safe to reuse an item when the tool reports `alreadyImported=true`.
4. Compute a timeline cursor starting at 0. Put approved clips in the requested order with `add_to_timeline_batch`, using:

   - `sequenceId`: the new sequence ID
   - `projectItemId`: the imported media ID
   - `time`: the cursor in seconds
   - `trackIndex: 0`
   - `sourceInPoint` and `sourceOutPoint`: the approved source seconds
   - `linkAudio: true`

   Advance the cursor using the returned actual `outPoint`, not only the requested duration. This avoids frame-rounding gaps.

5. Add a marker at each returned actual start time. Include the candidate ID, source range, short quote/reason, and any content warning.
6. Set the new sequence active so the user can see it.

If `list_sequences` or `get_active_sequence` returns `ReferenceError: __ticksToSeconds is not a function`, do not loop on the broken call. Continue with the active sequence ID from `verify_premiere_connection` and use `list_sequence_tracks` for verification.

## 7. Verification

Call `list_sequence_tracks` on the new sequence and confirm:

- expected video clip count and audio clip count;
- video/audio start and end points match the assembled cursor;
- `linkAudio` was preserved;
- the source media path is correct.

Then call `validate_project_for_export` with `requireNonEmptyTimeline=true` and `checkGaps=true`. A successful result should report no errors, `offlineMediaCount=0`, and `gapCount=0`. Missing `outputPath` or preset warnings are expected when the user did not ask for export; they do not mean the edit failed.

## 8. Save and export policy

- `save_project` overwrites the currently open `.prproj`; ask immediately before using it, even if the edit itself was approved.
- If the user supplies a new project path, use the CEP Save As operation if available and refuse an existing target unless the user explicitly authorizes replacement.
- For an MP4, ask for an output path and preset (or confirm an existing local `.epr` preset), run `validate_project_for_export` with those paths, then use the CEP export/render tool. Do not use FFmpeg to bypass Premiere when the user asked for Premiere editing.
- Report “sequence created but not saved/exported” when those operations were not requested or were rejected.
