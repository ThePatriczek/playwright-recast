# Frame-boundary drift fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the remaining frame-boundary drift reported in #22 — in voiceover freezes, sub-frame speed segments, and audio concatenation — and add two opt-in flags for the changes that would otherwise alter working pipelines.

**Architecture:** Five independent workstreams. Three ship as plain bug fixes because they only change output that is broken today (W1 frame-indexed freezes, W2 sub-frame holds, W3 conditional audio normalisation). Two ship behind opt-in flags with today's behaviour as the default (W4 `speedUp({ exactBoundaries })`, W5 `autoZoom({ containInCue })`). Every workstream puts its arithmetic in a pure, exported, ffmpeg-free function following the `planSpeedSegments` / `planVoiceoverFreezes` precedent.

**Tech Stack:** TypeScript (ESM, NodeNext), Vitest (`globals: true`), ffmpeg/ffprobe via `execFileSync`.

**Spec:** `docs/superpowers/specs/2026-08-24-frame-boundary-drift-design.md`

## Global Constraints

- **Nothing may change for anyone not currently hitting a bug.** This outranks everything else. A fix may change rendered output only where that output is demonstrably wrong today; anything else goes behind an opt-in flag defaulting to today's behaviour.
- **The frame allocator is not touched.** `planSpeedSegments()` stays round-based, cumulative, exact-total, dropping zero-frame segments. Issue #22's `max(emittedFrames + 1, ceil(...))` proposal is rejected — measured to accumulate without bound.
- **Do not unify `probeVideoFps()` (`renderer.ts`) with `probeFps()` (`video-ops.ts`).** Their fallbacks differ deliberately (25 vs 30). Do not add a third fps probe either.
- Test imports omit the `.js` extension; `src/` imports include it. Tests import `describe`/`it`/`expect` from `'vitest'` explicitly.
- Baseline on this branch: **621 passed | 11 skipped (632)**. Measure, don't trust — another branch may have landed.
- Run `npm run typecheck && npm test` before every commit.

## The freeze-quantisation hazard — read before Task 1

This is the subtlety that makes W1 more than a mechanical change, and getting it
wrong silently desyncs every overlay.

`renderVideo()` builds `allFreezes` and passes the **same list** to two consumers:
`applyVoiceoverFreezes()` (which holds the video) and `shiftForFreezes()` (which
shifts every click and cursor keyframe). `planVoiceoverFreezes`'s own doc comment
warns about exactly this: if the video holds a different amount than the overlays
shift, they drift apart by the difference.

So frame-quantisation must happen **once, upstream of every consumer** — never
inside `planVoiceoverFreezes`. Quantising there would leave `shiftForFreezes`
using raw millisecond values while the video holds frame-rounded ones.

Upstream means `voiceover-processor.ts`, because that is where the freeze is born
*and* where the matching audio silence and subtitle shift are applied. Quantise
there and subtitles, audio, freezes, clicks and cursor all inherit the same
frame-aligned numbers for free. By the time the renderer sees a freeze it is
already on a frame boundary, and `planVoiceoverFreezes` converts to indices
without rounding anything.

The one exception is the no-voiceover path (`renderVideo`'s `approachFreezes`
fallback, `renderer.ts` — computed only `if (!trace.voiceover)`). There is no
audio or subtitle to stay in sync with, so quantising those in the renderer is
safe. Task 3 handles it.

## File Structure

| File | Responsibility | Workstream |
|---|---|---|
| `src/voiceover/frame-align.ts` *(new)* | Pure frame-alignment arithmetic for overflow points and freeze durations | W1 |
| `src/voiceover/voiceover-processor.ts` *(modify)* | Emits frame-aligned freezes; conditional audio concat | W1, W3 |
| `src/voiceover/audio-format.ts` *(new)* | Probe segment audio formats; pure planner deciding copy vs normalise | W3 |
| `src/render/renderer.ts` *(modify)* | Frame-indexed freeze slicing; sub-frame segment hold fallback; quantises approach freezes on the no-voiceover path | W1, W2 |
| `src/speed/sample-points.ts` *(new)* | Pure builder for the speed classifier's sampling points | W4 |
| `src/speed/speed-processor.ts` *(modify)* | Drives classification from the sample points | W4 |
| `src/render/zoom-expression.ts` *(modify)* | `containInCue` segment construction | W5 |
| `src/types/speed.ts` *(modify)* | `SpeedConfig.exactBoundaries` | W4 |
| `src/pipeline/stages.ts` *(modify)* | `AutoZoomConfig.containInCue` | W5 |
| `src/pipeline/executor.ts` *(modify)* | Threads fps into voiceover; threads `containInCue` into zoom config | W1, W5 |

Task order is dependency order within each workstream. **Workstreams are independent of each other and may be reordered**, except W1's two tasks and W4's two tasks and W5's two tasks, which are each strictly sequential.

---

### Task 1: Frame-alignment arithmetic

**Files:**
- Create: `src/voiceover/frame-align.ts`
- Test: `tests/unit/voiceover/frame-align.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `msPerFrame(fps: number): number`
  - `alignMsUpToFrame(ms: number, fps: number): number`
  - `alignFreezeToFrame(atVideoMs: number, durationMs: number, fps: number): { atVideoMs: number; durationMs: number }`

  Tasks 2 and 3 consume all three.

**Background:** the whole point is that no time is lost. When a freeze point is pushed forward to the next frame boundary, the video plays fractionally longer before the hold starts, so the hold must shrink by the same amount — otherwise the total shifts and every later cue moves. `alignFreezeToFrame` returns both adjusted numbers together so a caller cannot apply one and forget the other.

Guard `fps <= 0` by returning the inputs unchanged: `probeVideoFps` can only return a positive number today, but a future caller passing 0 must not produce `Infinity` timings.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/voiceover/frame-align.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { msPerFrame, alignMsUpToFrame, alignFreezeToFrame } from '../../../src/voiceover/frame-align'

describe('msPerFrame', () => {
  it('converts a frame rate to milliseconds per frame', () => {
    expect(msPerFrame(25)).toBe(40)
    expect(msPerFrame(50)).toBe(20)
  })
})

describe('alignMsUpToFrame', () => {
  it('leaves a value already on a frame boundary unchanged', () => {
    expect(alignMsUpToFrame(0, 25)).toBe(0)
    expect(alignMsUpToFrame(40, 25)).toBe(40)
    expect(alignMsUpToFrame(120, 25)).toBe(120)
  })

  it('pushes a value forward to the next frame boundary', () => {
    expect(alignMsUpToFrame(1, 25)).toBe(40)
    expect(alignMsUpToFrame(100, 25)).toBe(120)
    expect(alignMsUpToFrame(7025, 25)).toBe(7040)
  })

  it('never moves a value backwards', () => {
    for (const ms of [0, 1, 39, 40, 41, 999, 1000]) {
      expect(alignMsUpToFrame(ms, 25)).toBeGreaterThanOrEqual(ms)
    }
  })

  it('returns the input unchanged for a non-positive frame rate', () => {
    expect(alignMsUpToFrame(123, 0)).toBe(123)
    expect(alignMsUpToFrame(123, -5)).toBe(123)
  })
})

describe('alignFreezeToFrame', () => {
  it('moves the fractional remainder from the position into the duration', () => {
    // 100ms is 2.5 frames at 25fps; the hold starts 20ms later, so it must
    // be 20ms shorter for the following cue to land where it did.
    const r = alignFreezeToFrame(100, 500, 25)
    expect(r.atVideoMs).toBe(120)
    expect(r.durationMs).toBe(480)
    expect(r.atVideoMs + r.durationMs).toBe(620) // end position preserved
  })

  it('preserves the end position for every input', () => {
    for (const at of [0, 7, 33, 100, 7025]) {
      const r = alignFreezeToFrame(at, 1000, 25)
      expect(r.atVideoMs + r.durationMs).toBe(at + 1000)
    }
  })

  it('leaves an already-aligned freeze untouched', () => {
    const r = alignFreezeToFrame(120, 480, 25)
    expect(r).toEqual({ atVideoMs: 120, durationMs: 480 })
  })

  it('clamps the duration at zero rather than going negative', () => {
    // A 5ms hold at a position needing a 20ms push cannot absorb the shift.
    const r = alignFreezeToFrame(100, 5, 25)
    expect(r.atVideoMs).toBe(120)
    expect(r.durationMs).toBe(0)
  })

  it('returns inputs unchanged for a non-positive frame rate', () => {
    expect(alignFreezeToFrame(100, 500, 0)).toEqual({ atVideoMs: 100, durationMs: 500 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/voiceover/frame-align.test.ts`
