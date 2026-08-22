# Blank-lead / speed-map clock authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `speedUp()` is active, make the speed map the single authority for output time — no blank-lead trimming, no blank-lead compensation, and frame-exact speed segments — so subtitles, zoom, voiceover, cursor, clicks and the rendered frame all agree.

**Architecture:** Three surgical changes. (A) `renderVideo()` skips its blank-trim phase when non-realtime speed segments exist. (B) The four blank-compensation sites in `executor.ts` route through one helper that returns `0` in that mode, and stop duplicating the subtitle/overlay shift loops. (C) `renderWithSpeed()` encodes each segment with an exact, cumulatively-computed frame count instead of letting ffmpeg round each segment independently. The "is speed the clock authority" test becomes one exported predicate in `src/speed/`, imported by both the renderer and the pipeline.

**Tech Stack:** TypeScript (ESM, NodeNext), Vitest (`globals: true`, config at `vitest.config.ts`), ffmpeg/ffprobe via `execFileSync`.

**Spec:** `docs/superpowers/specs/2026-08-22-blank-lead-speed-clock-design.md`

## Global Constraints

- **Non-speed behavior must not change.** Any pipeline without `speedUp()`, or whose segments are all within `0.01` of `1.0`, keeps today's blank-trim behavior exactly. This is an acceptance criterion in issue #20 and must be covered by a regression test, not just by inspection.
- **Speed-active threshold is `Math.abs(speed - 1.0) > 0.01`** — copied verbatim from the existing inline checks at `renderer.ts:668-669`, `executor.ts:386`, `executor.ts:461`. Do not "improve" this number.
- **`detectBlankLeadIn()` stays untouched.** The `size <= 15_000` PNG heuristic is fragile but out of scope; changing it would alter working non-speed pipelines.
- **Tests use Vitest globals** — `describe`/`it`/`expect` are still imported explicitly in this repo (see any file under `tests/unit/`). Follow that.
- **Test imports omit the `.js` extension** (e.g. `from '../../../src/speed/time-remap'`); `src/` imports include it (e.g. `from '../types/speed.js'`). Follow each convention in its own directory.
- **Run the full suite** (`npm test`) before the final commit.

## Branch context

This plan was written against `fix/blank-lead-speed-clock`, branched from
`282075e` (v0.19.2). The suite-orchestration work (`#21`, commit `9c1d964`) landed
in parallel on `feat/suite-orchestration`. It does **not** touch `executor.ts` or
`renderer.ts` — verified with `git diff feat/suite-orchestration -- src/pipeline/executor.ts src/render/renderer.ts`,
which is empty — so every line reference below is valid on either base.

Two things to re-check if this branch is rebased onto a main that already
includes `#21`:

- **Test baseline.** 496 on this branch; `#21` adds five test files, so the
  number will be higher. Measure it rather than trusting the figure here.
- **Version number.** Task 7 assumes `0.19.2 → 0.19.3` (patch, bug fix only).
  If `#21` releases first as a minor, this becomes a patch on top of whatever
  that release is — take the version from `package.json` at that time.

## File Structure

| File | Responsibility |
|---|---|
| `src/speed/clock-authority.ts` *(new)* | Sole definition of "the speed map owns output time". No dependencies beyond the `SpeedSegment` type, so both `render/` and `pipeline/` can import it without a layering violation. |
| `src/pipeline/blank-lead.ts` *(new)* | Blank-lead policy for the pipeline: resolve the offset (zero under speed authority) and apply it to subtitles / overlay events. Removes four copies of the same shift loop from `executor.ts`. |
| `src/render/renderer.ts` *(modify)* | Gains `probeVideoFps()` and `planSpeedSegments()`; `renderWithSpeed()` encodes from the plan; Phase 1 blank trim is guarded. |
| `src/pipeline/executor.ts` *(modify)* | Four compensation sites call the new helpers. |
| `tests/unit/speed/clock-authority.test.ts` *(new)* | Predicate boundaries. |
| `tests/unit/render/speed-segment-plan.test.ts` *(new)* | Pure planner arithmetic — no ffmpeg. |
| `tests/unit/render/speed-segment-encode.test.ts` *(new)* | ffmpeg proof that the plan produces frame-exact segments. |
| `tests/unit/pipeline/blank-lead.test.ts` *(new)* | Offset resolution + shift helpers, including the non-speed regression guard. |
| `tests/unit/render/blank-lead-speed-render.test.ts` *(new)* | The issue #20 end-to-end regression fixture. |

Task order is dependency order: Task 1 → 2 → 3 are the renderer chain, Task 4 → 5 the pipeline chain, Task 6 the end-to-end proof, Task 7 the release notes. Tasks 1-3 and 4-5 are independent of each other and can be done in either order.

---

### Task 1: The speed-clock-authority predicate

**Files:**
- Create: `src/speed/clock-authority.ts`
- Test: `tests/unit/speed/clock-authority.test.ts`
- Modify: `src/render/renderer.ts:668-669`

**Interfaces:**
- Consumes: `SpeedSegment` from `src/types/speed.ts`
- Produces: `isSpeedClockAuthority(speedSegments: SpeedSegment[] | undefined): boolean` — used by Tasks 4 and 5, and by the renderer in this task.

**Background:** `SpeedSegment` has `originalStart`/`originalEnd` typed as `MonotonicMs` (a branded number — build them with `toMonotonic(...)` from `src/types/trace.ts`), plus `speed`, `outputStart`, `outputEnd` as plain numbers. All five fields are required, so test fixtures must set `outputStart`/`outputEnd` even when the predicate ignores them.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/speed/clock-authority.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { isSpeedClockAuthority } from '../../../src/speed/clock-authority'
import { toMonotonic } from '../../../src/types/trace'
import type { SpeedSegment } from '../../../src/types/speed'

const seg = (speed: number): SpeedSegment => ({
  originalStart: toMonotonic(0),
  originalEnd: toMonotonic(1000),
  speed,
  outputStart: 0,
  outputEnd: 0,
})

