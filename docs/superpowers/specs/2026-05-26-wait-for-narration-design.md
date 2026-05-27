# `waitForNarration()` — explicit audio-finish freeze marker

**Status:** design  
**Date:** 2026-05-26

## Problem

`narrate()` records narration text into the trace as a marker step. Later, the pipeline maps each marker to a subtitle whose window runs from that marker to the next `narrate()` marker (or end of trace). When the synthesised audio is longer than its subtitle's window, `voiceover-processor.ts` inserts a "freeze" — the renderer holds the last frame at the next subtitle's start position until the audio finishes.

That works when narrations come in close succession, but offers no way to say *"hold here, let the previous line finish speaking, then continue"* at an arbitrary point in the test — e.g., after a click that should not be talked over, or before a deliberate visual pause.

There is also a rendering wart: when a freeze is applied, the click ripple animation and cursor that were baked into the frame freeze with it. The cursor stays glued mid-air; click ripples stutter. The wait pause looks like a hang rather than a deliberate beat.

## Goal

Provide a test-side helper that marks an explicit "wait for previous narration audio to finish" point in the trace, and make the rendered freeze look natural — cursor continues to move, click ripples animate independently.

## Non-goals

- Real-time pacing of the test run. `narrate(text, { autoWait: true })` already covers that case; this helper is purely a renderer-side marker.
- Waiting on something other than narration audio (e.g., highlight duration, fixed sleep) — those should use `pace()` or their own mechanism.
- Changing default behaviour when no `waitForNarration` marker is present. Existing tests render unchanged.

## API

```ts
import { waitForNarration } from 'playwright-recast'

await narrate('Click the submit button')
await page.click('button[type=submit]')
await waitForNarration()        // ← freeze here until "Click the submit button" audio is done
await page.click('a.next-step')
```

- Resolves immediately at test time (no real-time wait, no `setTimeout`).
- Emits one `test.step` titled `__recast_wait_for_narration__` with an empty body, so it lands in the trace zip as a marker action.
- Pushes **no** `voiceover` / `voiceover-hidden` annotations — the legacy report.json flat-index contract for `narrate()` is unaffected.
- No-ops cleanly when `setupRecast(test)` has not been called (same defensive pattern as the other helpers — only the `info()` lookup throws).

A new export `WAIT_FOR_NARRATION_TITLE_PREFIX = '__recast_wait_for_narration__'` sits alongside the existing prefixes in `src/helpers.ts`. There is no per-call payload; the marker carries no JSON.

## Pipeline changes

### `subtitlesFromTrace` (`src/pipeline/executor.ts`)

When building subtitles from `narrate` marker steps, look for any `waitForNarration` markers in the trace. If the trace contains at least one such marker, each narrate's subtitle window ends at the **earliest** of:

1. The next `narrate` marker (existing behaviour), or
2. The next `waitForNarration` marker
3. End of trace

The "next user action" boundary discussed during design is **not** adopted. Tests should be free to put clicks and narrations next to each other without the renderer cutting audio short; the explicit `waitForNarration()` call is what tells the renderer "draw a hard boundary here."

When the trace contains no `waitForNarration` markers, subtitle-window assembly is byte-identical to today's behaviour.

### `voiceover-processor.ts`

No code changes. The existing overflow-freeze logic already does the right thing once subtitle windows are narrowed: if a narration's audio is longer than its window, a freeze is recorded at the next subtitle's start. That "next subtitle's start" position is now the `waitForNarration` marker's position, which is exactly where the freeze should happen.

If audio fits inside the narrowed window, no freeze is emitted — the marker becomes a no-op for that line. This is desirable: the helper only adds time when time is actually needed.

## Renderer changes

Current phase order in `renderer.ts`:

```
Phase 3     bake cursor overlay   (per-click appear/move/disappear via FFmpeg expression)
Phase 3.25  bake click ripples    (per-click ripple clip overlaid)
Phase 3.3   bake highlight overlays
Phase 3.5   apply zoom (crop+scale operating on a video with all overlays already baked)
Phase 3.6   apply voiceover freezes (tpad clone last frame at each freeze position),
            then mutate trace.clickEvents.videoTimeMs via shiftForFreezes
Phase 3.7   generate click sound track (uses already-shifted videoTimeMs)
Phase 4-5   final encode (audio merge + subtitle burn)
```

Cursor and click visuals share the same source of truth (per-click `videoTimeMs`/`videoTimeSec`) and their visibility windows are computed against the same time origin (see `expression-builder.ts`: cursor `APPEAR_BEFORE = 0.5s`, `MOVE_DURATION = 0.25s`, `VISIBLE_AFTER = 0.2s`). They must therefore live in the same render phase, on the same (post-freeze) timeline, otherwise the cursor approaches the *old* time while the ripple fires at the *shifted* time and the two desync.

