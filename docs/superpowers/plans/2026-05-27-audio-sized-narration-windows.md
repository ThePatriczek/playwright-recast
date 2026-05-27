# Audio-sized Narration Windows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `narrate()` → (optional small clicks) → `waitForNarration()` pattern work with voiceover and without `autoWait`, so each narration's audio plays in full, its subtitle shows for the audio's duration, and the video freezes at the boundary.

**Architecture:** A narration's duration should come from its audio length, not its (near-zero on a fast trace) trace window. Three changes: (1) stop dropping zero-width narration lines when building subtitles, (2) remove the `windowDuration < 100` early-skip in the voiceover assembler so tiny windows flow into the existing overflow path (which already plays the audio, stretches the subtitle, and emits a freeze), (3) add a render-time guard that drops any line still zero-duration before burn-in, preserving today's no-voiceover behavior.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest (`vitest run`), ffmpeg/ffprobe (used by the voiceover processor and its tests).

---

## Reference: spec

Design spec: `docs/superpowers/specs/2026-05-27-audio-sized-narration-windows-design.md`

## File Structure

- `src/pipeline/narration-subtitles.ts` — **modify.** `buildNarrationSubtitles` keeps zero-width lines instead of dropping them.
- `src/voiceover/voiceover-processor.ts` — **modify.** Remove the `windowDuration < 100` branch from the assembly loop.
- `src/subtitles/renderable.ts` — **create.** Pure helper `filterRenderableSubtitles` (one responsibility: drop non-positive-duration cues). Kept separate so it is unit-testable without running the renderer/ffmpeg.
- `src/render/renderer.ts` — **modify.** Use `filterRenderableSubtitles` for the burn/embed subtitle block only (NOT the zoom reads at lines ~606 and ~726).
- `tests/unit/pipeline/subtitles-from-trace.test.ts` — **modify.** Replace the "drops non-positive duration" test with a "keeps zero-width narrations" test.
- `tests/unit/voiceover/freezes.test.ts` — **modify.** Add a tiny-window-overflow test.
- `tests/unit/subtitles/renderable.test.ts` — **create.** Unit-test the new helper.

---

## Task 1: Keep zero-width narrations in `buildNarrationSubtitles`

**Files:**
- Modify: `src/pipeline/narration-subtitles.ts`
- Modify (test): `tests/unit/pipeline/subtitles-from-trace.test.ts`

- [ ] **Step 1: Update the existing test to assert the new (keep) behavior**

In `tests/unit/pipeline/subtitles-from-trace.test.ts`, find this test (near the end of the `describe('buildNarrationSubtitles', ...)` block):

```ts
  it('drops subtitles with non-positive duration', () => {
    const actions = [
      mkNarrate(`${NARRATE_TITLE_PREFIX}A`, 5000),
      mkNarrate(`${NARRATE_TITLE_PREFIX}B`, 5000),
    ]
    const subs = buildNarrationSubtitles(actions, identity, 10_000)
    expect(subs).toEqual([{ index: 1, startMs: 5000, endMs: 10_000, text: 'B' }])
  })
```

Replace it entirely with:

```ts
  it('keeps zero-width narrations (voiceover/renderer size them downstream)', () => {
    // On a fast trace (no autoWait), a narrate() immediately followed by another
    // narrate()/waitForNarration() collapses the window to ~0. The line must be
    // kept (clamped, never inverted) so voiceover can later stretch it to the
    // audio length; the renderer drops any still-zero-duration line before burn-in.
    const actions = [
      mkNarrate(`${NARRATE_TITLE_PREFIX}A`, 5000),
      mkNarrate(`${NARRATE_TITLE_PREFIX}B`, 5000),
    ]
    const subs = buildNarrationSubtitles(actions, identity, 10_000)
    expect(subs).toEqual([
      { index: 1, startMs: 5000, endMs: 5000, text: 'A' },
      { index: 2, startMs: 5000, endMs: 10_000, text: 'B' },
    ])
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/pipeline/subtitles-from-trace.test.ts`
Expected: FAIL on the new test — current code drops line `A`, so it returns only one entry (`text: 'B'`, `index: 1`) instead of the two expected entries.

- [ ] **Step 3: Change the builder to clamp instead of drop**

In `src/pipeline/narration-subtitles.ts`, find:

```ts
    const next = actions[i + 1]
    const startMs = timeRemap(current.startTime)
    const endMs = next ? timeRemap(next.startTime) : traceEndMs
    if (endMs <= startMs) continue

    const text = current.title.slice(NARRATE_TITLE_PREFIX.length)
```

Replace with:

