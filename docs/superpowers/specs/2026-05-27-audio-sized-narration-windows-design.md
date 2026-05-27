# Audio-sized narration windows — make `narrate()` + `waitForNarration()` work without `autoWait`

**Status:** design
**Date:** 2026-05-27

## Problem

The intended fast-trace narration workflow is:

```ts
await narrate('Now we create a schema.')
await click(someButton)        // optional, small
await waitForNarration()       // hold here until the line is done speaking
await narrate('Next line.')
```

The author does **not** use `autoWait`, so the test runs at near real-time with only small waits. `narrate()` and `waitForNarration()` are empty `test.step()` calls that resolve instantly, so the trace window between a `narrate()` and its bounding `waitForNarration()` (or the next `narrate()`) collapses to ~0–80 ms.

With voiceover (TTS) enabled, this pattern produces **no narration at all** — the audio is silent and no subtitle text shows for those lines. Two guards discard the line before the renderer's freeze/`tpad` machinery can size it from the audio:

1. **`src/pipeline/narration-subtitles.ts`** — `buildNarrationSubtitles` drops any subtitle where `endMs <= startMs`. A zero-width window never becomes a subtitle, so voiceover never synthesizes it.
2. **`src/voiceover/voiceover-processor.ts`** — the assembly loop has `if (windowDuration < 100) { cursor = subtitle.endMs }`. For windows under 100 ms it advances the cursor but **never pushes the audio segment and never records a freeze**, silently dropping that line's audio and any hold.

The root mismatch: the system sizes a narration from its **trace window**, but this workflow wants the **audio length** to size it, with `waitForNarration()` marking where to freeze. The machinery to do that already exists (the overflow branch stretches `endMs` to the audio length and emits a freeze; the renderer applies per-freeze `tpad` holds and an end-of-video `tpad`). These two guards short-circuit before reaching it.

## Goal

Make the `narrate()` → (optional small clicks) → `waitForNarration()` pattern work with voiceover and **without** `autoWait`:

- The narration audio plays in full.
- The subtitle text shows for the audio's duration.
- The video freezes at the `waitForNarration()` boundary so the audio finishes before subsequent visuals/audio — the audio does not pass the boundary.

Lean entirely on the existing freeze + end-of-video `tpad` machinery; the fix is about not discarding these lines before they reach it.

## Non-goals

- **No-voiceover (subtitle-only) fast-trace support.** Without TTS there is no audio to size a zero-width line; that path still needs `autoWait` / `pace()`. This design preserves today's no-voiceover behavior exactly (those lines remain effectively absent), it does not add a text-length duration estimate (considered as "Approach 2" and declined for YAGNI).
- Changing behavior for narrations that already have a positive window (e.g. `narrate()` with real clicks/waits before `waitForNarration()`). Those already work via the overflow branch and are unaffected.
- Changing the approach-hold (`click()` cursor-glide) accounting in `voiceover-processor`.
- Changing `narrate()` / `waitForNarration()` helper semantics or the trace marker format.

## Approach (chosen: minimal — fix the two guards, drop empties after voiceover)

Let the audio length define the narration's duration. Stop discarding zero-width lines at build time; let voiceover stretch them; drop anything still empty only at burn time.

### 1. `src/pipeline/narration-subtitles.ts`

`buildNarrationSubtitles` keeps every narration that has text, even when its trace window is `<= 0`. Replace the drop with a clamp so an inverted window can never be emitted:

```ts
const next = actions[i + 1]
const startMs = timeRemap(current.startTime)
const rawEndMs = next ? timeRemap(next.startTime) : traceEndMs
// Keep the line even when its trace window is ~0 (fast trace + waitForNarration);
// clamp so we never emit an inverted window. Voiceover stretches it to the audio
// length; lines still at zero duration are dropped before burn-in (no-voiceover).
const endMs = Math.max(startMs, rawEndMs)

const text = current.title.slice(NARRATE_TITLE_PREFIX.length)
subtitles.push({
  index: subtitles.length + 1,
  startMs: Math.round(startMs),
  endMs: Math.round(endMs),
  text,
})
```

Update the function's doc comment, which currently states "Subtitles with non-positive duration are dropped."

Hidden-narrate and non-opening markers (`waitForNarration`) keep their current treatment — they bound neighbours but produce no subtitle of their own.

### 2. `src/voiceover/voiceover-processor.ts`

Delete the `if (windowDuration < 100) { cursor = subtitle.endMs }` branch. Tiny/zero windows then fall into the existing branches:

