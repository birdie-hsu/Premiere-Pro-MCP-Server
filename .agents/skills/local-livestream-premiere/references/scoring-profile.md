# Local highlight scoring profile

The local fallback uses transparent, local-only signals. Scores prioritize candidates; they are not semantic truth.

## Enabled signals

Analysis produces one-second evidence bins:

| Field | Meaning | Use |
|---|---|---|
| `transcriptSignal` | Timestamped cue coverage, speaking rate, excitement terms, and punctuation | Primary semantic evidence |
| `audioEnergy` | RMS/peak energy normalized against the video's robust baseline | Sustained intensity |
| `audioBurst` | Short-term RMS rise against a rolling local median/MAD baseline | Sudden reactions, impacts, or applause |
| `sceneBoundary` | A scene-change timestamp mapped to its nearest second | Candidate starts/ends and visual transitions |
| `motionEnergy` | Low-resolution frame-to-frame change normalized within the video | Weak visual-supporting evidence |

The analysis JSON reports the enabled signal names and the path to the local `signal-timeline.json` artifact. Candidate evidence should expose the same signals, plus event/peak counts where available.

## Scoring policy

- Transcript candidates combine audio, transcript, scene-boundary, and low-weight motion evidence.
- Candidates without transcript use audio, scene-boundary, and motion evidence only.
- Scene boundaries are a small boundary-fit term; they are not treated as proof of a highlight.
- Motion is deliberately low-weight because pixel change can represent a camera move, transition, overlay, or gameplay change rather than a meaningful action.
- Audio bursts are relative to the same video's local level. Do not replace this with a universal `-20 dBFS` rule.
- Audio peak and audio burst belong to one audio evidence family. Do not count them as two independent modalities for a multi-signal boost.
- Objects/actions are disabled unless the user or content profile supplies explicit labels and the required local detector is available.

The current implementation uses these weights. The agent must not recalculate or
replace the returned score; this table is for explaining a result.

With transcript evidence:

~~~text
score = 100 * (
  audioEnergy * 0.22 + audioBurst * 0.08 + excitement * 0.30 +
  speechDensity * 0.13 + speakingRate * 0.07 + sceneScore * 0.06 +
  sceneBoundary * 0.04 + punctuation * 0.05 + motionEnergy * 0.05
)
~~~

Without transcript evidence:

~~~text
score = 100 * (
  audioEnergy * 0.43 + audioBurst * 0.17 + sceneScore * 0.18 +
  sceneBoundary * 0.08 + motionEnergy * 0.14
)
~~~

For the small Hermes model, copy the score from result.candidates and copy its
evidence. Do not make a second score from the transcript or from video_context
search results.

## Selection and review

Generate candidate starts from audio peaks, transcript cues, and scene boundaries, then rank fixed windows with transparent evidence and reject excessive overlap. When a natural-length selector is available, merge nearby evidence regions, constrain minimum/maximum duration, and rank by score density before applying the non-overlap/coverage rule.

Always present source timestamps, duration, score, reason, quote or visual cue, and evidence limitations. Do not infer a visual action from transcript/audio alone. Review candidates before any Premiere mutation.
