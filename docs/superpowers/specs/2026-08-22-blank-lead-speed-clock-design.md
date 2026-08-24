# Make the speed map the single clock authority for blank lead-in

**Status:** design
**Date:** 2026-08-22
**Issue:** [#20](https://github.com/ThePatriczek/playwright-recast/issues/20)

## Problem

A pipeline combining `speedUp()`, `subtitlesFromSrt()`, and `voiceover()` places
subtitles, zoom, and audio ahead of the rendered video. Reported against 0.19.2
with a deterministic reproduction: a cue correctly mapped to 7.025s by
`subtitlesFromSrt()` is moved to 4.025s by `voiceover()` — an exact −3s shift,
identical for every later cue — and the frame at 4.025s still shows the
preceding scene.

Three independent defects stack, all pushing the same direction.

### 1. Blank lead-in is subtracted in the wrong coordinate system

`detectBlankLeadIn()` returns seconds of **source** video. The pipeline
subtracts that value from timestamps that already live in the **output**
(speed-mapped) clock:

- `executor.ts:967-990` — `voiceover` stage, subtitles and zoom windows
- `executor.ts:1036-1057` — `render` stage, subtitle-only path
- `executor.ts:111-129` — click events, cursor keyframes, highlight events
- `executor.ts:1003` + `:1019` — approach holds (`- blankMs` applied in output time)

Subtitle times reach these points already remapped:
`speedMapped.timeRemap(...) - videoStartOutput` (`executor.ts:389-390`, `:465`).
Subtracting source-clock milliseconds from output-clock milliseconds is a unit
error. With `duringIdle: 4`, a 3s source blank prefix occupies roughly 0.75s of
output — but the full 3000ms is removed.

### 2. The renderer trims, then seeks with untrimmed coordinates

`renderer.ts:673-682` trims `blankLeadIn` off the input. `renderWithSpeed()`
(`renderer.ts:437-443`) then computes
`startSec = (seg.originalStart - baselineMs) / 1000`, where `baselineMs` is the
first screencast frame timestamp of the **original** recording. Those seeks are
applied to the already-trimmed file, so every segment selects content
`blankLeadIn` later than intended. This is a second, independent shift in the
same direction as defect 1.

### 3. Separately encoded speed segments accumulate frame drift

`renderWithSpeed()` (`renderer.ts:451-475`) encodes each segment to its own MP4
via `-ss/-to` + `setpts`, then concatenates with `-c copy`. Each encode rounds
to whole frames independently, while subtitle remapping uses the ideal
continuous durations from `computeOutputTimes()`.

Measured on a 25fps source, four 2s segments at 2× (ideal 1.000s each):

```
seg0 ideal=1.00s  actual=1.080s  frames=27
seg1 ideal=1.00s  actual=1.080s  frames=27
seg2 ideal=1.00s  actual=1.080s  frames=27
seg3 ideal=1.00s  actual=1.080s  frames=27
```

+2 frames (+80ms) per segment; +0.32s after four segments. This matches the
reporter's measurement and survives any fix to defects 1 and 2.

### Why the two sides are otherwise consistent

When non-realtime speed segments are active, `renderWithSpeed()` clamps
`startSec` to `≥ 0` relative to `baselineMs = firstRecFrameTime`, so the output
video begins exactly at `timeRemap(firstRecFrameMs)` — which is precisely the
`videoStartOutput` that the subtitle, cursor, and click paths already subtract
(`executor.ts:387`, `:462`, `:847`). The two sides agree on their own. Only the
blank trim, inserted between them, breaks the agreement.

The comment at `executor.ts:371` — *"Video time 0 = first FRAME from the
recording page (after blank trim)"* — asserts an adjustment that
`videoStartOutput` never performs. That false premise is the hole the −3s falls
through.

The [narration approach-hold spec](2026-05-27-narration-approach-hold-sync-design.md)
listed *"Fixing the broader blank-lead-in / `videoStartOutput` coordinate
handling"* as an explicit non-goal. This design closes it for the speed-mapped
case.

## Goal

When the speed map is active, it is the **single clock authority**. Subtitles,
zoom, voiceover, cursor, clicks, holds, and the rendered frame all resolve to
the same output timestamp, and speed-segment boundaries land on the frame
positions the time remap predicts.

## Non-goals

- **Changing behavior when speed mapping is inactive.** Pipelines without
  `speedUp()` (or with all segments at 1.0×) keep today's blank-trim behavior
  byte-for-byte. This is an explicit acceptance criterion in issue #20.
- **Fixing the `detectBlankLeadIn()` heuristic.** The `size <= 15_000` PNG
  threshold is genuinely fragile — a low-entropy 1080p page can stay under it —
  and that fragility persists in the non-speed path. Replacing it with a
  difference-against-first-frame test changes behavior where it currently works;
  it belongs in its own issue.
- **A general shared rendered-media time map.** Threading one `RenderTimeMap`
  through every consumer is the cleaner long-term shape, but it touches most of
  `executor.ts` and `renderer.ts` and risks regressing working paths. Tracked
  separately.

## Design

### Change A — the renderer stops trimming when speed owns the clock

`hasSpeed` is already computed at `renderer.ts:668`, before the blank phase.
Guard Phase 1 with it:

```ts
// Phase 1: Trim blank frames — only when the speed map is NOT the clock
// authority. With non-realtime speed segments, renderWithSpeed() already
// selects the retained source intervals relative to the first recording
// frame, and every consumer's timestamps are expressed in that output clock.
// Trimming here would introduce a second, incompatible origin.
let videoInput = sourceVideo
if (!hasSpeed) {
  const blankLeadIn = detectBlankLeadIn(videoInput, tmpDir)
  if (blankLeadIn > 0) { /* unchanged */ }
}
```

Defect 2 disappears as a consequence: trimming and speed-segment seeking can no
longer co-occur.

### Change B — the pipeline stops compensating when speed owns the clock

Introduce one exported predicate so "speed is active" has a single definition.
It is currently inlined at three sites with slightly different spellings
(`executor.ts:386`, `:461`, `renderer.ts:668`).

```ts
/**
 * True when the speed map — not the source video — defines output time.
 * Blank-lead trimming and compensation must be skipped in this mode: the
 * speed map already selects the retained source intervals, and every
 * consumer's timestamps are expressed in its output clock.
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

All four compensation sites in `executor.ts` gain the same guard. When it holds,
`detectBlankLeadIn()` is not called at all and `state._blankLeadInMs` stays `0`,
so the `- blankMs` term in the approach-hold formula (`executor.ts:1019`)
becomes a no-op without further change.

The threshold `0.01` and the `> 0.05` segment filter in `renderWithSpeed()`
(`renderer.ts:443`) remain independent — the filter drops degenerate segments,
the predicate decides clock ownership.

### Change C — frame-exact speed segments

Force each segment to the frame count the time remap predicts, accounting
**cumulatively** so per-segment rounding cannot itself accumulate:

```ts
const fps = probeVideoFps(sourceVideo)
let cumOutSec = 0
let cumFrames = 0
for (const seg of videoSegments) {
  cumOutSec += (seg.endSec - seg.startSec) / seg.speed
  const targetFrames = Math.round(cumOutSec * fps) - cumFrames
  cumFrames += targetFrames
  ffmpeg([
    '-y', '-ss', String(seg.startSec), '-to', String(seg.endSec),
    '-i', sourceVideo,
    '-filter:v', `setpts=PTS/${seg.speed},fps=${fps}`,
    '-frames:v', String(targetFrames),
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-an',
    segPath,
  ])
}
```

Verified: every segment yields `actual=1.000000 frames=25`, and the concatenated
total matches `round(totalOutSec * fps)`.

`probeVideoFps()` is extracted from the inline probe at `renderer.ts:166-176`
(zoom's `zoompan` conversion), which already parses fractional `r_frame_rate`
like `25/1` and falls back to 25. Both call sites use the extracted helper.

Segments whose `targetFrames` rounds to `0` must be skipped rather than encoded
— `-frames:v 0` produces an empty file that breaks the concat demuxer. The
`> 0.05` duration filter makes this rare but not impossible at high speeds
(a 0.06s segment at 100× is 0.0006s ≈ 0.015 frames).

**Rejected alternative:** a single-pass `filter_complex` using `trim` + `concat`
is equally exact (measured: 100 frames / 4.000s for the same input) and avoids
the concat step entirely, but requires a full rewrite of `renderWithSpeed()` and
produces an unwieldy filtergraph at dozens of segments. Change C is local and
preserves the existing structure.

## Components

| Unit | Responsibility | Depends on |
|---|---|---|
| `isSpeedClockAuthority(segments)` | Sole definition of "the speed map owns output time" | `SpeedSegment` |
| `probeVideoFps(path)` | Frame rate probe, fractional-aware, 25fps fallback | `ffprobe` |
| `planSpeedSegments(videoSegments, fps)` | Pure planner: ideal output durations → cumulative frame counts | none |
| `renderWithSpeed()` | Encodes and concatenates from the plan | the three above |

`planSpeedSegments()` follows the `planVoiceoverFreezes()` precedent
(`renderer.ts:508`, tested in `tests/unit/render/freeze-plan.test.ts`): the
arithmetic lives in a pure exported function that unit tests exercise without
invoking ffmpeg.

```ts
export interface SpeedSegmentPlan {
  startSec: number
  endSec: number
  speed: number
  /** Exact output frames to encode; segments planned to 0 frames are omitted. */
  frames: number
}

export function planSpeedSegments(
  segments: Array<{ startSec: number; endSec: number; speed: number }>,
  fps: number,
): SpeedSegmentPlan[]
```

## Error handling

- `probeVideoFps()` failure falls back to 25fps, matching the existing inline
  behavior. A wrong fps degrades to today's drift rather than failing the render.
- `planSpeedSegments()` omits zero-frame segments; `renderWithSpeed()` returns
  the source unchanged if the plan is empty, matching the existing
  `videoSegments.length === 0` early return.
- No new failure modes reach the user: every change is either a skipped
  operation or a stricter encode argument.

## Testing

**Unit — `tests/unit/render/speed-segment-plan.test.ts`**
- Cumulative frame total equals `round(totalOutputSec * fps)` across 20 mixed-speed segments — no drift.
- The reproduction case: four 2s segments at 2× on 25fps plan to exactly 25 frames each.
- Non-integer results distribute correctly (e.g. 1.5s at 25fps alternating 37/38 frames, never 37/37).
- Sub-frame segments are omitted, and their omission does not shift the frame budget of later segments.

**Unit — `tests/unit/speed/speed-clock-authority.test.ts`**
- `undefined`, `[]`, all-1.0× → `false`; any segment off 1.0× by more than 0.01 → `true`.
- Boundary: `speed: 1.005` → `false`; `speed: 1.02` → `true`.

**Pipeline — `tests/unit/pipeline/blank-lead-speed.test.ts`**
- With `speedUp()` active, `detectBlankLeadIn` is not invoked and `sub.startMs` retains its `timeRemap` value.
- Without `speedUp()`, the blank offset is subtracted exactly as today — a regression guard for the non-speed path.
- Zoom windows, click events, cursor keyframes, and highlight events follow the same rule as subtitles in both modes.

**Integration — `tests/unit/render/blank-lead-speed-render.test.ts`**

The regression fixture from issue #20, built with `lavfi` following the pattern
in `tests/unit/render/blank-detection.test.ts`:

- 3s low-entropy prefix whose sampled PNGs fall under 15KB, then two visually distinct scenes.
- A hidden step between the scenes, a cue starting immediately after the hidden range, active speed processing.
- Assertion: the decoded frame at the transformed cue start belongs to the post-hidden scene — verified by mean color, since the two scenes are generated with known distinct fills.
- Runs the subtitle-only and voiceover paths and asserts identical cue times.

This is the only test that exercises the whole failure class; the unit tests
localize failures once it goes red.

## Acceptance criteria (from issue #20)

- [ ] Regression fixture covers blank detection, hidden-step removal, speed mapping, external SRT, voiceover, and rendering together
- [ ] The transformed SRT cue starts at the post-hide speed boundary, not 3s earlier
- [ ] The decoded frame at that cue start belongs to the post-hidden scene
- [ ] Repeated speed-segment encoding accumulates no frame-duration drift
- [ ] Subtitle-only and voiceover paths stay aligned
- [ ] Pipelines without active speed mapping retain existing blank-lead behavior