Expected: FAIL — `Failed to resolve import ".../src/voiceover/frame-align"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/voiceover/frame-align.ts`:

```ts
/**
 * Frame-alignment arithmetic for voiceover freezes.
 *
 * Freeze points are born in continuous milliseconds but are ultimately
 * realised as whole video frames. Rounding them at render time would be too
 * late: the same freeze list also drives the audio silence, the subtitle
 * shift, and shiftForFreezes() for clicks and cursor keyframes. Aligning here,
 * once, keeps every consumer on the same numbers.
 */

/** Milliseconds occupied by one frame at `fps`. */
export function msPerFrame(fps: number): number {
  return 1000 / fps
}

/**
 * Round `ms` up to the next whole frame boundary. Values already on a boundary
 * are returned unchanged; the result is never earlier than the input.
 * A non-positive `fps` returns the input untouched.
 */
export function alignMsUpToFrame(ms: number, fps: number): number {
  if (fps <= 0) return ms
  const per = msPerFrame(fps)
  return Math.ceil(ms / per - 1e-9) * per
}

/**
 * Align a freeze onto a frame boundary without losing time.
 *
 * Pushing the hold's start forward means the video plays that much longer
 * before holding, so the hold shrinks by the same amount and the freeze's END
 * position is preserved. That end position is what every later cue is measured
 * from — moving it would shift the rest of the video.
 *
 * A hold too short to absorb the shift clamps at zero rather than going
 * negative; the position still aligns.
 */
export function alignFreezeToFrame(
  atVideoMs: number,
  durationMs: number,
  fps: number,
): { atVideoMs: number; durationMs: number } {
  if (fps <= 0) return { atVideoMs, durationMs }
  const aligned = alignMsUpToFrame(atVideoMs, fps)
  const shift = aligned - atVideoMs
  return { atVideoMs: aligned, durationMs: Math.max(0, durationMs - shift) }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/voiceover/frame-align.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/voiceover/frame-align.ts tests/unit/voiceover/frame-align.test.ts
git commit -m "feat(voiceover): add frame-alignment arithmetic for freezes"
```

---

### Task 2: Emit frame-aligned freezes from the voiceover stage