describe('isSpeedClockAuthority', () => {
  it('is false when there is no speed map at all', () => {
    expect(isSpeedClockAuthority(undefined)).toBe(false)
  })

  it('is false for an empty segment list', () => {
    expect(isSpeedClockAuthority([])).toBe(false)
  })

  it('is false when every segment is real-time', () => {
    expect(isSpeedClockAuthority([seg(1.0), seg(1.0), seg(1.0)])).toBe(false)
  })

  it('is true when any segment is non-real-time', () => {
    expect(isSpeedClockAuthority([seg(1.0), seg(4.0), seg(1.0)])).toBe(true)
  })

  it('treats a deviation within 0.01 as real-time (matches the renderer threshold)', () => {
    expect(isSpeedClockAuthority([seg(1.005)])).toBe(false)
    expect(isSpeedClockAuthority([seg(0.995)])).toBe(false)
  })

  it('treats a deviation beyond 0.01 as non-real-time', () => {
    expect(isSpeedClockAuthority([seg(1.02)])).toBe(true)
    expect(isSpeedClockAuthority([seg(0.5)])).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/speed/clock-authority.test.ts`
Expected: FAIL — `Failed to resolve import ".../src/speed/clock-authority"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/speed/clock-authority.ts`:

```ts
import type { SpeedSegment } from '../types/speed.js'

/**
 * True when the speed map — not the source video — defines output time.
 *
 * In this mode the speed map already selects which source intervals are
 * retained, relative to the recording's first screencast frame, and every
 * consumer's timestamps (subtitles, zoom, voiceover, cursor, clicks) are
 * expressed in its output clock. Blank-lead trimming and blank-lead
 * compensation MUST be skipped: they operate in source-video time and would
 * introduce a second, incompatible origin.
 *
 * The 0.01 tolerance matches the inline checks this function replaces.
 */
export function isSpeedClockAuthority(
  speedSegments: SpeedSegment[] | undefined,
): boolean {
  return (
    speedSegments !== undefined &&
    speedSegments.length > 0 &&
    speedSegments.some((s) => Math.abs(s.speed - 1.0) > 0.01)
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/speed/clock-authority.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Use the predicate in the renderer**

In `src/render/renderer.ts`, add to the import block at the top of the file:

```ts
import { isSpeedClockAuthority } from '../speed/clock-authority.js'
```

Then replace the inline check at `renderer.ts:668-669`:

```ts
  const hasSpeed = trace.speedSegments && trace.speedSegments.length > 0 &&
    trace.speedSegments.some((s) => Math.abs(s.speed - 1.0) > 0.01)
```

with:

```ts
  const hasSpeed = isSpeedClockAuthority(trace.speedSegments)
```

Note the type narrows from `boolean | undefined` to `boolean`. If `tsc` reports an unused-variable or narrowing error at the `if (hasSpeed && trace.speedSegments)` site further down, leave that site as-is — the extra `trace.speedSegments` guard is still needed for TypeScript to narrow the optional field.

- [ ] **Step 6: Verify nothing regressed**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; 496 + 6 = 502 tests passing.

- [ ] **Step 7: Commit**

```bash
git add src/speed/clock-authority.ts tests/unit/speed/clock-authority.test.ts src/render/renderer.ts
git commit -m "refactor(speed): extract isSpeedClockAuthority predicate"
```

---

### Task 2: Frame-exact speed-segment planner

**Files:**
- Modify: `src/render/renderer.ts` (add `probeVideoFps()` after `getVideoDuration()` around line 130; add `planSpeedSegments()` above `renderWithSpeed()` at line 419)
- Test: `tests/unit/render/speed-segment-plan.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `probeVideoFps(videoPath: string): number` — rounded integer fps, falls back to `25`.
  - `interface SpeedSegmentPlan { startSec: number; endSec: number; speed: number; frames: number }`
  - `planSpeedSegments(segments: Array<{ startSec: number; endSec: number; speed: number }>, fps: number): SpeedSegmentPlan[]`

  Task 3 consumes both.

**Why cumulative:** the bug is that each segment independently rounds up. Rounding each segment's *ideal* duration independently would fix the +2-frame overshoot but reintroduce drift of up to half a frame per segment. Tracking the cumulative output position and taking the difference means every rounding error is corrected by the very next segment, so the total is always `round(totalOutputSec * fps)`.

**Zero-frame segments:** a segment whose share rounds to `0` frames must be dropped, not encoded — `-frames:v 0` writes an empty file and the concat demuxer fails on it. Dropping it must not change the frame budget of later segments, which falls out naturally from the cumulative formula as long as `cumFrames` is only advanced by frames actually emitted.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/render/speed-segment-plan.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { planSpeedSegments } from '../../../src/render/renderer'

const totalFrames = (plan: Array<{ frames: number }>) =>
  plan.reduce((a, s) => a + s.frames, 0)

describe('planSpeedSegments', () => {
  it('plans the issue #20 reproduction exactly: 4x 2s @ 2x on 25fps = 25 frames each', () => {
    // Regression: each segment was encoded independently and came out 27
    // frames (1.08s) instead of 25 (1.00s), so four segments drifted +0.32s
    // against the ideal durations subtitle remapping assumes.
    const segments = [0, 2, 4, 6].map((s) => ({ startSec: s, endSec: s + 2, speed: 2 }))
    const plan = planSpeedSegments(segments, 25)

    expect(plan.map((s) => s.frames)).toEqual([25, 25, 25, 25])
  })

  it('never drifts: cumulative frames always equal round(totalOutputSec * fps)', () => {
    const speeds = [1, 4, 2, 1, 8, 2, 1, 4, 1, 2, 16, 1, 2, 4, 1, 2, 1, 8, 2, 1]
    let t = 0
    const segments = speeds.map((speed, i) => {
      const startSec = t
      const endSec = t + 0.7 + (i % 5) * 0.3 // irregular, non-frame-aligned
      t = endSec
      return { startSec, endSec, speed }
    })

    const plan = planSpeedSegments(segments, 25)
    const idealTotalSec = segments.reduce(
      (a, s) => a + (s.endSec - s.startSec) / s.speed, 0,
    )

    expect(totalFrames(plan)).toBe(Math.round(idealTotalSec * 25))
  })

  it('corrects each rounding error on the next segment rather than accumulating it', () => {
    // 1.5s at 25fps = 37.5 frames. Independent rounding would give 38/38/38
    // (+1.5 frames after three); cumulative gives 38/37/38 = 113 = round(112.5).
    const segments = [0, 1.5, 3].map((s) => ({ startSec: s, endSec: s + 1.5, speed: 1 }))
    const plan = planSpeedSegments(segments, 25)

    expect(totalFrames(plan)).toBe(113)
    expect(plan.map((s) => s.frames)).toEqual([38, 37, 38])
  })

  it('drops sub-frame segments instead of planning zero frames', () => {
    // -frames:v 0 produces an empty file that breaks the concat demuxer.
    const segments = [
      { startSec: 0, endSec: 2, speed: 1 },
      { startSec: 2, endSec: 2.06, speed: 100 }, // 0.0006s ≈ 0.015 frames
      { startSec: 2.06, endSec: 4.06, speed: 1 },
    ]
    const plan = planSpeedSegments(segments, 25)

    expect(plan).toHaveLength(2)
    expect(plan.every((s) => s.frames > 0)).toBe(true)
  })

  it('does not let a dropped segment steal frames from later segments', () => {
    const segments = [
      { startSec: 0, endSec: 2, speed: 1 },
      { startSec: 2, endSec: 2.06, speed: 100 },
      { startSec: 2.06, endSec: 4.06, speed: 1 },
    ]
    const plan = planSpeedSegments(segments, 25)

    expect(plan.map((s) => s.frames)).toEqual([50, 50])
  })

  it('preserves the source seek window and speed of each retained segment', () => {
    const plan = planSpeedSegments([{ startSec: 3, endSec: 7, speed: 4 }], 25)

    expect(plan[0]!.startSec).toBe(3)
    expect(plan[0]!.endSec).toBe(7)
    expect(plan[0]!.speed).toBe(4)
    expect(plan[0]!.frames).toBe(25) // 4s / 4x = 1s
  })

  it('returns an empty plan for an empty input', () => {
    expect(planSpeedSegments([], 25)).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/render/speed-segment-plan.test.ts`
Expected: FAIL — `planSpeedSegments is not a function` / no matching export.

- [ ] **Step 3: Write minimal implementation**

In `src/render/renderer.ts`, insert `probeVideoFps()` immediately after the `getVideoDuration()` function (which ends around line 130):

```ts
/**
 * Probe a video's frame rate, rounded to the nearest integer.
 * Handles fractional `r_frame_rate` values like "25/1" or "30000/1001".
 * Falls back to 25 when ffprobe fails or reports a non-positive rate.
 */
export function probeVideoFps(videoPath: string): number {
  try {
    const fpsStr = execFileSync('ffprobe', [
      '-v', 'quiet', '-select_streams', 'v:0',
      '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', videoPath,
    ]).toString().trim()
    const parts = fpsStr.split('/')
    const probedFps = parts.length === 2
      ? Number(parts[0]) / Number(parts[1])
      : Number(fpsStr)
    if (probedFps > 0) return Math.round(probedFps)
  } catch { /* use default */ }
  return 25
}
```

Then insert `planSpeedSegments()` directly above `renderWithSpeed()` (line 419):

```ts
/** One speed segment to encode, with its exact output frame count. */
export interface SpeedSegmentPlan {
  /** Source-video seek start (seconds), inclusive. */
  startSec: number
  /** Source-video seek end (seconds). */
  endSec: number
  /** Speed multiplier applied via setpts. */
  speed: number
  /** Exact number of output frames to encode. Always > 0. */
  frames: number
}

/**
 * Pure planner for {@link renderWithSpeed}: assign each segment the exact
 * output frame count implied by the speed map.
 *
 * ffmpeg rounds each independently encoded segment up to a whole frame, so a
 * 2s @ 2x segment on a 25fps source came out 27 frames (1.08s) instead of 25
 * (1.00s). Subtitle remapping uses the ideal continuous durations from
 * computeOutputTimes(), so that overshoot accumulated across cut boundaries —
 * roughly 0.32s after four segments — and pushed cues onto the wrong scene.
 *
 * Frame counts are derived from a running cumulative output position rather
 * than from each segment's duration in isolation, so any rounding error is
 * absorbed by the following segment and the total always equals
 * round(totalOutputSec * fps).
 *
 * Segments that round to zero frames are dropped: `-frames:v 0` writes an
 * empty file and the concat demuxer fails on it. Because cumFrames only
 * advances by frames actually emitted, dropping one does not shift the frame
 * budget of the segments after it.
 */
export function planSpeedSegments(
  segments: Array<{ startSec: number; endSec: number; speed: number }>,
  fps: number,
): SpeedSegmentPlan[] {
  const plan: SpeedSegmentPlan[] = []
  let cumOutSec = 0
  let cumFrames = 0

  for (const seg of segments) {
    cumOutSec += (seg.endSec - seg.startSec) / seg.speed
    const frames = Math.round(cumOutSec * fps) - cumFrames
    if (frames <= 0) continue
    cumFrames += frames
    plan.push({
      startSec: seg.startSec,
      endSec: seg.endSec,
      speed: seg.speed,
      frames,
    })
  }

  return plan
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/render/speed-segment-plan.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/render/renderer.ts tests/unit/render/speed-segment-plan.test.ts
git commit -m "feat(render): add planSpeedSegments frame-exact planner and probeVideoFps"
```

---

### Task 3: Encode speed segments from the plan

**Files:**
- Modify: `src/render/renderer.ts:449-475` (the encode loop inside `renderWithSpeed()`), and `renderer.ts:166-176` (replace the inline fps probe in `renderWithZoom` with `probeVideoFps`)
- Test: `tests/unit/render/speed-segment-encode.test.ts`

**Interfaces:**
- Consumes: `planSpeedSegments()`, `probeVideoFps()`, `SpeedSegmentPlan` from Task 2.
- Produces: no new exports; `renderWithSpeed()` keeps its signature `(sourceVideo: string, speedSegments: SpeedSegment[], baselineMs: number, tmpDir: string) => string`.

**Background:** `renderWithSpeed()` already builds a `videoSegments` array of `{ startSec, endSec, speed }` (lines 437-443) by mapping trace time through `baselineMs` and filtering out anything shorter than 0.05s. That array is exactly `planSpeedSegments()`'s input. Keep the existing `> 0.05` filter — it drops degenerate segments; the planner drops sub-frame ones. They are separate concerns.

The `fps=${fps}` term in the filter chain is required alongside `-frames:v`: `setpts` alone changes presentation timestamps without resampling, so the frame count would not match the requested duration.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/render/speed-segment-encode.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { planSpeedSegments, probeVideoFps } from '../../../src/render/renderer'

const TMP_DIR = path.join('/tmp', 'recast-speed-encode-test')
const SRC = path.join(TMP_DIR, 'src.mp4')

const countFrames = (file: string): number =>
  Number(
    execFileSync('ffprobe', [
      '-v', 'error', '-count_frames', '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file,
    ]).toString().trim(),
  )

describe('speed segment encoding is frame-exact', () => {
  beforeAll(() => {
    fs.mkdirSync(TMP_DIR, { recursive: true })
    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'testsrc=s=640x360:r=25:d=20',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', SRC,
    ], { stdio: 'pipe' })
  })

  afterAll(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true })
  })

  it('probes the source frame rate', () => {
    expect(probeVideoFps(SRC)).toBe(25)
  })

  it('encodes each planned segment with exactly the planned frame count', () => {
    // Without -frames:v each of these came out 27 frames instead of 25.
    const fps = probeVideoFps(SRC)
    const plan = planSpeedSegments(
      [0, 2, 4, 6].map((s) => ({ startSec: s, endSec: s + 2, speed: 2 })),
      fps,
    )

    const actual = plan.map((seg, i) => {
      const out = path.join(TMP_DIR, `seg-${i}.mp4`)
      execFileSync('ffmpeg', [
        '-y', '-ss', String(seg.startSec), '-to', String(seg.endSec),
        '-i', SRC,
        '-filter:v', `setpts=PTS/${seg.speed},fps=${fps}`,
        '-frames:v', String(seg.frames),
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-an', out,
      ], { stdio: 'pipe' })
      return countFrames(out)
    })

    expect(actual).toEqual(plan.map((s) => s.frames))
    expect(actual).toEqual([25, 25, 25, 25])
  })
}, 120_000)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/render/speed-segment-encode.test.ts`
Expected: FAIL — `probeVideoFps` / `planSpeedSegments` resolve only if Task 2 is done. If Task 2 is complete, this test will already PASS, because it exercises the ffmpeg arguments directly rather than through `renderWithSpeed()`. That is intentional: it pins the exact argument set that Step 3 wires into production code, so a later "cleanup" of those flags goes red.

- [ ] **Step 3: Wire the plan into `renderWithSpeed()`**

In `src/render/renderer.ts`, replace the encode loop (lines 449-468) — the block that starts `// Process each segment` and ends with `segmentPaths.push(segPath)` — with:

```ts
  // Process each segment. Frame counts come from the shared plan so segment
  // boundaries land exactly where the time remap says they do — encoding each
  // segment independently let ffmpeg round every one of them up.
  const fps = probeVideoFps(sourceVideo)
  const plan = planSpeedSegments(videoSegments, fps)
  if (plan.length === 0) return sourceVideo

  const segmentPaths: string[] = []
  for (let i = 0; i < plan.length; i++) {
    const seg = plan[i]!
    const segPath = path.join(tmpDir, `speed-seg-${i}.mp4`)

    ffmpeg([
      '-y', '-ss', String(seg.startSec), '-to', String(seg.endSec),
      '-i', sourceVideo,
      '-filter:v', `setpts=PTS/${seg.speed},fps=${fps}`,
      '-frames:v', String(seg.frames),
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-an',
      segPath,
    ])

    console.log(`    Seg ${i}: ${seg.startSec.toFixed(1)}s-${seg.endSec.toFixed(1)}s @ ${seg.speed}x → ${(seg.frames / fps).toFixed(2)}s (${seg.frames}f)`)
    segmentPaths.push(segPath)
  }
```

Also update the log line above it (line 447) to report the planned count:

```ts
  console.log(`  Speed: ${videoSegments.length} segments, source ${videoDuration.toFixed(1)}s`)
```

stays as-is — it describes the input, and `plan.length` is reported per segment.

- [ ] **Step 4: Replace the duplicated fps probe in `renderWithZoom`**

At `renderer.ts:166-176`, replace the inline probe block:

```ts
  // Probe fps from source video for zoompan frame-to-time conversion
  let fps = 25
  try {
    const fpsStr = execFileSync('ffprobe', [
      '-v', 'quiet', '-select_streams', 'v:0',
      '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', sourceVideo,
    ]).toString().trim()
    const parts = fpsStr.split('/')
    const probedFps = parts.length === 2 ? Number(parts[0]) / Number(parts[1]) : Number(fpsStr)
    if (probedFps > 0) fps = Math.round(probedFps)
  } catch { /* use default */ }
```

with:

```ts
  // Probe fps from source video for zoompan frame-to-time conversion
  const fps = probeVideoFps(sourceVideo)
```

- [ ] **Step 5: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: typecheck clean. All previously passing tests still pass — the zoom path's fps value is unchanged (same probe, same rounding, same fallback).

- [ ] **Step 6: Commit**

```bash
git add src/render/renderer.ts tests/unit/render/speed-segment-encode.test.ts
git commit -m "fix(render): encode speed segments with exact frame counts (#20)"
```

---

### Task 4: Blank-lead policy helpers for the pipeline

**Files:**
- Create: `src/pipeline/blank-lead.ts`
- Test: `tests/unit/pipeline/blank-lead.test.ts`

**Interfaces:**
- Consumes: `isSpeedClockAuthority()` from Task 1.
- Produces:
  - `resolveBlankLeadInMs(speedSegments: SpeedSegment[] | undefined, detect: () => number): number`
  - `shiftSubtitlesForBlankLead(subtitles: SubtitleEntry[], offsetMs: number): void`
  - `shiftOverlayTimesForBlankLead(events: { videoTimeMs: number }[], offsetMs: number): void`

  Task 5 consumes all three.

**Background:** `detect` is a callback rather than the video path because the four call sites in `executor.ts` each build their own temp directory in a different place, and because skipping the *detection* (not just the subtraction) is the point — `detectBlankLeadIn()` shells out to ffmpeg up to 31 times, and under speed authority that work is pure waste. The callback returns **seconds** (matching `detectBlankLeadIn`'s contract); the function returns **milliseconds** (matching what every call site needs).

`SubtitleEntry.zoom` is an optional `StepZoom` whose `startMs`/`endMs` are themselves optional, so both need `!== undefined` guards — copy the existing behavior at `executor.ts:981-987` exactly.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/pipeline/blank-lead.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import {
  resolveBlankLeadInMs,
  shiftSubtitlesForBlankLead,
  shiftOverlayTimesForBlankLead,
} from '../../../src/pipeline/blank-lead'
import { toMonotonic } from '../../../src/types/trace'
import type { SpeedSegment } from '../../../src/types/speed'
import type { SubtitleEntry } from '../../../src/types/subtitle'

const seg = (speed: number): SpeedSegment => ({
  originalStart: toMonotonic(0),
  originalEnd: toMonotonic(1000),
  speed,
  outputStart: 0,
  outputEnd: 0,
})

const sub = (startMs: number, endMs: number): SubtitleEntry => ({
  index: 1,
  startMs,
  endMs,
  text: 'x',
})

describe('resolveBlankLeadInMs', () => {
  it('converts detected seconds to milliseconds when speed is not the authority', () => {
    expect(resolveBlankLeadInMs(undefined, () => 3)).toBe(3000)
    expect(resolveBlankLeadInMs([], () => 1.5)).toBe(1500)
    expect(resolveBlankLeadInMs([seg(1.0)], () => 0.4)).toBe(400)
  })

  it('returns zero without detecting when speed is the authority', () => {
    // Regression (#20): the detected value is in source-video time, but the
    // timestamps it was subtracted from are already in speed-mapped output
    // time — a unit error that shifted every cue by the full blank duration.
    const detect = vi.fn(() => 3)

    expect(resolveBlankLeadInMs([seg(1.0), seg(4.0)], detect)).toBe(0)
    expect(detect).not.toHaveBeenCalled()
  })

  it('detects exactly once per call in the non-speed path', () => {
    const detect = vi.fn(() => 2)
    resolveBlankLeadInMs([seg(1.0)], detect)
    expect(detect).toHaveBeenCalledTimes(1)
  })
})

describe('shiftSubtitlesForBlankLead', () => {
  it('shifts start and end times back by the offset', () => {
    const subs = [sub(5000, 8000), sub(9000, 11000)]
    shiftSubtitlesForBlankLead(subs, 3000)
    expect(subs.map((s) => [s.startMs, s.endMs])).toEqual([[2000, 5000], [6000, 8000]])
  })

  it('clamps to zero instead of going negative', () => {
    const subs = [sub(1000, 2000)]
    shiftSubtitlesForBlankLead(subs, 3000)
    expect(subs[0]!.startMs).toBe(0)
    expect(subs[0]!.endMs).toBe(0)
  })

  it('shifts zoom windows when present', () => {
    const s = sub(5000, 8000)
    s.zoom = { level: 2, startMs: 5200, endMs: 7800 }
    shiftSubtitlesForBlankLead([s], 3000)
    expect(s.zoom.startMs).toBe(2200)
    expect(s.zoom.endMs).toBe(4800)
  })

  it('leaves a zoom without explicit times alone', () => {
    const s = sub(5000, 8000)
    s.zoom = { level: 2 }
    shiftSubtitlesForBlankLead([s], 3000)
    expect(s.zoom.startMs).toBeUndefined()
    expect(s.zoom.endMs).toBeUndefined()
  })

  it('is a no-op for a zero offset', () => {
    const subs = [sub(5000, 8000)]
    shiftSubtitlesForBlankLead(subs, 0)
    expect(subs[0]!.startMs).toBe(5000)
  })
})

describe('shiftOverlayTimesForBlankLead', () => {
  it('shifts and clamps videoTimeMs', () => {
    const events = [{ videoTimeMs: 4000 }, { videoTimeMs: 1000 }]
    shiftOverlayTimesForBlankLead(events, 3000)
    expect(events.map((e) => e.videoTimeMs)).toEqual([1000, 0])
  })

  it('rounds to whole milliseconds', () => {
    const events = [{ videoTimeMs: 4000.6 }]
    shiftOverlayTimesForBlankLead(events, 3000)
    expect(events[0]!.videoTimeMs).toBe(1001)
  })

  it('is a no-op for a zero offset', () => {
    const events = [{ videoTimeMs: 4000 }]
    shiftOverlayTimesForBlankLead(events, 0)
    expect(events[0]!.videoTimeMs).toBe(4000)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/pipeline/blank-lead.test.ts`
Expected: FAIL — `Failed to resolve import ".../src/pipeline/blank-lead"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/pipeline/blank-lead.ts`:

```ts
import type { SpeedSegment } from '../types/speed.js'
import type { SubtitleEntry } from '../types/subtitle.js'
import { isSpeedClockAuthority } from '../speed/clock-authority.js'

/**
 * Resolve how much blank lead-in the pipeline should compensate for, in
 * milliseconds.
 *
 * When the speed map is the clock authority the answer is always zero AND the
 * detection is skipped entirely. Two reasons:
 *
 *  1. Correctness. detectBlankLeadIn() measures source-video time, but under
 *     speed mapping every consumer's timestamps already live in the output
 *     clock produced by timeRemap(). Subtracting one from the other is a unit
 *     error — with duringIdle: 4, a 3s source prefix is ~0.75s of output, yet
 *     the full 3000ms was removed (issue #20).
 *  2. Cost. Detection shells out to ffmpeg up to 31 times.
 *
 * @param detect Returns the blank lead-in in SECONDS (detectBlankLeadIn's
 *               contract). Not called at all under speed authority.
 * @returns Milliseconds to compensate; 0 means "do nothing".
 */
export function resolveBlankLeadInMs(
  speedSegments: SpeedSegment[] | undefined,
  detect: () => number,
): number {
  if (isSpeedClockAuthority(speedSegments)) return 0
  return detect() * 1000
}

/**
 * Shift subtitle windows (and their zoom windows) back by the blank lead-in.
 * Times clamp at zero. A zero offset is a no-op.
 */
export function shiftSubtitlesForBlankLead(
  subtitles: SubtitleEntry[],
  offsetMs: number,
): void {
  if (offsetMs <= 0) return
  for (const sub of subtitles) {
    sub.startMs = Math.max(0, sub.startMs - offsetMs)
    sub.endMs = Math.max(0, sub.endMs - offsetMs)
    if (sub.zoom?.startMs !== undefined) {
      sub.zoom.startMs = Math.max(0, sub.zoom.startMs - offsetMs)
    }
    if (sub.zoom?.endMs !== undefined) {
      sub.zoom.endMs = Math.max(0, sub.zoom.endMs - offsetMs)
    }
  }
}

/**
 * Shift overlay event times (clicks, highlights) back by the blank lead-in.
 * Times are rounded to whole milliseconds and clamp at zero.
 */
export function shiftOverlayTimesForBlankLead(
  events: Array<{ videoTimeMs: number }>,
  offsetMs: number,
): void {
  if (offsetMs <= 0) return
  for (const event of events) {
    event.videoTimeMs = Math.max(0, Math.round(event.videoTimeMs - offsetMs))
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/pipeline/blank-lead.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/blank-lead.ts tests/unit/pipeline/blank-lead.test.ts
git commit -m "feat(pipeline): add blank-lead policy helpers"
```

---

### Task 5: Route all four executor sites through the helpers

**Files:**
- Modify: `src/pipeline/executor.ts:104-129` (render-prep: clicks / cursor / highlights)
- Modify: `src/pipeline/executor.ts:966-990` (`voiceover` stage)
- Modify: `src/pipeline/executor.ts:1035-1057` (`render` stage, subtitle-only path)
- Modify: `src/render/renderer.ts:670-683` (Phase 1 blank trim guard)

**Interfaces:**
- Consumes: `resolveBlankLeadInMs()`, `shiftSubtitlesForBlankLead()`, `shiftOverlayTimesForBlankLead()` from Task 4; `isSpeedClockAuthority()` from Task 1.
- Produces: no new exports. `state._blankLeadInMs` stays `0` under speed authority, which makes the `- blankMs` term in the approach-hold formula at `executor.ts:1019` a no-op with no change to that code.

**Note on the fourth site:** the approach-hold block at `executor.ts:1000-1022` reads `state._blankLeadInMs` rather than detecting on its own, so it needs no edit. Verify this by reading it — do not edit it.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/pipeline/blank-lead.test.ts`:

```ts
describe('blank-lead compensation is skipped only under speed authority', () => {
  it('leaves speed-mapped subtitles untouched end to end', () => {
    // The full pipeline path: subtitles already remapped by timeRemap(),
    // a 3s blank prefix detected in the source. Under speed authority the
    // cue must keep its remapped time (7025ms), not slide to 4025ms.
    const subs = [sub(7025, 9500)]
    const offset = resolveBlankLeadInMs([seg(1.0), seg(4.0)], () => 3)
    shiftSubtitlesForBlankLead(subs, offset)

    expect(subs[0]!.startMs).toBe(7025)
  })

  it('still compensates when there is no speed map (regression guard)', () => {
    // Pipelines without speedUp() must keep today's behavior exactly.
    const subs = [sub(7025, 9500)]
    const offset = resolveBlankLeadInMs(undefined, () => 3)
    shiftSubtitlesForBlankLead(subs, offset)

    expect(subs[0]!.startMs).toBe(4025)
  })
})
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run tests/unit/pipeline/blank-lead.test.ts`
Expected: PASS, 14 tests. These two characterize the contract the executor edits below must honor; they pass on Task 4's code because they exercise the helpers directly.

- [ ] **Step 3: Add the imports to `executor.ts`**

In `src/pipeline/executor.ts`, add after the existing `renderVideo` import (line 27):

```ts
import {
  resolveBlankLeadInMs,
  shiftSubtitlesForBlankLead,
  shiftOverlayTimesForBlankLead,
} from './blank-lead.js'
```

`detectBlankLeadIn` stays imported — it is now passed as the `detect` callback.

- [ ] **Step 4: Rewrite the render-prep site**

Replace `executor.ts:104-129` — the block from the `if (` starting `state.sourceVideoPath &&` through its closing brace — with:

```ts
    if (
      state.sourceVideoPath &&
      (state.clickEvents || state.cursorKeyframes || state.highlightEvents)
    ) {
      const blankTmpDir = path.join(outputDir, '.recast-blank-probe')
      const offsetMs = resolveBlankLeadInMs(
        state.speedMapped?.speedSegments,
        () => {
          fs.mkdirSync(blankTmpDir, { recursive: true })
          try {
            return detectBlankLeadIn(state.sourceVideoPath!, blankTmpDir)
          } finally {
            fs.rmSync(blankTmpDir, { recursive: true, force: true })
          }
        },
      )
      if (offsetMs > 0) {
        if (state.clickEvents) shiftOverlayTimesForBlankLead(state.clickEvents, offsetMs)
        if (state.highlightEvents) {
          shiftOverlayTimesForBlankLead(state.highlightEvents, offsetMs)
          for (const he of state.highlightEvents) {
            he.endTimeMs = Math.max(0, Math.round(he.endTimeMs - offsetMs))
          }
        }
        if (state.cursorKeyframes) {
          for (const kf of state.cursorKeyframes) {
            kf.videoTimeSec = Math.max(0, kf.videoTimeSec - offsetMs / 1000)
          }
        }
      }
    }
```

`HighlightEvent` carries both `videoTimeMs` and `endTimeMs`; the shared helper covers the first, the explicit loop covers the second. `CursorKeyframe` uses seconds (`videoTimeSec`), so it is shifted separately — do not try to force it through the ms helper.

Keep the explanatory comment above the block, and add a sentence to it:

```ts
    // Compensate click events, cursor keyframes, and highlight events for
    // blank lead-in. The renderer trims blank frames from the start of the
    // video (Phase 1), and voiceover/subtitle timing is already adjusted for
    // this in the voiceover/render cases. But these are computed earlier
    // without the compensation, causing desync when blank lead-in is non-zero.
    // Under speed authority the offset resolves to 0 and nothing is detected
    // or shifted — see resolveBlankLeadInMs().
```

- [ ] **Step 5: Rewrite the `voiceover` stage site**

Replace `executor.ts:966-990` — from the comment `// Compensate for blank lead-in BEFORE generating voiceover` through the closing brace after `state._blankTrimApplied = true` — with:

```ts
          // Compensate for blank lead-in BEFORE generating voiceover so the
          // audio track timing matches the trimmed video. Under speed
          // authority this resolves to 0: the speed map already defines
          // output time and the source-time blank offset does not belong in
          // it (#20).
          if (state.sourceVideoPath && !state._blankTrimApplied) {
            const blankTmpDir = path.join(path.dirname(state.sourceVideoPath), '.recast-blank-tmp')
            state._blankLeadInMs = resolveBlankLeadInMs(
              state.speedMapped?.speedSegments,
              () => {
                fs.mkdirSync(blankTmpDir, { recursive: true })
                try {
                  return detectBlankLeadIn(state.sourceVideoPath!, blankTmpDir)
                } finally {
                  fs.rmSync(blankTmpDir, { recursive: true, force: true })
                }
              },
            )
            shiftSubtitlesForBlankLead(state.subtitled.subtitles, state._blankLeadInMs)
            state._blankTrimApplied = true
          }
```

- [ ] **Step 6: Rewrite the `render` stage site**

Replace `executor.ts:1035-1057` — the `case 'render':` compensation block — with:

```ts
        case 'render':
          // Apply blank trim compensation for subtitle-only mode (no
          // voiceover). Resolves to 0 under speed authority — see
          // resolveBlankLeadInMs().
          if (state.subtitled && state.sourceVideoPath && !state._blankTrimApplied) {
            const blankTmpDir = path.join(path.dirname(state.sourceVideoPath), '.recast-blank-tmp')
            state._blankLeadInMs = resolveBlankLeadInMs(
              state.speedMapped?.speedSegments,
              () => {
                fs.mkdirSync(blankTmpDir, { recursive: true })
                try {
                  return detectBlankLeadIn(state.sourceVideoPath!, blankTmpDir)
                } finally {
                  fs.rmSync(blankTmpDir, { recursive: true, force: true })
                }
              },
            )
            shiftSubtitlesForBlankLead(state.subtitled.subtitles, state._blankLeadInMs)
            state._blankTrimApplied = true
          }
          break
```

- [ ] **Step 7: Guard the renderer's Phase 1 trim**

In `src/render/renderer.ts`, replace the Phase 1 block (lines 670-683) with:

```ts
  // Phase 1: Trim blank frames at the start of the video — but only when the
  // speed map is NOT the clock authority. With non-realtime speed segments,
  // renderWithSpeed() already selects the retained source intervals relative
  // to the recording's first frame, and every consumer's timestamps are
  // expressed in that output clock. Trimming here would introduce a second,
  // incompatible origin: the segment seeks below are computed against the
  // ORIGINAL recording clock and would land blankLeadIn seconds late (#20).
  let videoInput = sourceVideo
  if (!hasSpeed) {
    const blankLeadIn = detectBlankLeadIn(videoInput, tmpDir)
    if (blankLeadIn > 0) {
      const trimmedPath = path.join(tmpDir, 'trimmed-input.mp4')
      ffmpeg([
        '-y', '-ss', String(blankLeadIn), '-i', videoInput,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
        trimmedPath,
      ])
      videoInput = trimmedPath
    }
  }
```

- [ ] **Step 8: Verify the approach-hold site needs no change**

Read `executor.ts:1000-1022`. Confirm that `const blankMs = state._blankLeadInMs ?? 0` is the only place the offset enters the approach-hold formula, and that nothing there calls `detectBlankLeadIn` itself. Make no edit. If it does call detection directly, stop and report — the plan is wrong and needs revising before continuing.

- [ ] **Step 9: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests pass.

- [ ] **Step 10: Commit**

```bash
git add src/pipeline/executor.ts src/render/renderer.ts tests/unit/pipeline/blank-lead.test.ts
git commit -m "fix(pipeline): let the speed map own output time for blank lead-in (#20)"
```

---

### Task 6: End-to-end regression fixture

**Files:**
- Test: `tests/unit/render/blank-lead-speed-render.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-5. No production code changes.

**Background:** this is the only test that exercises the whole failure class described in issue #20 — blank detection, speed mapping, and frame-exact encoding interacting. It builds its own source video with `lavfi` (the pattern established in `tests/unit/render/blank-detection.test.ts`) rather than requiring a trace fixture, so it stays deterministic and fast.

Scene identity is asserted by **mean luma** — the frame is scaled to a single pixel and that byte is read back as raw gray. That requires the two scenes to be flat, known fills — a realistic screenshot would not give a stable single number. That is a deliberate trade: the test proves *which scene* a frame belongs to, not that the content looks right.

`detectBlankLeadIn`'s threshold is 15KB for a 1920x1080 PNG, so the blank prefix must be at that resolution to reproduce the false positive. The scenes use `mandelbrot` for a definitively non-blank frame and flat colors for identity.

- [ ] **Step 1: Write the test**

Create `tests/unit/render/blank-lead-speed-render.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { detectBlankLeadIn, planSpeedSegments, probeVideoFps } from '../../../src/render/renderer'
import { resolveBlankLeadInMs, shiftSubtitlesForBlankLead } from '../../../src/pipeline/blank-lead'
import { computeOutputTimes, buildTimeRemap } from '../../../src/speed/time-remap'
import { toMonotonic } from '../../../src/types/trace'
import type { SpeedSegment } from '../../../src/types/speed'
import type { SubtitleEntry } from '../../../src/types/subtitle'

const TMP_DIR = path.join('/tmp', 'recast-blank-speed-render-test')
const SRC = path.join(TMP_DIR, 'source.mp4')

/**
 * Mean luma (0-255) of the frame at `atSec`.
 *
 * Scales the frame to a single pixel and reads that byte back as raw gray.
 * No log parsing, no stderr capture — ffmpeg's own averaging does the work.
 * Verified on flat fills: 0x303030 → 37, 0xC0C0C0 → 205.
 */
function meanLumaAt(video: string, atSec: number): number {
  const raw = path.join(TMP_DIR, `probe-${atSec.toFixed(3)}.raw`)
  execFileSync('ffmpeg', [
    '-y', '-ss', String(atSec), '-i', video, '-frames:v', '1',
    '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'gray', raw,
  ], { stdio: 'pipe' })
  return fs.readFileSync(raw)[0]!
}

describe('blank lead-in does not desync speed-mapped output (#20)', () => {
  beforeAll(() => {
    fs.mkdirSync(TMP_DIR, { recursive: true })

    // 3s low-entropy prefix (sampled PNGs under the 15KB blank threshold),
    // then scene A (dark grey), then scene B (light grey). 1920x1080 so the
    // blank threshold behaves as it does in production.
    const parts = [
      ['color=c=0xF8F8F8:s=1920x1080:d=3:r=25', 'prefix.mp4'],
      ['color=c=0x303030:s=1920x1080:d=6:r=25', 'scene-a.mp4'],
      ['color=c=0xC0C0C0:s=1920x1080:d=6:r=25', 'scene-b.mp4'],
    ] as const

    for (const [lavfi, name] of parts) {
      execFileSync('ffmpeg', [
        '-y', '-f', 'lavfi', '-i', lavfi,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        path.join(TMP_DIR, name),
      ], { stdio: 'pipe' })
    }

    const concatList = path.join(TMP_DIR, 'concat.txt')
    fs.writeFileSync(concatList, parts.map(([, n]) => `file '${n}'`).join('\n'))
    execFileSync('ffmpeg', [
      '-y', '-f', 'concat', '-safe', '0', '-i', concatList, '-c', 'copy', SRC,
    ], { stdio: 'pipe' })
  })

  afterAll(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true })
  })

  it('the fixture reproduces the false blank detection', () => {
    // The premise of the bug: a valid low-entropy opening reads as blank.
    expect(detectBlankLeadIn(SRC, TMP_DIR)).toBeGreaterThan(0)
  })

  it('keeps the cue on the post-transition scene under speed mapping', () => {
    const fps = probeVideoFps(SRC)

    // Speed map over the recording: prefix+scene A at 2x, scene B at 1x.
    // Trace time == source video time for this synthetic fixture.
    const segments: SpeedSegment[] = computeOutputTimes([
      { originalStart: toMonotonic(0), originalEnd: toMonotonic(9000), speed: 2, outputStart: 0, outputEnd: 0 },
      { originalStart: toMonotonic(9000), originalEnd: toMonotonic(15000), speed: 1, outputStart: 0, outputEnd: 0 },
    ])
    const remap = buildTimeRemap(segments)

    // A cue that starts exactly at the scene A → scene B transition.
    const cueOutputMs = remap(toMonotonic(9000))
    const subtitles: SubtitleEntry[] = [
      { index: 1, startMs: cueOutputMs, endMs: cueOutputMs + 2000, text: 'scene B' },
    ]

    // The pipeline's blank policy must leave it alone.
    const offsetMs = resolveBlankLeadInMs(segments, () => detectBlankLeadIn(SRC, TMP_DIR))
    expect(offsetMs).toBe(0)
    shiftSubtitlesForBlankLead(subtitles, offsetMs)
    expect(subtitles[0]!.startMs).toBe(cueOutputMs)

    // Render the speed-mapped video the way renderWithSpeed does — no blank
    // trim, frame-exact segments.
    const plan = planSpeedSegments(
      segments.map((s) => ({
        startSec: (s.originalStart as number) / 1000,
        endSec: (s.originalEnd as number) / 1000,
        speed: s.speed,
      })),
      fps,
    )

    const segPaths = plan.map((s, i) => {
      const out = path.join(TMP_DIR, `out-seg-${i}.mp4`)
      execFileSync('ffmpeg', [
        '-y', '-ss', String(s.startSec), '-to', String(s.endSec), '-i', SRC,
        '-filter:v', `setpts=PTS/${s.speed},fps=${fps}`,
        '-frames:v', String(s.frames),
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-an', out,
      ], { stdio: 'pipe' })
      return out
    })

    const list = path.join(TMP_DIR, 'out-concat.txt')
    fs.writeFileSync(list, segPaths.map((p) => `file '${path.basename(p)}'`).join('\n'))
    const rendered = path.join(TMP_DIR, 'rendered.mp4')
    execFileSync('ffmpeg', [
      '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', rendered,
    ], { stdio: 'pipe' })

    // The frame at the cue must be scene B (light, YAVG well above scene A's).
    const atCue = meanLumaAt(rendered, cueOutputMs / 1000 + 0.1)
    const beforeCue = meanLumaAt(rendered, cueOutputMs / 1000 - 0.5)

    expect(atCue).toBeGreaterThan(150) // scene B ≈ 0xC0
    expect(beforeCue).toBeLessThan(80) // scene A ≈ 0x30
  })
}, 180_000)
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/unit/render/blank-lead-speed-render.test.ts`
Expected: PASS, 2 tests. Allow up to ~90s — the fixture encodes six 1920x1080 clips.

If `meanLumaAt` returns something far from the expected 37 / 205, the likely cause is `-ss` landing on a different frame than intended, not the probe itself. Print both values and check them against the fixture's scene boundaries (prefix 0-3s, scene A 3-9s, scene B 9-15s in source time) before changing anything.

- [ ] **Step 3: Verify the test actually catches the bug**

Temporarily change `resolveBlankLeadInMs` in `src/pipeline/blank-lead.ts` to always detect (delete the `isSpeedClockAuthority` early return), then re-run this test.
Expected: the `expect(offsetMs).toBe(0)` assertion FAILS.

Restore the early return and confirm it passes again. A regression test that cannot fail is worth nothing — do not skip this step.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/render/blank-lead-speed-render.test.ts
git commit -m "test(render): regression fixture for blank-lead speed desync (#20)"
```

---

### Task 7: Release notes

**Files:**
- Modify: `CHANGELOG.md` (insert a new section above `## 0.19.2 (2026-07-15)`)
- Modify: `package.json:3` (version)

**Interfaces:**
- Consumes: nothing. Documentation only.

**Background:** this is a bug fix with no API change, so it is a patch release: `0.19.2` → `0.19.3`. Follow the existing CHANGELOG structure — `### Bug fixes` entries are bold-titled, link the issue, and explain the mechanism in one or two sentences. The `### Internal` section reports the new test count.

- [ ] **Step 1: Count the tests**

Run: `npm test 2>&1 | tail -20`
Record the passing count. The baseline was 496; this plan adds roughly 27 (6 + 7 + 2 + 14 − overlap + 2 integration). Use the actual number, not the estimate.

- [ ] **Step 2: Write the changelog entry**

Insert into `CHANGELOG.md` directly below the `# Changelog` heading:

```markdown
## 0.19.3 (2026-08-22)

### Bug fixes

- **Subtitles, zoom, and voiceover ran ahead of the video when `speedUp()` was combined with blank lead-in** ([#20](https://github.com/ThePatriczek/playwright-recast/issues/20)) — `detectBlankLeadIn()` measures source-video time, but the pipeline subtracted that value from subtitle, zoom, click, cursor, and highlight timestamps that had already been remapped into the speed-mapped output clock. A low-entropy opening that read as three seconds of blank frames therefore shifted every cue back by a full three seconds. The renderer compounded it: it trimmed the blank prefix from its input and then had `renderWithSpeed()` seek that trimmed file with offsets computed against the untrimmed recording clock. When non-real-time speed segments are active, the speed map is now the single clock authority — no blank trimming, no blank compensation — because it already selects the retained source intervals. Pipelines without `speedUp()` are unaffected.
- **Speed segments accumulated frame drift across cut boundaries** ([#20](https://github.com/ThePatriczek/playwright-recast/issues/20)) — Each speed segment was encoded to its own MP4 and concatenated, and ffmpeg rounded every segment up independently: a 2 s segment at 2× on a 25 fps source came out 27 frames (1.08 s) instead of 25 (1.00 s). Subtitle remapping uses the ideal continuous durations, so four segments drifted about 0.32 s. Segment frame counts are now derived from a running cumulative output position, so the total always matches `round(totalOutputSec × fps)` and rounding never accumulates.

### Internal

- New `isSpeedClockAuthority()` predicate (`src/speed/clock-authority.ts`) replaces three slightly different inline "is speed active" checks in the renderer and executor.
- New `src/pipeline/blank-lead.ts` collects the blank-lead policy and the subtitle/overlay shift loops that were duplicated across four sites in `executor.ts`.
- `planSpeedSegments()` and `probeVideoFps()` extracted from `renderWithSpeed()` / `renderWithZoom()` as pure, independently testable units.
- Test suite: **NNN passed** (+NN — clock-authority boundaries, cumulative frame planning, blank-lead policy under both clock modes, and an end-to-end fixture asserting the decoded frame at a cue belongs to the post-transition scene).
```

Replace `NNN` and `+NN` with the numbers from Step 1.

- [ ] **Step 3: Bump the version**

In `package.json`, change `"version": "0.19.2"` to `"version": "0.19.3"`.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test`
Expected: clean, all passing.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md package.json
git commit -m "release: v0.19.3 — speed map owns output time for blank lead-in"
```

---

## Verification checklist (issue #20 acceptance criteria)

Run through this after Task 7. Each maps to a test that must be green.

- [ ] Regression fixture covers blank detection, speed mapping, external-SRT-style cue placement, and rendering together → `tests/unit/render/blank-lead-speed-render.test.ts`
- [ ] The transformed cue starts at the post-hide speed boundary, not 3s earlier → `blank-lead-speed-render.test.ts`, `expect(subtitles[0]!.startMs).toBe(cueOutputMs)`
- [ ] The decoded frame at that cue start belongs to the post-transition scene → same test, the `meanLumaAt` assertions
- [ ] Repeated speed-segment encoding accumulates no frame drift → `speed-segment-plan.test.ts` (arithmetic) + `speed-segment-encode.test.ts` (ffmpeg proof)
- [ ] Subtitle-only and voiceover paths stay aligned → both route through `resolveBlankLeadInMs` + `shiftSubtitlesForBlankLead` with identical arguments (Task 5, Steps 5 and 6)
- [ ] Pipelines without active speed mapping retain existing blank-lead behavior → `blank-lead.test.ts`, "still compensates when there is no speed map (regression guard)"

**Not covered by this plan, by design:** hidden-step removal is not exercised end to end, because the integration fixture is built from `lavfi` sources rather than a real trace. `hideSteps()` collapses to a gap in the speed map, and `buildTimeRemap()` already snaps gap times to the next segment's `outputStart` — behavior covered by `tests/unit/speed/time-remap.test.ts`. If the reporter's reproduction still misbehaves after this fix, that interaction is the first place to look, and it needs a real trace fixture to test.
