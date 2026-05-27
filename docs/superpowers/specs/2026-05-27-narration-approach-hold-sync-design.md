# Sync narration audio with click approach-holds

**Status:** design
**Date:** 2026-05-27

## Problem

The `click()` helper renders a click with a held cursor approach: the renderer inserts a hold (freeze, `approachMs` ≈ 500ms) at each marker-driven click so the cursor glides over a held, painted target. These approach holds are computed and applied in the **renderer** — they extend the video and shift click/cursor positions, but they do **not** touch the narration audio track or the subtitles.

Voiceover freezes (audio-overflow holds) stay in sync because `voiceover-processor` bakes their silence into the audio track and shifts subtitles, and the renderer applies the same freezes to the video. The approach holds bypass that machinery.

Result: each approach hold lengthens the video but not the audio, so after every held click the narration audio runs ahead of the video by the accumulated hold duration. Observed: in a trace with three approach-held clicks (~1.5s of holds) before the "Now we create a schema" narration, that narration is heard ~1.5s early — over the preceding dbDialog "Create" click instead of after it.

## Goal

Approach holds must extend the **audio and subtitles** in lockstep with the video, exactly as voiceover freezes do, so narration stays aligned with the visuals. Approach holds should be applied **once** per render (no double-counting).

## Non-goals

- Changing the cursor-approach visual behavior (the held glide is correct; only audio/subtitle sync is wrong).
- Changing voiceover-freeze behavior.
- Fixing the broader blank-lead-in / `videoStartOutput` coordinate handling — this design works within the existing (functioning) timeline conventions.

## Approach (chosen: A — handle in `voiceover-processor`)

Move approach-hold accounting into the same component that already keeps audio + subtitles + freezes consistent.

### Data flow (executor)

The `voiceover` stage (`executor.ts`) runs after `cursorOverlay`/`clickEffect` (so click markers + `cursorOverlayConfig.approachMs` exist) and *after* it blank-adjusts the subtitles. In that stage, before calling `generateVoiceover`:

1. Parse `__recast_click__` markers from the recording-context actions (reuse `parseClickMarkers`).
2. Build one approach hold per marker:
   - `atVideoMs = Math.round(speedMapped.timeRemap(marker.startTime)) − blankLeadInMs`
   - `durationMs = Math.round(cursorOverlayConfig.approachMs)` (default 500; if `cursorOverlay` was not configured, no approach holds)
   - Positions use the **same remap + blank-adjust the subtitles use**, so holds land in the subtitle/audio timeline. (Hold positions are deliberately derived from the markers via the subtitle formula, not from `cursorKeyframes` — those are not blank-adjusted yet at voiceover time.)
3. Pass the holds to `generateVoiceover(subtitled, provider, tmpDir, options, approachHolds)`.

`blankLeadInMs` is the same offset applied to the subtitles. Note the blank trim may be applied by either the render-prep case or the `voiceover` case, whichever runs first (guarded by `state._blankTrimApplied`), so the second one skips recomputing it. To make the offset reliably available for the hold computation, store it on the pipeline state (e.g. `state._blankLeadInMs`, default 0) when first computed, and read it in the `voiceover` case. When there is no `cursorOverlay`/no markers, `approachHolds` is empty and behavior is unchanged.

### `voiceover-processor` changes

`generateVoiceover` gains a 5th parameter `approachHolds?: Array<{ atVideoMs: number; durationMs: number }>` (positions in the same blank-adjusted subtitle timeline). It folds them into the existing assembly loop, which already walks subtitles in order, fills silence, pads/freezes on overflow, accumulates `timeShift`, mutates subtitle times, and records `VoiceoverFreeze[]`:

- Sort the approach holds by `atVideoMs`. Walk them alongside the subtitles: at the top of each subtitle iteration, drain every hold whose pre-shift `atVideoMs` is before that subtitle's pre-shift `startMs` — for each, `timeShift += durationMs` and record `{ atVideoMs: H, durationMs }` in `freezes`. After the loop, record any remaining (trailing) holds.
- Adding the hold's duration to `timeShift` before the subtitle is processed means the subtitle's existing **gap-fill silence** (`subtitle.startMs − cursor`, now larger by the hold) automatically lengthens by exactly the hold. No separate silence splice is needed — silence is silence, and what matters is that the next narration's audio starts at the correct shifted time. So spoken segments after a hold shift later by exactly the hold, and the recorded freeze drives the matching video hold + click/cursor shift in the renderer.
- **Holds in gaps** (the intended `waitForNarration` pattern, where clicks happen after a narration's window closes) are handled exactly: the gap is pure silence, so lengthening it is perfect.
- **A hold inside a narration's spoken window** (a click mid-sentence, no `waitForNarration`): its silence is lumped into the gap before the *next* narration rather than split into that narration's own audio. Subsequent narrations stay correctly aligned (`timeShift` accounts for it), but the narration the hold falls within isn't paused mid-word — its audio may run slightly ahead during the held frames and re-syncs at the next narration. Precise mid-segment splitting is out of scope (YAGNI; the intended pattern avoids it).

After this, the returned `voiceover.freezes` contains **both** overflow freezes and approach holds; the audio has silence for both; subtitles are shifted for both.

### Renderer changes

The renderer must not double-apply approach holds:

- **Voiceover present** (`trace.voiceover` exists): the approach holds are already in `trace.voiceover.freezes`. The renderer drops its own `cursorKeyframes.approach` → freeze computation and applies `trace.voiceover.freezes` to the video + shifts clicks/cursor via the existing `mergeFreezes` → `applyVoiceoverFreezes` → `shiftForFreezes` path. The audio already carries the matching silence.
- **No voiceover** (`trace.voiceover` undefined): there is no audio to sync, but the cursor approach should still play over a held frame. The renderer keeps its current fallback — compute approach holds from `cursorKeyframes.approach` and apply them to the video + clicks/cursor.

So exactly one component computes approach holds for a given render: `voiceover-processor` when there is voiceover, the renderer when there isn't.

`mergeFreezes` stays in the renderer (it still guards coincident entries within the unified freeze list). The marker cursor keyframes keep `autoWaitSec: 0` + `approach: true` (set in the `cursorOverlay` stage), so the full glide over the held frame is unchanged.

## Files touched

- `src/voiceover/voiceover-processor.ts` — `generateVoiceover` gains `approachHolds` param; assembly loop interleaves holds (silence + `timeShift` + recorded freeze).
- `src/pipeline/executor.ts` — `voiceover` case parses click markers, builds approach holds in the blank-adjusted subtitle timeline, passes them to `generateVoiceover`.
- `src/render/renderer.ts` — when `trace.voiceover` exists, do not recompute approach holds (they're in `voiceover.freezes`); keep the `cursorKeyframes.approach` computation only as the no-voiceover fallback.
- `src/types/voiceover.ts` — if helpful, a named type for the approach-hold entry (or reuse the `{ atVideoMs; durationMs }` shape already used by `VoiceoverFreeze`).

## Testing

- `tests/unit/voiceover/approach-holds.test.ts` (or extend `freezes.test.ts`) — drive `generateVoiceover` with a stub TTS provider (existing `makeSineBuffer` helper) and an `approachHolds` argument:
  - A hold between two subtitles → returned `voiceover.freezes` includes that hold at its `atVideoMs`; the second subtitle's `startMs` is shifted by `durationMs`; the assembled audio track is longer by `durationMs`.
  - No `approachHolds` (empty/omitted) → output identical to today (regression guard).
  - A hold plus an audio-overflow freeze → both appear in `freezes`, durations both reflected in subtitle shift + audio length.
- Renderer no-voiceover fallback and the with-voiceover path (video hold + audio sync) are verified by re-rendering the demo trace (the click-helper feature is already demo-verified); no fixture-based ffmpeg test is added, consistent with existing renderer testing.

## Out of scope

- Blank-lead-in / `videoStartOutput` coordinate unification.
- Precise mid-narration audio splitting. A hold within a narration's spoken window lumps its silence at the segment boundary; subsequent narrations stay aligned, the affected one may transiently run ahead. The intended `waitForNarration` pattern keeps holds in gaps, avoiding this.