**Files:**
- Modify: `src/voiceover/voiceover-processor.ts` (the `generateVoiceover` signature; the overflow branch that pushes to `freezes`; the approach-hold pushes)
- Modify: `src/pipeline/executor.ts` (the `voiceover` stage's `generateVoiceover` call)
- Test: `tests/unit/pipeline/voiceover-stage.test.ts` (existing file — add cases)

**Interfaces:**
- Consumes: `alignFreezeToFrame` from Task 1.
- Produces: `generateVoiceover(subtitled, provider, tmpDir, options, approachHolds, outputFps)` — a sixth positional parameter, `outputFps: number`. No later task depends on this.

**Background:** `generateVoiceover` currently pushes freezes at raw millisecond positions in three places — the overflow branch and two approach-hold loops. All three must go through `alignFreezeToFrame`. Because the function also accumulates `timeShift` from those same durations and applies it to `subtitle.startMs` / `endMs` / `zoom.startMs` / `zoom.endMs`, aligning at the push site makes subtitles inherit the alignment automatically.

`outputFps` comes from `probeVideoFps(state.sourceVideoPath)` in the executor. That is the same value `renderWithSpeed()` forces on the output, so it is the output clock's frame rate, not merely the source's.

The parameter is required rather than optional: an accidental omission would silently disable the fix.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/pipeline/voiceover-stage.test.ts`:

```ts
import { alignFreezeToFrame } from '../../../src/voiceover/frame-align'

describe('freeze frame alignment (#22 item 5)', () => {
  it('keeps a freeze end position while snapping its start to a frame', () => {
    // Regression: overflow freezes were recorded at raw ms, so the boundary
    // frame landed in whichever cue ffmpeg happened to round toward.
    const raw = { atVideoMs: 7025, durationMs: 1200 }
    const aligned = alignFreezeToFrame(raw.atVideoMs, raw.durationMs, 25)

    expect(aligned.atVideoMs % 40).toBe(0)
    expect(aligned.atVideoMs).toBeGreaterThanOrEqual(raw.atVideoMs)
    expect(aligned.atVideoMs + aligned.durationMs).toBe(raw.atVideoMs + raw.durationMs)
  })

  it('accumulates no drift across a run of freezes', () => {
    // Ten freezes, none frame-aligned. The sum of durations plus the first
    // start must equal what it was before alignment, or every later cue moves.
    const raws = Array.from({ length: 10 }, (_, i) => ({
      atVideoMs: 1000 + i * 333,
      durationMs: 250,
    }))
    const rawTotal = raws.reduce((a, f) => a + f.durationMs, 0)
    const aligned = raws.map((f) => alignFreezeToFrame(f.atVideoMs, f.durationMs, 25))
    const alignedTotal = aligned.reduce((a, f) => a + f.durationMs, 0)

    // Each hold gives up at most one frame's worth to its own position shift.
    expect(rawTotal - alignedTotal).toBeLessThanOrEqual(10 * 40)
    // And every freeze's end position is exactly preserved.
    aligned.forEach((f, i) => {
      expect(f.atVideoMs + f.durationMs).toBe(raws[i]!.atVideoMs + raws[i]!.durationMs)
    })
  })
})
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run tests/unit/pipeline/voiceover-stage.test.ts`
Expected: PASS. These characterise the contract the wiring below must honour; they exercise Task 1's helper directly, so they pass already. That is intentional — do not invent a failing variant.

- [ ] **Step 3: Add the parameter and align the overflow freeze**

In `src/voiceover/voiceover-processor.ts`, add the import:

```ts
import { alignFreezeToFrame } from './frame-align.js'
```

Add `outputFps` as the sixth parameter of `generateVoiceover` (keep every existing parameter and its type exactly as-is):

```ts
  outputFps: number,
```

Document it above the function:

```ts
 * @param outputFps Frame rate of the rendered output. Freeze points are
 *   aligned to it here — once — so the audio silence, the subtitle shift, and
 *   the renderer's video hold all use identical numbers. Aligning downstream
 *   instead would leave shiftForFreezes() on raw milliseconds while the video
 *   held frame-rounded ones, desyncing every click and cursor keyframe.
```

Replace the overflow push (the `freezes.push({ atVideoMs: originalEndsMs[si]!, durationMs: overflow })` block) with:

```ts
      const nextOriginalStartMs = originalStartsMs[si + 1]
      if (nextOriginalStartMs !== undefined) {
        freezes.push(alignFreezeToFrame(originalEndsMs[si]!, overflow, outputFps))
      }
```

- [ ] **Step 4: Align the two approach-hold pushes**

Still in `voiceover-processor.ts`, both approach-hold sites currently read:

```ts
      freezes.push({ atVideoMs: h.atVideoMs, durationMs: h.durationMs })
```

Replace each with:

```ts
      freezes.push(alignFreezeToFrame(h.atVideoMs, h.durationMs, outputFps))
```

Leave the `timeShift += h.durationMs` / `timeShift += overflow` lines alone for now — Step 5 fixes them.

- [ ] **Step 5: Keep `timeShift` consistent with the aligned durations**

`timeShift` must advance by the amount actually held, not the pre-alignment amount, or subtitles drift away from the video by the difference. Capture each aligned freeze in a local before pushing, then shift by its duration.

For the overflow branch:

```ts
      const nextOriginalStartMs = originalStartsMs[si + 1]
      if (nextOriginalStartMs !== undefined) {
        const aligned = alignFreezeToFrame(originalEndsMs[si]!, overflow, outputFps)
        freezes.push(aligned)
        timeShift += aligned.durationMs
      } else {
        timeShift += overflow
      }
```

Note this replaces the unconditional `timeShift += overflow` that followed the old `if` block — the final segment has no freeze recorded, so it keeps the unaligned shift.

For each approach-hold site:

```ts
      const aligned = alignFreezeToFrame(h.atVideoMs, h.durationMs, outputFps)
      freezes.push(aligned)
      timeShift += aligned.durationMs
```

replacing that site's `timeShift += h.durationMs`.

- [ ] **Step 6: Pass fps from the executor**

In `src/pipeline/executor.ts`, the `voiceover` stage calls `generateVoiceover(...)` with five arguments. `probeVideoFps` is already exported from the renderer; add it to the existing renderer import:

```ts
import { renderVideo, detectBlankLeadIn, probeVideoFps, type RenderableTrace } from '../render/renderer.js'
```

Then compute and pass it:

```ts
          const outputFps = state.sourceVideoPath ? probeVideoFps(state.sourceVideoPath) : 25
          state.voiceovered = await generateVoiceover(
            state.subtitled,
            stage.provider,
            tmpDir,
            stage.options,
            approachHolds,
            outputFps,
          )
```

The `: 25` fallback matches `probeVideoFps`'s own fallback and only applies when there is no source video, in which case there is nothing to render anyway.

- [ ] **Step 7: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: typecheck clean. If any existing voiceover test breaks, read it before changing it: a test asserting an exact freeze position may legitimately need its expectation moved to the next frame boundary, but a test asserting that subtitle and freeze totals agree must still pass unchanged — if that one fails, `timeShift` and the pushed duration have diverged and Step 5 is wrong.

- [ ] **Step 8: Commit**

```bash
git add src/voiceover/voiceover-processor.ts src/pipeline/executor.ts tests/unit/pipeline/voiceover-stage.test.ts
git commit -m "fix(voiceover): align freeze points to output frames (#22)"
```

---

### Task 3: Frame-indexed freeze slicing

**Files:**
- Modify: `src/render/renderer.ts` — `FreezeSegmentPlan`, `planVoiceoverFreezes`, `applyVoiceoverFreezes`, and the `approachFreezes` fallback in `renderVideo`
- Test: `tests/unit/render/freeze-plan.test.ts` (existing — update), `tests/unit/render/freeze-slice.test.ts` (new)

**Interfaces:**
- Consumes: `alignFreezeToFrame` from Task 1; `probeVideoFps` (existing export).
- Produces: `planVoiceoverFreezes(freezes, videoDur, fps)` returning frame-indexed `FreezeSegmentPlan`:

```ts
export interface FreezeSegmentPlan {
  /** Output-video start frame, inclusive. */
  startFrame: number
  /** Output-video end frame, exclusive; null means "to end of video". */
  endFrame: number | null
  /** Clone-pad frames held before the slice's first frame. */
  startHoldFrames: number
  /** Clone-pad frames held after the slice's last frame. */
  stopHoldFrames: number
}
```

No later task depends on this.

**Background:** by the time the renderer runs, Task 2 has already aligned every voiceover freeze to a frame boundary, so this conversion rounds nothing — `Math.round(ms * fps / 1000)` lands exactly. The rounding that remains is a safety net for the no-voiceover approach-hold path, which Step 5 aligns separately.

`planVoiceoverFreezes` keeps its existing structure: collapse freezes onto distinct positions, fold a hold coinciding with the current slice start into a start-pad on the next slice, emit a trailing slice. Only the units change. **Preserve the leading-hold behaviour exactly** — the doc comment explains why dropping it desynced overlays, and that regression has its own test.

`totalHoldSec` stays in the return value and stays in seconds: `renderVideo` logs it and nothing else reads it.

- [ ] **Step 1: Update the existing planner tests to frames**

In `tests/unit/render/freeze-plan.test.ts`, the existing cases call `planVoiceoverFreezes(freezes, 19.7)`. Add `25` as a third argument to every call, and convert the assertions from seconds to frames — `expect(segments[0]!.startSec).toBe(0)` becomes `expect(segments[0]!.startFrame).toBe(0)`, and `expect(segments[0]!.startHoldSec).toBeCloseTo(7.296, 3)` becomes `expect(segments[0]!.startHoldFrames).toBe(Math.round(7.296 * 25))`.

Keep the regression case's intent intact: the leading 7.296 s hold must still be realised as a start-pad on the first emitted slice, and `totalHoldSec` must still equal the sum of the input durations.

- [ ] **Step 2: Write the new slicing test**

Create `tests/unit/render/freeze-slice.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { planVoiceoverFreezes } from '../../../src/render/renderer'

describe('planVoiceoverFreezes in frames', () => {
  it('converts already-aligned freezes without rounding', () => {
    // Task 2 aligns freezes upstream, so these land exactly on frames.
    const { segments } = planVoiceoverFreezes(
      [{ atVideoMs: 2000, durationMs: 1000 }],
      10,
      25,
    )
    expect(segments[0]!.startFrame).toBe(0)
    expect(segments[0]!.endFrame).toBe(50) // 2.000s * 25
    expect(segments[0]!.stopHoldFrames).toBe(25) // 1.000s * 25
  })

  it('gives the boundary frame to the cue that starts on or after it', () => {
    // A cut at 2.000s must not hand frame 50 to the preceding slice.
    const { segments } = planVoiceoverFreezes(
      [{ atVideoMs: 2000, durationMs: 400 }],
      10,
      25,
    )
    expect(segments[0]!.endFrame).toBe(50)
    expect(segments[1]!.startFrame).toBe(50)
  })

  it('emits contiguous slices with no gap or overlap', () => {
    const { segments } = planVoiceoverFreezes(
      [
        { atVideoMs: 1000, durationMs: 200 },
        { atVideoMs: 3000, durationMs: 400 },
        { atVideoMs: 5000, durationMs: 200 },
      ],
      10,
      25,
    )
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i]!.startFrame).toBe(segments[i - 1]!.endFrame)
    }
    expect(segments[segments.length - 1]!.endFrame).toBeNull()
  })

  it('still folds a leading hold into a start-pad (regression)', () => {
    const { segments, totalHoldSec } = planVoiceoverFreezes(
      [{ atVideoMs: 0, durationMs: 2000 }, { atVideoMs: 4000, durationMs: 1000 }],
      10,
      25,
    )
    expect(segments[0]!.startFrame).toBe(0)
    expect(segments[0]!.startHoldFrames).toBe(50)
    expect(totalHoldSec).toBeCloseTo(3.0, 3)
  })

  it('returns no segments when every freeze has zero duration', () => {
    const { segments } = planVoiceoverFreezes([{ atVideoMs: 1000, durationMs: 0 }], 10, 25)
    expect(segments).toEqual([])
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/unit/render/freeze-slice.test.ts tests/unit/render/freeze-plan.test.ts`
Expected: FAIL — `startFrame` is undefined; `planVoiceoverFreezes` takes two arguments.

- [ ] **Step 4: Convert the planner**

In `src/render/renderer.ts`, replace the `FreezeSegmentPlan` interface with the frame-indexed version from the Interfaces block above.

Change the signature to `planVoiceoverFreezes(freezes, videoDur: number, fps: number)`.

Inside, convert positions and durations to frames as they enter the map, and emit frame fields:

```ts
  const toFrames = (sec: number): number => Math.round(sec * fps)
  const totalFrames = toFrames(videoDur)

  const byPos = new Map<number, number>()
  for (const f of freezes) {
    const atFrame = Math.max(0, Math.min(totalFrames, toFrames(f.atVideoMs / 1000)))
    const durFrames = Math.max(0, toFrames(f.durationMs / 1000))
    if (durFrames <= 0) continue
    if (atFrame >= totalFrames) continue
    byPos.set(atFrame, (byPos.get(atFrame) ?? 0) + durFrames)
  }
  const cuts = [...byPos.entries()]
    .map(([atFrame, durFrames]) => ({ atFrame, durFrames }))
    .sort((a, b) => a.atFrame - b.atFrame)

  const totalHoldSec = cuts.reduce((a, b) => a + b.durFrames, 0) / fps
  if (cuts.length === 0) return { segments: [], totalHoldSec: 0 }

  const segments: FreezeSegmentPlan[] = []
  let prevEnd = 0
  let pendingStartHold = 0
  for (const c of cuts) {
    if (c.atFrame <= prevEnd) {
      pendingStartHold += c.durFrames
      continue
    }
    segments.push({
      startFrame: prevEnd,
      endFrame: c.atFrame,
      startHoldFrames: pendingStartHold,
      stopHoldFrames: c.durFrames,
    })
    prevEnd = c.atFrame
    pendingStartHold = 0
  }

  if (prevEnd < totalFrames || pendingStartHold > 0) {
    segments.push({
      startFrame: prevEnd,
      endFrame: null,
      startHoldFrames: pendingStartHold,
      stopHoldFrames: 0,
    })
  }

  return { segments, totalHoldSec }
```

The old `+ 0.01` and `- 0.01` epsilons disappear: frame indices are integers, so `<=` and `<` are exact. That is the point of the change.

- [ ] **Step 5: Convert the slicer and quantise the no-voiceover path**

In `applyVoiceoverFreezes`, probe the frame rate and pass it to the planner, then slice by frame:

```ts
  const videoDur = getVideoDuration(videoPath)
  const fps = probeVideoFps(videoPath)
  const { segments, totalHoldSec } = planVoiceoverFreezes(freezes, videoDur, fps)
  if (segments.length === 0) return videoPath

  const segPaths: string[] = []
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!
    const segPath = path.join(tmpDir, `vo-freeze-seg-${i}.mp4`)

    const trim = seg.endFrame !== null
      ? `trim=start_frame=${seg.startFrame}:end_frame=${seg.endFrame}`
      : `trim=start_frame=${seg.startFrame}`
    const filters = [trim, 'setpts=PTS-STARTPTS']

    const pad: string[] = []
    if (seg.startHoldFrames > 0) {
      pad.push(`start_mode=clone:start_duration=${(seg.startHoldFrames / fps).toFixed(3)}`)
    }
    if (seg.stopHoldFrames > 0) {
      pad.push(`stop_mode=clone:stop_duration=${(seg.stopHoldFrames / fps).toFixed(3)}`)
    }
    if (pad.length > 0) filters.push(`tpad=${pad.join(':')}`)

    ffmpeg([
      '-y', '-i', videoPath,
      '-vf', filters.join(','),
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-an',
      segPath,
    ])
    segPaths.push(segPath)
  }
```

Note the input seek is gone — `trim` operates on decoded frames, so `-ss` would double-apply the offset.

Then, in `renderVideo`, quantise the no-voiceover approach freezes. Find the `approachFreezes.push({...})` inside `if (!trace.voiceover && trace.cursorKeyframes)` and wrap it:

```ts
        approachFreezes.push(alignFreezeToFrame(
          Math.max(0, Math.round(kf.videoTimeSec * 1000) - 2),
          Math.round(approachMs),
          probeVideoFps(videoInput),
        ))
```

Add `import { alignFreezeToFrame } from '../voiceover/frame-align.js'` to the renderer's imports. This path has no audio or subtitles to stay in sync with, so aligning here is safe — unlike the voiceover path, which Task 2 aligns upstream.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/unit/render/freeze-slice.test.ts tests/unit/render/freeze-plan.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: typecheck clean, all passing.

- [ ] **Step 8: Commit**

```bash
git add src/render/renderer.ts tests/unit/render/freeze-plan.test.ts tests/unit/render/freeze-slice.test.ts
git commit -m "fix(render): slice voiceover freezes by frame index (#22)"
```

---

### Task 4: Hold sub-frame speed segments instead of encoding nothing

**Files:**
- Modify: `src/render/renderer.ts` — `renderWithSpeed()`'s encode loop
- Test: `tests/unit/render/subframe-hold.test.ts` (new)

**Interfaces:**
- Consumes: `planSpeedSegments`, `probeVideoFps` (existing).
- Produces: nothing exported.

**Background:** a segment allocated ≥1 frame whose source interval contains no native frame encodes to a file with zero frames, which then breaks the concat demuxer. Issue #22 proposes probing `best_effort_timestamp_time` for every source frame up front; this plan does not — that is a full decode pass to serve a rare case. Instead, detect it where it manifests: probe the encoded segment's frame count, and only when it is zero re-encode that one segment as a clone-hold seeded from the last source frame at or before its start.

`-frames:v` can only truncate, never extend, which is why the first encode can come back empty rather than short.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/render/subframe-hold.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

const TMP_DIR = fs.mkdtempSync(path.join('/tmp', 'recast-subframe-'))
const SRC = path.join(TMP_DIR, 'src.mp4')

const frameCount = (file: string): number =>
  Number(execFileSync('ffprobe', [
    '-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file,
  ]).toString().trim())

describe('sub-frame source intervals', () => {
  beforeAll(() => {
    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'testsrc=s=320x180:r=25:d=4',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', SRC,
    ], { stdio: 'pipe' })
  })

  afterAll(() => { fs.rmSync(TMP_DIR, { recursive: true, force: true }) })

  it('a plain encode of an interval between two frames yields nothing', () => {
    // Establishes the failure this task fixes: 25fps frames sit at 40ms
    // intervals, so [1.001s, 1.010s] contains no native frame.
    const out = path.join(TMP_DIR, 'empty.mp4')
    execFileSync('ffmpeg', [
      '-y', '-ss', '1.001', '-to', '1.010', '-i', SRC,
      '-filter:v', 'setpts=PTS/1,fps=25', '-frames:v', '1',
      '-c:v', 'libx264', '-preset', 'fast', '-an', out,
    ], { stdio: 'pipe' })
    expect(frameCount(out)).toBe(0)
  })

  it('the clone-hold fallback yields exactly the allocated frames', () => {
    const out = path.join(TMP_DIR, 'held.mp4')
    const allocatedFrames = 3
    execFileSync('ffmpeg', [
      '-y', '-ss', '1.000', '-i', SRC, '-frames:v', '1',
      '-vf', `tpad=stop_mode=clone:stop_duration=${((allocatedFrames - 1) / 25).toFixed(3)},fps=25`,
      '-c:v', 'libx264', '-preset', 'fast', '-an', out,
    ], { stdio: 'pipe' })
    expect(frameCount(out)).toBe(allocatedFrames)
  })
}, 120_000)
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/unit/render/subframe-hold.test.ts`
Expected: PASS both. These pin the ffmpeg behaviour the implementation relies on — the first documents the bug, the second the fix's mechanics. If the first test PASSES with a non-zero frame count on your ffmpeg build, STOP and report: the premise does not hold on this version and the fallback would be dead code.

- [ ] **Step 3: Add the fallback to the encode loop**

In `renderWithSpeed()`, inside the `for` loop over `plan`, after the existing `ffmpeg([...])` call and before `segmentPaths.push(segPath)`:

```ts
    // -frames:v can truncate but never extend. When a segment's source
    // interval falls entirely between two native frames, the encode above
    // produces a file with no frames at all, which breaks the concat demuxer
    // downstream. Re-encode that segment as a hold on the last settled frame
    // so the scene shows rather than vanishing (#22).
    if (probeFrameCount(segPath) === 0) {
      const holdSec = Math.max(0, (seg.frames - 1) / fps)
      ffmpeg([
        '-y', '-ss', String(seg.startSec), '-i', sourceVideo,
        '-frames:v', '1',
        '-vf', `tpad=stop_mode=clone:stop_duration=${holdSec.toFixed(3)},fps=${fps}`,
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-an',
        segPath,
      ])
      console.log(`    Seg ${i}: no native frame in source interval — held ${seg.frames}f`)
    }
```

`-ss` before `-i` seeks to the nearest preceding keyframe and decodes forward, so it lands on the last frame at or before `startSec` — which is the "last settled visual" the spec calls for.

- [ ] **Step 4: Add the frame-count probe**

In `src/render/renderer.ts`, next to `probeVideoFps`, add:

```ts
/**
 * Count the decoded frames in a video. Returns 0 when the file has none or
 * ffprobe cannot read it — both mean "this segment produced nothing usable".
 */
export function probeFrameCount(videoPath: string): number {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-count_frames', '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', videoPath,
    ]).toString().trim()
    const n = Number(out)
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}
```

- [ ] **Step 5: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: typecheck clean, all passing. The existing `speed-segment-encode.test.ts` must still pass unchanged — normal segments never enter the fallback.

- [ ] **Step 6: Commit**

```bash
git add src/render/renderer.ts tests/unit/render/subframe-hold.test.ts
git commit -m "fix(render): hold sub-frame speed segments instead of encoding nothing (#22)"
```

---

### Task 5: Conditional audio concat normalisation

**Files:**
- Create: `src/voiceover/audio-format.ts`
- Modify: `src/voiceover/voiceover-processor.ts` (the concat call)
- Test: `tests/unit/voiceover/audio-format.test.ts` (new)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface AudioFormat { sampleRate: number; channels: number }`
  - `probeAudioFormat(path: string): AudioFormat | null`
  - `planAudioConcat(formats: Array<AudioFormat | null>): { normalise: false } | { normalise: true; sampleRate: number; channels: number }`

**Background:** `voiceover-processor.ts` concatenates TTS segments and generated silence with `-c copy`. When segments disagree on sample rate or channel layout the demuxer keeps the first one's and the rest play at the wrong speed. Issue #22 proposes always re-encoding to 44.1 kHz mono; this plan does not, because that would re-encode the many pipelines whose segments already agree — a breaking change under the binding constraint. Only a genuine mismatch triggers normalisation.

A `null` format means the probe failed for that file. Treat any null as a mismatch: if we cannot prove the formats agree, normalising is the safe branch.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/voiceover/audio-format.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { planAudioConcat, type AudioFormat } from '../../../src/voiceover/audio-format'

const f = (sampleRate: number, channels: number): AudioFormat => ({ sampleRate, channels })

describe('planAudioConcat', () => {
  it('keeps stream copy when every segment agrees', () => {
    // The common case: -c copy stays bit-identical to today's behaviour.
    expect(planAudioConcat([f(24000, 1), f(24000, 1), f(24000, 1)]))
      .toEqual({ normalise: false })
  })

  it('keeps stream copy for a single segment', () => {
    expect(planAudioConcat([f(48000, 2)])).toEqual({ normalise: false })
  })

  it('keeps stream copy for an empty list', () => {
    expect(planAudioConcat([])).toEqual({ normalise: false })
  })

  it('normalises to the majority format when sample rates disagree', () => {
    expect(planAudioConcat([f(24000, 1), f(44100, 1), f(24000, 1)]))
      .toEqual({ normalise: true, sampleRate: 24000, channels: 1 })
  })

  it('normalises when channel layouts disagree', () => {
    expect(planAudioConcat([f(24000, 1), f(24000, 2), f(24000, 1)]))
      .toEqual({ normalise: true, sampleRate: 24000, channels: 1 })
  })

  it('falls back to 44.1kHz mono when there is no majority', () => {
    expect(planAudioConcat([f(24000, 1), f(48000, 2)]))
      .toEqual({ normalise: true, sampleRate: 44100, channels: 1 })
  })

  it('normalises when any probe failed', () => {
    // Cannot prove they agree, so take the safe branch.
    const r = planAudioConcat([f(24000, 1), null, f(24000, 1)])
    expect(r.normalise).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/voiceover/audio-format.test.ts`
Expected: FAIL — `Failed to resolve import ".../src/voiceover/audio-format"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/voiceover/audio-format.ts`:

```ts
import { execFileSync } from 'node:child_process'

/** The two properties the concat demuxer requires to match across inputs. */
export interface AudioFormat {
  sampleRate: number
  channels: number
}

/** Probe one audio file. Returns null when ffprobe cannot read it. */
export function probeAudioFormat(filePath: string): AudioFormat | null {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=sample_rate,channels',
      '-of', 'csv=p=0', filePath,
    ]).toString().trim()
    const [rateStr, chStr] = out.split(',')
    const sampleRate = Number(rateStr)
    const channels = Number(chStr)
    if (!Number.isFinite(sampleRate) || !Number.isFinite(channels)) return null
    if (sampleRate <= 0 || channels <= 0) return null
    return { sampleRate, channels }
  } catch {
    return null
  }
}

/**
 * Decide how to concatenate TTS segments.
 *
 * Stream copy is kept whenever every segment already agrees — that is the
 * common case, and re-encoding it would change audio for pipelines that are
 * working today. Only a genuine mismatch, which the concat demuxer would
 * otherwise resolve by silently keeping the first segment's format and playing
 * the rest at the wrong rate, triggers a normalising encode.
 *
 * A failed probe counts as a mismatch: without proof that the formats agree,
 * normalising is the safe branch.
 */
export function planAudioConcat(
  formats: Array<AudioFormat | null>,
): { normalise: false } | { normalise: true; sampleRate: number; channels: number } {
  if (formats.length <= 1) return { normalise: false }
  if (formats.some((f) => f === null)) {
    return { normalise: true, sampleRate: 44100, channels: 1 }
  }

  const known = formats as AudioFormat[]
  const first = known[0]!
  const allAgree = known.every(
    (f) => f.sampleRate === first.sampleRate && f.channels === first.channels,
  )
  if (allAgree) return { normalise: false }

  // Pick the most common (rate, channels) pair; ties fall back to 44.1kHz mono.
  const counts = new Map<string, number>()
  for (const f of known) {
    const key = `${f.sampleRate}:${f.channels}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let bestKey: string | null = null
  let bestCount = 0
  let tied = false
  for (const [key, count] of counts) {
    if (count > bestCount) {
      bestKey = key
      bestCount = count
      tied = false
    } else if (count === bestCount) {
      tied = true
    }
  }
  if (bestKey === null || tied) return { normalise: true, sampleRate: 44100, channels: 1 }

  const [rate, ch] = bestKey.split(':')
  return { normalise: true, sampleRate: Number(rate), channels: Number(ch) }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/voiceover/audio-format.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Wire it into the concat**

In `src/voiceover/voiceover-processor.ts`, add the import:

```ts
import { probeAudioFormat, planAudioConcat } from './audio-format.js'
```

Replace the concat `ffmpeg` invocation (the block using `'-c', 'copy'`) with:

```ts
  if (segmentFiles.length > 0) {
    const plan = planAudioConcat(segmentFiles.map(probeAudioFormat))
    const codecArgs = plan.normalise
      ? ['-c:a', 'libmp3lame', '-ar', String(plan.sampleRate), '-ac', String(plan.channels)]
      : ['-c', 'copy']
    if (plan.normalise) {
      console.log(`  Voiceover: segment formats differ — normalising to ${plan.sampleRate}Hz/${plan.channels}ch`)
    }
    execFileSync('ffmpeg', [
      '-y', '-f', 'concat', '-safe', '0',
      '-i', concatList,
      ...codecArgs,
      audioTrackPath,
    ], { stdio: 'pipe' })
  }
```

- [ ] **Step 6: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: typecheck clean, all passing.

- [ ] **Step 7: Commit**

```bash
git add src/voiceover/audio-format.ts src/voiceover/voiceover-processor.ts tests/unit/voiceover/audio-format.test.ts
git commit -m "fix(voiceover): normalise concat only when segment formats differ (#22)"
```

---

### Task 6: Sample-point builder for exact boundaries

**Files:**
- Create: `src/speed/sample-points.ts`
- Test: `tests/unit/speed/sample-points.test.ts` (new)

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
export function buildSamplePoints(opts: {
  visibleStart: number
  visibleEnd: number
  sampleInterval: number
  exactBoundaries: boolean
  boundaryTimes: readonly number[]
}): number[]
```

Task 7 consumes it.

**Background:** `speed-processor.ts` walks a fixed 100 ms grid, so a visible narration scene shorter than 100 ms can be skipped entirely and every boundary is rounded to the grid. With `exactBoundaries` on, the sampling points become the sorted unique union of the grid, the visible bounds, and every supplied boundary time.

**The flag-off path must be byte-identical to the current grid**, because that is the non-breaking guarantee. The returned array is consumed pairwise — point `i` classifies the interval `[points[i], points[i+1])` — so the array always ends with `visibleEnd`, giving `points.length - 1` intervals.

Points outside `[visibleStart, visibleEnd]` are dropped: a narration boundary in hidden setup context must not create an interval outside the visible range.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/speed/sample-points.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildSamplePoints } from '../../../src/speed/sample-points'

const grid = (start: number, end: number, step: number): number[] => {
  const out: number[] = []
  for (let t = start; t < end; t += step) out.push(t)
  out.push(end)
  return out
}

describe('buildSamplePoints', () => {
  it('reproduces the plain grid when exactBoundaries is off', () => {
    // The non-breaking guarantee: flag off must equal today's sampling.
    const points = buildSamplePoints({
      visibleStart: 0, visibleEnd: 1000, sampleInterval: 100,
      exactBoundaries: false, boundaryTimes: [237, 456],
    })
    expect(points).toEqual(grid(0, 1000, 100))
  })

  it('ignores boundaryTimes entirely when the flag is off', () => {
    const withBoundaries = buildSamplePoints({
      visibleStart: 0, visibleEnd: 500, sampleInterval: 100,
      exactBoundaries: false, boundaryTimes: [1, 2, 3, 4, 5],
    })
    const without = buildSamplePoints({
      visibleStart: 0, visibleEnd: 500, sampleInterval: 100,
      exactBoundaries: false, boundaryTimes: [],
    })
    expect(withBoundaries).toEqual(without)
  })

  it('inserts boundary times when the flag is on', () => {
    const points = buildSamplePoints({
      visibleStart: 0, visibleEnd: 300, sampleInterval: 100,
      exactBoundaries: true, boundaryTimes: [150, 250],
    })
    expect(points).toEqual([0, 100, 150, 200, 250, 300])
  })

  it('preserves a visible scene shorter than the sample interval', () => {
    // The defect: a 20ms scene between two boundaries vanished on the grid.
    const points = buildSamplePoints({
      visibleStart: 0, visibleEnd: 500, sampleInterval: 100,
      exactBoundaries: true, boundaryTimes: [230, 250],
    })
    expect(points).toContain(230)
    expect(points).toContain(250)
    const i = points.indexOf(230)
    expect(points[i + 1]).toBe(250)
  })

  it('sorts and dedupes', () => {
    const points = buildSamplePoints({
      visibleStart: 0, visibleEnd: 300, sampleInterval: 100,
      exactBoundaries: true, boundaryTimes: [200, 100, 200, 50],
    })
    expect(points).toEqual([0, 50, 100, 200, 300])
  })

  it('drops boundaries outside the visible range', () => {
    const points = buildSamplePoints({
      visibleStart: 100, visibleEnd: 300, sampleInterval: 100,
      exactBoundaries: true, boundaryTimes: [-50, 50, 400, 1000],
    })
    expect(points).toEqual([100, 200, 300])
  })

  it('always ends at visibleEnd', () => {
    for (const end of [250, 300, 999]) {
      const points = buildSamplePoints({
        visibleStart: 0, visibleEnd: end, sampleInterval: 100,
        exactBoundaries: true, boundaryTimes: [],
      })
      expect(points[points.length - 1]).toBe(end)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/speed/sample-points.test.ts`
Expected: FAIL — `Failed to resolve import ".../src/speed/sample-points"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/speed/sample-points.ts`:

```ts
/**
 * Build the points at which the speed classifier samples activity.
 *
 * The classifier walks these pairwise: point `i` classifies the interval
 * `[points[i], points[i + 1])`. The array therefore always ends at
 * `visibleEnd`, yielding `points.length - 1` intervals.
 *
 * With `exactBoundaries` off this is exactly the fixed grid the classifier has
 * always used — that equivalence is the non-breaking guarantee, so do not
 * "tidy" the off branch.
 *
 * With it on, narration and hidden-range boundaries join the grid, so a scene
 * shorter than one sample interval keeps its own interval instead of being
 * swallowed by the surrounding grid cell.
 */
export function buildSamplePoints(opts: {
  visibleStart: number
  visibleEnd: number
  sampleInterval: number
  exactBoundaries: boolean
  boundaryTimes: readonly number[]
}): number[] {
  const { visibleStart, visibleEnd, sampleInterval, exactBoundaries, boundaryTimes } = opts

  const points: number[] = []
  for (let t = visibleStart; t < visibleEnd; t += sampleInterval) points.push(t)
  points.push(visibleEnd)

  if (!exactBoundaries) return points

  for (const b of boundaryTimes) {
    if (b > visibleStart && b < visibleEnd) points.push(b)
  }

  return [...new Set(points)].sort((a, b) => a - b)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/speed/sample-points.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/speed/sample-points.ts tests/unit/speed/sample-points.test.ts
git commit -m "feat(speed): add sample-point builder for exact boundaries"
```

---

### Task 7: Wire `speedUp({ exactBoundaries })`

**Files:**
- Modify: `src/types/speed.ts` (`SpeedConfig`)
- Modify: `src/speed/speed-processor.ts` (the classification loop)
- Test: `tests/unit/speed/speed-processor-boundaries.test.ts` (new)

**Interfaces:**
- Consumes: `buildSamplePoints` from Task 6.
- Produces: `SpeedConfig.exactBoundaries?: boolean` (default `false`).

**Background:** the current loop is `for (let t = visibleStart; t < visibleEnd; t += sampleInterval)`, classifying at `t`, with `segEnd = Math.min(t + sampleInterval, visibleEnd)`, skipping any `t` inside a hidden range. Driving it from `buildSamplePoints` makes `segEnd` the *next point* rather than `t + sampleInterval`. With the flag off these are identical, because the points are the grid — that equivalence is what the regression test asserts.

`boundaryTimes` are the narration-boundary action timestamps plus every hidden-range start and end. Narration boundaries are identified by `isNarrationBoundaryTitle` (`pipeline/narration-subtitles.ts`), already imported by the executor; `speed-processor.ts` receives `actions` and `hiddenRanges` and can derive both locally.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/speed/speed-processor-boundaries.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildSamplePoints } from '../../../src/speed/sample-points'