```ts
    const next = actions[i + 1]
    const startMs = timeRemap(current.startTime)
    const rawEndMs = next ? timeRemap(next.startTime) : traceEndMs
    // Keep the line even when its trace window is ~0 (fast trace + a near-
    // immediate waitForNarration() / next narrate()). Clamp so we never emit an
    // inverted window. Voiceover stretches such a line to its audio length and
    // freezes at the boundary; lines still at zero duration after voiceover (or
    // with no voiceover) are dropped before burn-in by the renderer.
    const endMs = Math.max(startMs, rawEndMs)

    const text = current.title.slice(NARRATE_TITLE_PREFIX.length)
```

Then update the JSDoc bullet at the top of the same function. Find:

```ts
 * - Subtitles with non-positive duration are dropped.
 */
```

Replace with:

```ts
 * - A narration whose trace window is non-positive is kept with `endMs` clamped
 *   to `startMs` (zero duration); voiceover later sizes it from the audio, and
 *   the renderer drops any still-zero-duration line before burn-in.
 */
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/pipeline/subtitles-from-trace.test.ts`
Expected: PASS (all tests in the file, including the rewritten one).

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/narration-subtitles.ts tests/unit/pipeline/subtitles-from-trace.test.ts
git commit -m "fix(subtitles): keep zero-width narration windows for audio sizing

buildNarrationSubtitles no longer drops a narrate() whose trace window
collapsed to ~0 (fast trace + waitForNarration without autoWait). The line
is clamped (never inverted) and kept so voiceover can stretch it to the
audio length downstream.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Remove the `windowDuration < 100` early-skip in `generateVoiceover`

**Files:**
- Modify: `src/voiceover/voiceover-processor.ts`
- Modify (test): `tests/unit/voiceover/freezes.test.ts`

- [ ] **Step 1: Add a failing test for the tiny-window overflow case**

In `tests/unit/voiceover/freezes.test.ts`, add this test inside the `describe('generateVoiceover freeze emission ...')` block, immediately after the existing test `it('audio longer than narrowed window emits a freeze at the window end', ...)` (i.e. after its closing `})`):

```ts
  it('zero/sub-100ms window with overflow still plays audio and freezes (no-autoWait pattern)', async () => {
    // narrate() immediately followed by waitForNarration() on a fast trace:
    // the window is ~0 (here 40ms). The line must NOT be dropped — its audio
    // plays, the subtitle stretches to the audio length, and the video freezes
    // at the boundary. Previously the windowDuration<100 guard dropped it.
    const longAudio = makeSineBuffer(4)
    const shortAudio = makeSineBuffer(1)
    const provider = makeProvider([longAudio, shortAudio])
    const trace: SubtitledTrace = {
      subtitles: [
        { index: 1, startMs: 0, endMs: 40, text: 'first', ttsText: undefined },
        { index: 2, startMs: 100, endMs: 2100, text: 'second', ttsText: undefined },
      ],
    } as unknown as SubtitledTrace
    const tmp = path.join(TMP_ROOT, 'tiny-window-overflow')

    const result = await generateVoiceover(trace, provider, tmp)

    // A freeze is recorded at the boundary (40ms) — previously: none.
    expect(result.voiceover.freezes).toHaveLength(1)
    expect(result.voiceover.freezes![0]!.atVideoMs).toBe(40)
    expect(result.voiceover.freezes![0]!.durationMs).toBeGreaterThan(3500)
    // First subtitle is stretched to ~the audio length, not the 40ms window.
    expect(result.voiceover.entries[0]!.outputEndMs).toBeGreaterThan(3500)
    // Second line is pushed back by the overflow.
    expect(result.voiceover.entries[1]!.outputStartMs).toBeGreaterThan(3500)
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/voiceover/freezes.test.ts -t "no-autoWait pattern"`
Expected: FAIL — current code takes the `windowDuration < 100` branch, so `result.voiceover.freezes` is empty (length 0, not 1) and `entries[0].outputEndMs` is 40, not > 3500.

- [ ] **Step 3: Remove the early-skip branch**

In `src/voiceover/voiceover-processor.ts`, find:

```ts
    const audioDuration = getAudioDurationMs(segPath)
    const windowDuration = subtitle.endMs - subtitle.startMs

    if (windowDuration < 100) {
      cursor = subtitle.endMs
    } else if (audioDuration <= windowDuration) {
      segmentFiles.push(segPath)
      const pad = windowDuration - audioDuration
      if (pad > 50) {
        const padPath = path.join(tmpDir, `pad-${subtitle.index}.mp3`)
        generateSilence(pad, padPath)
        segmentFiles.push(padPath)
      }
      cursor = subtitle.endMs
    } else {
```

Replace with (drop the first branch; the fits-case becomes the leading `if`):