Highlights are timed independently (each highlight has its own `videoTimeMs` + `duration`/`fadeOut`) and the user has accepted that they freeze with the frame.

### New phase order

```
Phase 3.3  bake highlight overlays                       (unchanged position; pre-freeze)
Phase 3.4  apply voiceover freezes                       (was Phase 3.6)
           → shift trace.clickEvents.videoTimeMs via shiftForFreezes
           → shift trace.cursorKeyframes.videoTimeSec via shiftForFreezes
Phase 3.45 bake cursor overlay  (was Phase 3)            (with shifted keyframes)
Phase 3.46 bake click ripples   (was Phase 3.25)         (with shifted videoTimeMs)
Phase 3.5  apply zoom                                     (unchanged)
Phase 3.7  generate click sound track                     (unchanged; already-shifted times)
```

Why this works:

- Highlight stays pre-freeze: bakes into the screencast, freezes with the frame during the wait, resumes after. Matches the user's accepted behaviour.
- Freeze runs before cursor + click, so both overlays compute against the freeze-extended timeline. The shared cursor↔click timing relationship (`APPEAR_BEFORE`, `MOVE_DURATION`, `VISIBLE_AFTER`) is preserved exactly because both timestamps are shifted by the same `shiftForFreezes`.
- Zoom still runs last (besides the click sound stage that touches audio only), so it crops a video with all visual overlays already baked — same invariant as today.

### Shift step (Phase 3.4)

After `applyVoiceoverFreezes`, do both shifts in a single block:

```ts
if (voiceoverFreezes.length > 0) {
  if (trace.clickEvents) {
    for (const ce of trace.clickEvents) {
      ce.videoTimeMs = shiftForFreezes(ce.videoTimeMs, voiceoverFreezes)
    }
  }
  if (trace.cursorKeyframes) {
    for (const kf of trace.cursorKeyframes) {
      kf.videoTimeSec = shiftForFreezes(kf.videoTimeSec * 1000, voiceoverFreezes) / 1000
    }
  }
}
```

`shiftForFreezes` already does the "shift only when at-or-after the freeze position" check, so clicks/keyframes that sit *before* a freeze keep their original time, and ones *after* are pushed forward by the cumulative freeze duration up to that point.

### Net rendered behaviour

- Cursor is hidden between clicks (existing per-click visibility model), so it does not "drift mid-air during a freeze" — the question doesn't apply.
- Just before each click on the shifted timeline, the cursor's appear/move animation runs over the unfrozen source frame (Phase 3.45 bakes after the freeze, so the cursor sits on top of either the live source or the cloned freeze frame — but the visibility window is centred on the *shifted* click time, which is always past the freeze).
- The click ripple fires at the shifted click time, in sync with the cursor arriving — identical to the no-freeze rendering, just on a stretched timeline.
- No keyframe-insertion / hold-keyframe logic is needed. The shift-only approach is enough because cursor visibility is per-click, not continuous.

## Tests

- `tests/unit/helpers/wait-for-narration.test.ts`
  - Emits a single marker `test.step` with the correct prefix
  - Does not push voiceover annotations
  - Does not block at test time (elapsed < 50ms)
  - No-ops gracefully when `setupRecast` has not been called for the step-binding case (consistent with other helpers)

- `tests/unit/pipeline/subtitles-from-trace.test.ts` (extend existing, or add new file)
  - With no `waitForNarration` markers: behaviour unchanged
  - With a `waitForNarration` marker between two `narrate` markers: first subtitle's `endMs` equals the marker's `startTime` (remapped)
  - With a `waitForNarration` marker after the last `narrate`: subtitle's `endMs` equals the marker, not end-of-trace

- `tests/unit/voiceover/freezes.test.ts` (extend if it exists; otherwise add)
  - `waitForNarration` marker + audio overflow → freeze emitted at the marker's video position
  - `waitForNarration` marker + audio fits in window → no freeze

End-to-end renderer behaviour (cursor and click ripple still in sync after a freeze, highlights pause with the frame) is verified manually with the demo trace; no fixture-based ffmpeg test is added.

## Files touched

- `src/helpers.ts` — add `waitForNarration`, export `WAIT_FOR_NARRATION_TITLE_PREFIX`
- `src/index.ts` — re-export
- `src/pipeline/executor.ts` — extend `subtitlesFromTrace` boundary logic
- `src/render/renderer.ts` — reorder phases per "New phase order" section: highlight first, then freezes + shift, then cursor and click ripples (both on shifted timeline), then zoom
- Tests as listed above

## Open questions

None for this round.

## Out of scope

- Configurable freeze padding (e.g., "give the audio +200ms of breathing room after it ends"). Existing `voiceover-processor` math gives zero padding; add later if needed.
- Visualising the wait in the studio recorder UI. Marker is invisible there until someone explicitly surfaces it.