describe('exactBoundaries produces intervals, not grid cells', () => {
  it('an interval never spans a boundary when the flag is on', () => {
    // The classifier walks points pairwise; no interval may contain a
    // boundary in its interior, or the scene on one side gets the other
    // side's speed.
    const boundaries = [237, 456, 460]
    const points = buildSamplePoints({
      visibleStart: 0, visibleEnd: 600, sampleInterval: 100,
      exactBoundaries: true, boundaryTimes: boundaries,
    })
    for (let i = 0; i < points.length - 1; i++) {
      const [lo, hi] = [points[i]!, points[i + 1]!]
      for (const b of boundaries) {
        expect(b > lo && b < hi).toBe(false)
      }
    }
  })

  it('with the flag off, intervals are exactly the old grid cells', () => {
    // Regression guard for the non-breaking requirement.
    const points = buildSamplePoints({
      visibleStart: 0, visibleEnd: 450, sampleInterval: 100,
      exactBoundaries: false, boundaryTimes: [237, 456],
    })
    const intervals = points.slice(0, -1).map((t, i) => [t, points[i + 1]!])
    expect(intervals).toEqual([[0, 100], [100, 200], [200, 300], [300, 400], [400, 450]])
  })
})
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run tests/unit/speed/speed-processor-boundaries.test.ts`
Expected: PASS. Characterisation tests over Task 6's builder, pinning the property the loop rewrite must preserve.

- [ ] **Step 3: Add the config field**

In `src/types/speed.ts`, add to `SpeedConfig`, directly after `maxSpeed`:

```ts
  /**
   * Sample activity at exact narration and hidden-range boundaries in addition
   * to the fixed interval grid. Off by default: turning it on shifts segment
   * boundaries for existing pipelines. Enable it when narration scenes shorter
   * than `minSegmentDuration` are being swallowed. Default: false
   */
  exactBoundaries?: boolean