```ts
    const audioDuration = getAudioDurationMs(segPath)
    const windowDuration = subtitle.endMs - subtitle.startMs

    // A tiny/zero window (fast trace + waitForNarration, no autoWait) falls
    // through to the overflow branch below: the audio plays, the subtitle
    // stretches to the audio length, and a freeze is recorded at the window
    // end (the waitForNarration position). windowDuration is always >= 0 —
    // the builder clamps it and the loop shifts start/end by the same amount.
    if (audioDuration <= windowDuration) {
      segmentFiles.push(segPath)
      const pad = windowDuration - audioDuration
      if (pad > 50) {
        const padPath = path.join(tmpDir, `pad-${subtitle.index}.mp3`)
        generateSilence(pad, padPath)
        segmentFiles.push(padPath)
      }
      cursor = subtitle.endMs
    } else {
```

Leave the entire `else { ... }` overflow block below it unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/voiceover/freezes.test.ts`
Expected: PASS for all tests in the file (the new tiny-window test plus the existing overflow/fit/approach-hold tests, which are unaffected because they use windows ≥ 1000ms).

- [ ] **Step 5: Commit**

```bash
git add src/voiceover/voiceover-processor.ts tests/unit/voiceover/freezes.test.ts
git commit -m "fix(voiceover): drop windowDuration<100 skip that silenced fast-trace narrations

The <100ms early-skip advanced the cursor without adding the audio segment or
recording a freeze, so a narrate()+waitForNarration() line on a fast trace was
silently dropped. Tiny/zero windows now fall into the existing overflow path:
audio plays, the subtitle stretches to the audio length, and a freeze is
emitted at the waitForNarration boundary.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Render-time guard that drops still-zero-duration subtitles before burn-in

**Files:**
- Create: `src/subtitles/renderable.ts`
- Create (test): `tests/unit/subtitles/renderable.test.ts`
- Modify: `src/render/renderer.ts`

- [ ] **Step 1: Write the failing test for the helper**

Create `tests/unit/subtitles/renderable.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { filterRenderableSubtitles } from '../../../src/subtitles/renderable'
import type { SubtitleEntry } from '../../../src/types/subtitle'

describe('filterRenderableSubtitles', () => {
  it('drops zero- and negative-duration entries, keeps positive ones', () => {
    const subs: SubtitleEntry[] = [
      { index: 1, startMs: 0, endMs: 0, text: 'zero' },
      { index: 2, startMs: 100, endMs: 2000, text: 'keep' },
      { index: 3, startMs: 5000, endMs: 5000, text: 'also zero' },
    ]
    expect(filterRenderableSubtitles(subs)).toEqual([
      { index: 2, startMs: 100, endMs: 2000, text: 'keep' },
    ])
  })

  it('returns all entries when every window is positive', () => {
    const subs: SubtitleEntry[] = [
      { index: 1, startMs: 0, endMs: 1000, text: 'a' },
      { index: 2, startMs: 1000, endMs: 2000, text: 'b' },
    ]
    expect(filterRenderableSubtitles(subs)).toEqual(subs)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/subtitles/renderable.test.ts`
Expected: FAIL — module `src/subtitles/renderable` does not exist yet (import/resolution error).

- [ ] **Step 3: Create the helper**

Create `src/subtitles/renderable.ts`:

```ts
import type { SubtitleEntry } from '../types/subtitle.js'

/**
 * Keep only subtitles with a positive duration. Narration lines whose trace
 * window collapsed to ~0 (fast trace + waitForNarration(), no autoWait) are
 * kept through subtitle assembly so voiceover can stretch them to the audio
 * length. When there is no voiceover to size them they stay zero-duration and
 * must not be written to the burned/embedded subtitle track — an SRT/ASS cue
 * with start == end is degenerate. This is the render-time gate that drops
 * them, matching the old build-time drop but applied after voiceover.
 */
export function filterRenderableSubtitles(
  subtitles: ReadonlyArray<SubtitleEntry>,
): SubtitleEntry[] {
  return subtitles.filter((s) => s.endMs > s.startMs)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/subtitles/renderable.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Wire the helper into the renderer's burn/embed block (only)**

In `src/render/renderer.ts`:

(a) Add the import next to the existing subtitle imports. Find:

```ts
import { writeSrt } from '../subtitles/srt-writer.js'
import { writeAss } from '../subtitles/ass-writer.js'
import { chunkSubtitles } from '../subtitles/subtitle-chunker.js'
```

Replace with:

```ts
import { writeSrt } from '../subtitles/srt-writer.js'
import { writeAss } from '../subtitles/ass-writer.js'
import { chunkSubtitles } from '../subtitles/subtitle-chunker.js'
import { filterRenderableSubtitles } from '../subtitles/renderable.js'
```

(b) Introduce the filtered list just before the embed block. Find:

```ts
  const embedOpt = config.embedSubtitles
  const wantEmbed = !!embedOpt && trace.subtitles && trace.subtitles.length > 0