- **audio fits** (`audioDuration <= windowDuration`): push the segment, optional silence pad, advance the cursor — unchanged.
- **audio overflows** (`else`): push the segment, set `subtitle.endMs = subtitle.startMs + audioDuration`, record a freeze at `originalEndsMs[si]` (the `waitForNarration()` position, captured pre-shift) when there is a following subtitle, add the overflow to `timeShift` — unchanged.

For a zero-width window the audio always overflows, so the overflow branch runs: the audio is included, the subtitle stretches to the audio length, and the freeze lands at the boundary. `originalEndsMs[si] == originalStartsMs[si]` for a zero window, which is the correct hold point.

Window duration is always `>= 0`: the builder clamps it, and the loop shifts `startMs`/`endMs` by the same `timeShift`, so the window never goes negative. The approach-hold interleaving (`holds` / `holdIndex`), `timeShift`, padding, and freeze recording are untouched.

### 3. Output-time empty-line guard (`src/render/renderer.ts`)

Before chunking / burning / embedding subtitles, filter out entries still at `endMs <= startMs`:

```ts
const renderableSubtitles = (trace.subtitles ?? []).filter((s) => s.endMs > s.startMs)
```

Use this filtered list for the burn-in (ASS/SRT), the embedded-subtitle SRT, and the chunking input. With voiceover, every line has been stretched to `> 0`, so this removes nothing in that path; it only drops genuinely empty lines on the **no-voiceover** path — exactly the lines `buildNarrationSubtitles` used to drop at build time. Net no-voiceover behavior is unchanged.

## Data flow (worked example)

`narrate('Now we create a schema.')` → fast `click()` → `waitForNarration()`, TTS on, audio = 2.4 s, window ≈ 40 ms:

1. Builder keeps the line: `{ startMs: T, endMs: T+40 }` (was dropped).
2. Voiceover: `windowDuration = 40`, `audioDuration = 2400` → overflow branch. Audio placed; `endMs = T + 2400`; freeze `{ atVideoMs: originalEndsMs = T+40, durationMs: 2360 }`; `timeShift += 2360`.
3. Renderer applies the freeze: holds the frame at ~T+40 for 2.36 s, shifts later clicks/cursor/subtitles by 2.36 s. Audio finishes before the next line begins.
4. Final line of a scenario (no following subtitle): no freeze is emitted; the existing end-of-video `tpad` extends the video to the total audio length.

## Edge cases

- **Final `narrate()` → `waitForNarration()` at end of scenario** — last subtitle, `nextOriginalStartMs` undefined → overflow branch sets `endMs` but emits no freeze; end-of-video `tpad` covers it. Already-correct, now reachable.
- **Back-to-back `narrate()` with no `waitForNarration()` and no gap** — each line's window is ~0; they chain correctly via `timeShift` (each freezes for its audio, next shifts), so all play in full.
- **Short window where audio actually fits** (e.g. 200 ms window, 150 ms audio) — fits branch, plays with a small pad, no freeze. Unchanged; previously dropped if `< 100`.
- **No voiceover + zero window** — line kept through build, stretched by nobody, removed by the output guard. Equivalent to today (invisible).

## Files touched

- `src/pipeline/narration-subtitles.ts` — keep zero-width narrations; clamp `endMs`; update doc comment.
- `src/voiceover/voiceover-processor.ts` — remove the `windowDuration < 100` early-skip.
- `src/render/renderer.ts` — filter `endMs <= startMs` subtitles before chunk/burn/embed.

## Testing

- `tests/unit/pipeline/subtitles-from-trace.test.ts` (or `narration-subtitles.test.ts`) — a `narrate()` immediately followed by `waitForNarration()` (zero window) now produces a subtitle (`startMs == endMs`), not a drop; a `narrate()` → `narrate()` zero window likewise produces a subtitle.
- `tests/unit/voiceover/freezes.test.ts` — drive `generateVoiceover` with the existing sine-buffer stub provider:
  - Zero / sub-100 ms window + audio overflow → the audio segment is **included** in the assembled track, the subtitle's `endMs` is stretched to the audio length, a freeze is recorded at the boundary, and the next subtitle's `startMs` is shifted by the overflow. (Previously: audio dropped, no freeze.)
  - Normal positive-window case still behaves as before (regression guard).
- A small test that the output guard excludes a still-zero-duration subtitle from burn-in (renderer-level or a focused filter check).
- Manual: re-render the demo trace with the `narrate → click() → waitForNarration()` pattern (TTS on); confirm audio + subtitles are present and in sync, and that audio does not bleed past each `waitForNarration()` boundary.

## Out of scope

- Text-length duration estimate for the no-voiceover fast-trace path (Approach 2).
- Configurable freeze padding ("breathing room" after a line ends).
- Precise mid-narration audio splitting (already out of scope for approach holds).