```

- [ ] **Step 4: Drive the loop from the sample points**

In `src/speed/speed-processor.ts`, add the imports:

```ts
import { buildSamplePoints } from './sample-points.js'
import { isNarrationBoundaryTitle } from '../pipeline/narration-subtitles.js'
```

Immediately before the classification loop (after `const sampleInterval = 100` and the `rawSegments` declaration), build the points:

```ts
  const boundaryTimes = config.exactBoundaries
    ? [
        ...actions
          .filter((a) => typeof a.title === 'string' && isNarrationBoundaryTitle(a.title))
          .flatMap((a) => [a.startTime as number, a.endTime as number]),
        ...hiddenRanges.flatMap((r) => [r.start as number, r.end as number]),
      ]
    : []

  const samplePoints = buildSamplePoints({
    visibleStart,
    visibleEnd,
    sampleInterval,
    exactBoundaries: config.exactBoundaries ?? false,
    boundaryTimes,
  })
```

Replace the loop header:

```ts
  for (let t = visibleStart; t < visibleEnd; t += sampleInterval) {
```

with:

```ts
  for (let pi = 0; pi < samplePoints.length - 1; pi++) {
    const t = samplePoints[pi]!
```

and replace the `segEnd` line:

```ts
    const segEnd = Math.min(t + sampleInterval, visibleEnd)
```

with:

```ts
    const segEnd = samplePoints[pi + 1]!
```

Everything between — the hidden-range skip, the rule evaluation, the activity classification, the adjacent-segment merge — stays exactly as it is.

- [ ] **Step 5: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: typecheck clean, all passing. The existing `speed-processor.test.ts` and `speed-processor-rules.test.ts` must pass **unchanged** — none of them set `exactBoundaries`, so they exercise the grid path. If any fails, the flag-off equivalence is broken; fix that rather than the test.

- [ ] **Step 6: Commit**

```bash
git add src/types/speed.ts src/speed/speed-processor.ts tests/unit/speed/speed-processor-boundaries.test.ts
git commit -m "feat(speed): add opt-in exactBoundaries sampling (#22)"
```

---

### Task 8: Contain zoom transitions inside their cue

**Files:**
- Modify: `src/render/zoom-expression.ts` (`ZoomExprConfig`, `buildSegments`, its caller)
- Test: `tests/unit/render/zoom-contain.test.ts` (new)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ZoomExprConfig.containInCue: boolean` (required on the internal config; the public flag defaults it in Task 9).

**Background:** `buildSegments(keyframes, T)` sets the zoom-in transition to `[startSec - T, startSec]` and the zoom-out to end at `endSec + T`, so both overrun the cue that asked for them. With `containInCue` on:

```text
transitionSec   = min(T, (endSec - startSec) / 2)
zoomInEndSec    = startSec + transitionSec
zoomOutStartSec = endSec - transitionSec
```

The `skipTransIn` coalescing and the two gap branches exist only to manage transitions that cross cue boundaries; in contained mode there are none, so the contained path is a separate, simpler branch rather than a patch on the existing one.

`buildSegments` is not currently exported. Export it so the test can reach it without going through the whole filter builder.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/render/zoom-contain.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildSegments } from '../../../src/render/zoom-expression'

const kf = (atMs: number, holdMs: number) => ({
  atMs, holdMs, level: 2.0, x: 0.5, y: 0.5,
})

describe('buildSegments with containInCue', () => {
  it('keeps every segment inside its cue', () => {
    const segs = buildSegments([kf(1000, 2000)], 0.4, true)
    for (const s of segs) {
      expect(s.startSec).toBeGreaterThanOrEqual(1.0)
      expect(s.endSec).toBeLessThanOrEqual(3.0)
    }
  })

  it('zooms in at the cue start and out at the cue end', () => {
    const segs = buildSegments([kf(1000, 2000)], 0.4, true)
    expect(segs[0]!.startSec).toBeCloseTo(1.0, 3)
    expect(segs[segs.length - 1]!.endSec).toBeCloseTo(3.0, 3)
  })

  it('splits a cue shorter than 2T evenly with no hold', () => {
    // 0.6s cue, T=0.4 → transition clamps to 0.3, in and out meet at the middle.
    const segs = buildSegments([kf(1000, 600)], 0.4, true)
    expect(segs.filter((s) => s.type === 'hold')).toHaveLength(0)
    expect(segs[0]!.endSec).toBeCloseTo(1.3, 3)
    expect(segs[segs.length - 1]!.startSec).toBeCloseTo(1.3, 3)
  })

  it('never leaks into an adjacent cue', () => {
    const segs = buildSegments([kf(1000, 1000), kf(2000, 1000)], 0.4, true)
    const first = segs.filter((s) => s.endSec <= 2.0)
    const second = segs.filter((s) => s.startSec >= 2.0)
    expect(first.length + second.length).toBe(segs.length)
  })

  it('with the flag off, still overruns the cue exactly as before', () => {
    // Regression guard: today's behaviour is the default and must not move.
    const segs = buildSegments([kf(1000, 2000)], 0.4, false)
    expect(segs[0]!.startSec).toBeCloseTo(0.6, 3) // startSec - T
    expect(segs[segs.length - 1]!.endSec).toBeCloseTo(3.4, 3) // endSec + T
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/render/zoom-contain.test.ts`
Expected: FAIL — `buildSegments` is not exported, and takes two arguments.

- [ ] **Step 3: Add the contained branch**

In `src/render/zoom-expression.ts`, add `containInCue: boolean` to `ZoomExprConfig`.

Export `buildSegments` and give it a third parameter, then branch at the top of the loop body:

```ts
export function buildSegments(
  keyframes: InternalKeyframe[],
  T: number,
  containInCue: boolean,
): Segment[] {
  const segments: Segment[] = []

  for (let i = 0; i < keyframes.length; i++) {
    const kf = keyframes[i]!
    const startSec = kf.atMs / 1000
    const endSec = startSec + kf.holdMs / 1000

    if (containInCue) {
      // Both transitions live inside [startSec, endSec], so a cue can never
      // disturb its neighbours and the zoom never anticipates the narration.
      // A cue shorter than 2T splits evenly and has no hold (#22 item 6).
      const t = Math.min(T, (endSec - startSec) / 2)
      if (t > 0.01) {
        segments.push({
          type: 'transition', startSec, endSec: startSec + t,
          fromLevel: 1.0, fromCx: 0.5, fromCy: 0.5,
          toLevel: kf.level, toCx: kf.x, toCy: kf.y,
        })
      }
      if (endSec - t - (startSec + t) > 0.01) {
        segments.push({
          type: 'hold', startSec: startSec + t, endSec: endSec - t,
          level: kf.level, cx: kf.x, cy: kf.y,
        })
      }
      if (t > 0.01) {
        segments.push({
          type: 'transition', startSec: endSec - t, endSec,
          fromLevel: kf.level, fromCx: kf.x, fromCy: kf.y,
          toLevel: 1.0, toCx: 0.5, toCy: 0.5,
        })
      }
      continue
    }

    // ...existing overrunning behaviour, unchanged...
```

Leave every line of the existing branch untouched below the `continue`.

- [ ] **Step 4: Pass the flag from the caller**

In the same file, the `buildSegments(internal, T)` call becomes:

```ts
  const segments = buildSegments(internal, T, config.containInCue)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/unit/render/zoom-contain.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: typecheck will FAIL until Task 9 supplies `containInCue` at every `ZoomExprConfig` construction site. If the only errors are missing `containInCue` properties, that is expected — add `containInCue: false` at those sites now to keep the build green, and Task 9 replaces the literal with the real value.

- [ ] **Step 7: Commit**

```bash
git add src/render/zoom-expression.ts tests/unit/render/zoom-contain.test.ts
git commit -m "feat(render): add cue-contained zoom transition mode (#22)"
```

---

### Task 9: Wire `autoZoom({ containInCue })` through the pipeline

**Files:**
- Modify: `src/pipeline/stages.ts` (`AutoZoomConfig`)
- Modify: `src/pipeline/executor.ts:67` (`zoomConfig` type), `:715` (assignment)
- Modify: `src/render/renderer.ts` (`RenderableTrace.zoomConfig` type, and the `ZoomExprConfig` construction in `renderWithZoom`)
- Test: `tests/unit/pipeline/zoom-contain-wiring.test.ts` (new)

**Interfaces:**
- Consumes: `ZoomExprConfig.containInCue` from Task 8.
- Produces: `AutoZoomConfig.containInCue?: boolean` (default `false`).

**Background:** the flag travels `autoZoom({ containInCue })` → `state.zoomConfig` → `RenderableTrace.zoomConfig` → `ZoomExprConfig`. Three type declarations describe the same shape and all three must gain the field or the value is silently dropped somewhere in the middle.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/pipeline/zoom-contain-wiring.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Recast } from '../../../src/index'

describe('autoZoom({ containInCue }) plumbing', () => {
  it('records the flag on the zoom stage config', () => {
    const stages = Recast.from('./trace.zip').parse().autoZoom({ containInCue: true }).getStages()
    const zoomStage = stages.find((s) => s.type === 'autoZoom')
    expect(zoomStage).toBeDefined()
    expect((zoomStage as { config: { containInCue?: boolean } }).config.containInCue).toBe(true)
  })

  it('defaults to undefined when not supplied', () => {
    const stages = Recast.from('./trace.zip').parse().autoZoom({}).getStages()
    const zoomStage = stages.find((s) => s.type === 'autoZoom')
    expect((zoomStage as { config: { containInCue?: boolean } }).config.containInCue).toBeUndefined()
  })
})
```

Note the names: the public pipeline method is **`autoZoom()`** (`pipeline.ts:107`), not `zoom()`, and the stage type is `'autoZoom'` (`stages.ts:28`). `zoom()` is a separate step *helper* — do not confuse them.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/pipeline/zoom-contain-wiring.test.ts`
Expected: FAIL — TypeScript rejects `containInCue` as an unknown property of `AutoZoomConfig`.

- [ ] **Step 3: Add the public option**

In `src/pipeline/stages.ts`, add to `AutoZoomConfig` directly after `easing`:

```ts
  /**
   * Keep each cue's zoom-in and zoom-out inside the cue's own window, instead
   * of starting `transitionMs` before it and ending `transitionMs` after it.
   * Off by default: enabling it changes how existing demos look. Default: false
   */
  containInCue?: boolean
```

- [ ] **Step 4: Thread it through the executor**

In `src/pipeline/executor.ts:67`, extend the `zoomConfig` field type:

```ts
  zoomConfig?: { transitionMs?: number; easing?: import('../types/easing.js').EasingSpec; containInCue?: boolean }
```

At `:715`, extend the assignment:

```ts
          state.zoomConfig = {
            transitionMs: stage.config.transitionMs,
            easing: stage.config.easing,
            containInCue: stage.config.containInCue,
          }
```

- [ ] **Step 5: Thread it through the renderer**

In `src/render/renderer.ts`, extend `RenderableTrace.zoomConfig` to match the executor's shape (add `; containInCue?: boolean` inside the inline type), then supply it where `ZoomExprConfig` is built in `renderWithZoom`:

```ts
  const config: ZoomExprConfig = {
    transitionMs: zoomConfig?.transitionMs ?? 400,
    easing: zoomConfig?.easing ?? 'ease-in-out',
    fps,
    containInCue: zoomConfig?.containInCue ?? false,
  }
```

Replace any `containInCue: false` literal added in Task 8 Step 6 with this.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/unit/pipeline/zoom-contain-wiring.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 7: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: typecheck clean, all passing. Existing zoom tests must pass unchanged — none set the flag.

- [ ] **Step 8: Commit**

```bash
git add src/pipeline/stages.ts src/pipeline/executor.ts src/render/renderer.ts tests/unit/pipeline/zoom-contain-wiring.test.ts
git commit -m "feat(pipeline): expose autoZoom({ containInCue }) (#22)"
```

---

### Task 10: Documentation and changelog

**Files:**
- Modify: `CHANGELOG.md` (the `## Unreleased` section)
- Modify: `README.md` (the `speedUp` and `zoom` option tables)

**Interfaces:**
- Consumes: nothing. Documentation only.

**Background:** `CHANGELOG.md` already has an `## Unreleased` section from the #20 fix. Add to it rather than creating a second one. Two of these changes are opt-in flags, and an opt-in nobody can discover is worthless — the README option tables are where users actually look.

**Note for whoever cuts the release:** `main` also carries the unreleased suite-orchestration feature (#21), which has no changelog entry of its own. A release containing that plus these fixes is a **minor** (0.20.0), not a patch. Writing #21's entry is out of scope for this plan — flag it rather than inventing it.

- [ ] **Step 1: Count the tests**

Run: `npm test 2>&1 | tail -5`
Record the passing count and compute the delta from the 621 baseline.

- [ ] **Step 2: Extend the changelog**

Under the existing `## Unreleased` heading in `CHANGELOG.md`, add to `### Bug fixes`:

```markdown
- **Voiceover freezes could hand the boundary frame to the wrong cue** ([#22](https://github.com/ThePatriczek/playwright-recast/issues/22)) — Freeze points were recorded in continuous milliseconds and the video was sliced with timestamp seeking, so each slice rounded independently and a cue could start one frame early or late. Freeze positions are now aligned to the output frame rate once, in the voiceover stage, so the audio silence, the subtitle shift, and the renderer's video hold all use identical numbers; slicing is by frame index. Aligning a freeze preserves its end position — the fractional shift moves from the position into the hold — so no later cue moves.
- **A speed segment with no native source frame produced an empty encode** ([#22](https://github.com/ThePatriczek/playwright-recast/issues/22)) — When a segment's source interval fell entirely between two frames, `-frames:v` had nothing to truncate and the result broke the concat step. Such a segment now holds the last settled frame for its allocated duration.
- **Voiceover audio concatenation could keep incompatible sample formats** ([#22](https://github.com/ThePatriczek/playwright-recast/issues/22)) — Segments were concatenated with stream copy, so when independently synthesized segments disagreed on sample rate or channel layout the demuxer kept the first one's and played the rest wrong. Formats are now probed; matching segments still take the bit-identical stream-copy path, and only a genuine mismatch is normalised.
```

And add a new `### Features` section above `### Bug fixes` (create it if the section does not exist):

```markdown
- **`speedUp({ exactBoundaries: true })`** ([#22](https://github.com/ThePatriczek/playwright-recast/issues/22)) — Samples activity at exact narration and hidden-range boundaries in addition to the fixed 100 ms grid, so a narration scene shorter than the sample interval is no longer swallowed. Off by default: enabling it shifts segment boundaries for existing pipelines.
- **`autoZoom({ containInCue: true })`** ([#22](https://github.com/ThePatriczek/playwright-recast/issues/22)) — Keeps each cue's zoom-in and zoom-out inside the cue's own window instead of starting `transitionMs` before it and ending `transitionMs` after it, removing cross-cue transition leakage. Off by default: enabling it changes how existing demos look.
```

Update the `### Internal` test count line to the number from Step 1.

- [ ] **Step 3: Document both options in the README**

The README documents options as **commented code examples**, not option tables. Do not add a table; follow the surrounding style.

In the `## Speed Processing` section (README.md:628) the `.speedUp({...})` example block ends with `maxSpeed: 8.0,`. Add a line inside that block:

```typescript
  exactBoundaries: false,   // sample at exact narration/hidden boundaries too
```

and a sentence directly below the code block:

```markdown
`exactBoundaries` adds every narration-boundary and hidden-range timestamp to the fixed 100 ms sampling grid, so a narration scene shorter than one sample interval keeps its own segment instead of being swallowed by the surrounding grid cell. Off by default, because turning it on shifts segment boundaries for existing pipelines.
```

In the `### Auto-zoom from trace` section (README.md:477) the `.autoZoom({...})` example block ends with `centerBias: 0.3,`. Add a line inside it:

```typescript
    containInCue: false, // keep transitions inside the cue window
```

and extend the paragraph below that block — the one beginning "`autoZoom()` finds click/fill/type actions" — with:

```markdown
By default a cue's zoom-in starts `transitionMs` before the cue and its zoom-out ends `transitionMs` after it, which can overlap an adjacent cue. Set `containInCue: true` to keep both transitions inside the cue's own window; a cue shorter than twice `transitionMs` splits its time evenly between zoom-in and zoom-out with no hold. Off by default, because it changes how existing demos look.
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test`
Expected: clean, all passing.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md README.md
git commit -m "docs: changelog and README for #22 frame-boundary fixes"
```

---

## Verification checklist (spec acceptance criteria)

- [ ] Freeze slices land the boundary frame with the cue that owns it → Task 3, `freeze-slice.test.ts`
- [ ] Voiceover overflow starts are frame-aligned with no fractional time lost → Task 1 (`alignFreezeToFrame` preserves the end position), Task 2 (`timeShift` uses the aligned duration)
- [ ] A sub-frame source interval renders held content instead of an empty segment → Task 4
- [ ] Mismatched TTS formats normalised; matching ones still stream-copied → Task 5, `audio-format.test.ts`
- [ ] `exactBoundaries: true` preserves narration and hidden-range boundaries → Tasks 6 and 7
- [ ] `containInCue: true` keeps every zoom transition inside its cue → Tasks 8 and 9
- [ ] **With both flags unset, rendered output is unchanged** → Task 6 ("reproduces the plain grid"), Task 7 ("intervals are exactly the old grid cells"), Task 8 ("still overruns the cue exactly as before"), plus every pre-existing speed and zoom test passing unmodified
- [ ] The frame allocator is untouched → no task modifies `planSpeedSegments`

## Known gaps

- **No end-to-end fixture ties these together.** Each workstream is verified at its own seam. An executor-level fixture running a full trace through both flag states would be the real proof; it needs a trace fixture the repo does not have.
- **The `.webm` question from #20 is still open.** `findSourceVideo()` returns a real Playwright `recordVideo` `.webm` on the happy path, which is not guaranteed CFR, and the frame-rate assumptions in Tasks 1-4 all rest on `probeVideoFps` reporting something meaningful for it. Verify against a real recording before releasing.
- **`probeFrameCount` (Task 4) is a third ffprobe helper** alongside `probeVideoFps` and `video-ops.ts`'s `probeFps`. It probes a different property so it is not a duplicate, but if a fourth appears, the three should be consolidated into one module.