```

Replace with:

```ts
  // Drop narration lines still at zero duration (no voiceover sized them) so we
  // never write a degenerate SRT/ASS cue. NOTE: the zoom reads on
  // `trace.subtitles` above (the `hasZoom` check and the zoom application block)
  // are intentionally left on the full list.
  const renderableSubtitles = filterRenderableSubtitles(trace.subtitles ?? [])

  const embedOpt = config.embedSubtitles
  const wantEmbed = !!embedOpt && renderableSubtitles.length > 0
```

(c) Use it for the embed entries. Find:

```ts
    const embedEntries = config.subtitleStyle?.chunkOptions
      ? chunkSubtitles(trace.subtitles!, config.subtitleStyle.chunkOptions)
      : trace.subtitles!
```

Replace with:

```ts
    const embedEntries = config.subtitleStyle?.chunkOptions
      ? chunkSubtitles(renderableSubtitles, config.subtitleStyle.chunkOptions)
      : renderableSubtitles
```

(d) Use it for the burn-in guard and entries. Find:

```ts
  if (config.burnSubtitles && trace.subtitles && trace.subtitles.length > 0) {
    if (config.subtitleStyle) {
      // Styled subtitles via ASS format (background box, custom font, etc.)
      let burnEntries = trace.subtitles
```

Replace with:

```ts
  if (config.burnSubtitles && renderableSubtitles.length > 0) {
    if (config.subtitleStyle) {
      // Styled subtitles via ASS format (background box, custom font, etc.)
      let burnEntries = renderableSubtitles
```

(e) Use it for the plain-SRT burn path. Find:

```ts
      const srtPath = path.join(tmpDir, 'burn-subtitles.srt')
      fs.writeFileSync(srtPath, writeSrt(trace.subtitles))
```

Replace with:

```ts
      const srtPath = path.join(tmpDir, 'burn-subtitles.srt')
      fs.writeFileSync(srtPath, writeSrt(renderableSubtitles))
```

Do NOT change the `trace.subtitles` reads used for zoom (the `hasZoom` computation and the zoom application block) — those must keep seeing the full list.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors). `renderableSubtitles` is `SubtitleEntry[]`, so the previous `trace.subtitles!` non-null assertions are no longer needed at these sites.

- [ ] **Step 7: Commit**

```bash
git add src/subtitles/renderable.ts tests/unit/subtitles/renderable.test.ts src/render/renderer.ts
git commit -m "fix(render): drop zero-duration subtitles before burn-in

Add filterRenderableSubtitles and apply it to the renderer's burn/embed block
so narration lines kept through assembly (for audio sizing) are not written as
degenerate SRT/ASS cues when there is no voiceover to stretch them. Zoom reads
on trace.subtitles are intentionally left untouched.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit test suite**

Run: `npm test`
Expected: PASS — all existing tests plus the three added/updated ones. No regressions.

- [ ] **Step 2: Typecheck the whole project**

Run: `npm run typecheck`
Expected: PASS with no errors.

- [ ] **Step 3: Manual end-to-end check (records the result, no code change)**

Drive a small trace through the real pipeline with the target pattern and voiceover enabled — e.g. a test/scenario containing:

```ts
await narrate('Now we create a schema.')
await click(page.getByRole('button', { name: 'Create' }))
await waitForNarration()
await narrate('And here is the result.')
await waitForNarration()
```

Render it (with `.cursorOverlay()`/`.clickEffect()` and a `.voiceover(...)` provider) and confirm in the output video:
- Both narration lines are audible and their subtitles appear (they are no longer missing).
- Each line's subtitle stays on screen for roughly the spoken duration.
- The video freezes at each `waitForNarration()` until the line finishes; audio does not bleed past the boundary onto the next click/line.

If any of these fail, capture the observed vs. expected behavior and stop for review rather than marking the plan complete.

---

## Notes for the implementer

- ESM import specifiers in `src/**` use the `.js` extension even for `.ts` files (e.g. `'../types/subtitle.js'`). Test files import from `src` without the extension (e.g. `'../../../src/subtitles/renderable'`), matching the existing tests.
- `tests/unit/voiceover/freezes.test.ts` shells out to real `ffmpeg`/`ffprobe`; mp3 encoder padding means audio durations are approximate, which is why the new assertions use `toBeGreaterThan` ranges rather than exact values (consistent with the existing tests in that file).
- Run tasks in order: Task 1 and Task 2 are independent of each other, but both are needed before the manual check in Task 4 will pass. Task 3 preserves no-voiceover behavior and is independent of 1 and 2.
