# Frame-boundary drift across voiceover, speed and zoom stages

**Status:** design
**Date:** 2026-08-24
**Issue:** [#22](https://github.com/ThePatriczek/playwright-recast/issues/22)
**Follows:** [blank-lead / speed-map clock authority](2026-08-22-blank-lead-speed-clock-design.md) (#20)

## Binding constraint

**Nothing may change for anyone who is not currently hitting a bug.** This is
the user's explicit requirement and it outranks every other consideration in
this document. Concretely:

- A fix may change rendered output only where that output is demonstrably
  wrong today.
- Any change that would shift timing or appearance for a working pipeline goes
  behind an opt-in flag, with today's behaviour as the default.
- Flag defaults get revisited at the next major, not here.

The cost is accepted knowingly: two of the five workstreams add a second code
path that must be maintained until those defaults flip.

## What #22 reports, and what is left

Issue #22 lists seven items. Two are already fixed on `main` by #20:

- **Item 1** (blank-lead compensation running against an active speed map) —
  fixed. `isSpeedClockAuthority()` gates it in one place; the renderer's blank
  trim is gated by the same predicate.
- **Item 4, first half** (per-segment `-frames:v`) — fixed. `renderWithSpeed()`
  allocates exact cumulative frame counts.

Five remain, all confirmed against the source:

| # | Defect | Location |
|---|---|---|
| 2 | Fixed 100 ms sampling grid skips scenes shorter than 100 ms and rounds every boundary | `speed-processor.ts:151` |
| 4b | A segment allocated ≥1 frame whose source interval contains no native frame encodes to an empty file | `renderer.ts` `renderWithSpeed()` |
| 5 | Freeze slices use timestamp `-ss/-to` with no `-frames:v`; overflow points are computed in continuous ms | `renderer.ts:654-661`, `voiceover-processor.ts:166` |
| 6 | Zoom-in starts `T` before the cue and zoom-out ends `T` after, leaking into neighbours | `zoom-expression.ts:117`, `:145` |
| 7 | TTS segments concatenated with `-c copy`, preserving incompatible sample rates | `voiceover-processor.ts:200` |

Item 5 deserves emphasis: it is the *same* defect #20 fixed in
`renderWithSpeed()`, still present in the freeze path. Each slice rounds up
independently, and the boundary frame lands in whichever cue ffmpeg happens to
give it.

## Rejected: issue #22's frame allocator (item 3)

#22 proposes replacing the allocator with:

```text
plannedSeconds += segmentSeconds
targetCumulativeFrames = max(emittedFrames + 1, ceil(plannedSeconds * fps - 1e-9))
segmentFrames = targetCumulativeFrames - emittedFrames
```

This is not adopted, for two measured reasons.

**It does not produce the numbers the issue quotes.** For twelve 0.101 s
segments at 25 fps the issue states `[3,2,3,2,…]` (total 30, and 30 is correct —
the ideal is 30.3 frames). The formula as written yields `[3,3,2,3,2,…]`,
total 31. The quoted values are what a *round*-based cumulative allocator
produces — which is what `planSpeedSegments()` already does.

**The minimum-one-frame rule accumulates without bound.** Measured:

```
40 consecutive 0.001s segments (ideal 1.0 frame total)
  #22 allocator: 40 frames   — 1.6s of output where 0.04s was planned
  current:        1 frame

[1s, 0.001s] x 3 + 1s  (ideal 75.075 frames)
  #22 allocator: 101 frames  (25,1,25,1,24,1,24)
  current:       100 frames  (25,0,25,0,25,0,25)
```

Once a forced frame pushes `emittedFrames` past the planned clock, every
following segment keeps hitting the `emitted + 1` branch and the excess never
returns. A compensating variant that borrows the forced frame back from later
segments was tried and does not converge either, for a reason that appears
fundamental: **if N sub-frame segments each require at least one frame, the
total is at least N regardless of the ideal budget.** Minimum-one-frame and an
exact cumulative total cannot both hold.

This matters because item 2 is what *creates* sub-frame segments — splitting at
every narration and hidden-range boundary is precisely what produces them. The
two changes interact, and adopting both would reintroduce the drift class #22
sets out to remove.

The current allocator is therefore kept unchanged: round-based, cumulative,
exact total, dropping segments that round to zero frames. The dropped duration
is absorbed by the following segment because `cumOutSec` advances before the
drop, so the clock stays correct — only a sub-frame scene goes unrendered.
W2 below addresses the visibility problem from the other end, without touching
the allocator.

## Goal

One frame-aligned output clock, consumed by subtitles, voiceover freezes,
zoom, cursor and rendering alike — reached without changing behaviour for any
pipeline that is working today.

## Non-goals

- **Changing the frame allocator.** See above.
- **Flipping the defaults of the two new flags.** A major release decides that.
- **Unifying `probeVideoFps()` (`renderer.ts`) with `probeFps()` (`video-ops.ts`).**
  Their fallbacks differ deliberately (25 vs 30). Do not merge them; do not add
  a third.
- **Re-litigating #20.** Its behaviour for `speedUp()` pipelines changed by
  design and is out of scope here.

## Design

### Shared prerequisite: one frame rate

Every workstream below needs the output frame rate. `probeVideoFps()` already
exists (`renderer.ts`, added by #20) and is the single source. It must reach:

- `renderWithSpeed()` — already has it
- `applyVoiceoverFreezes()` — W1
- `generateVoiceover()` — W1, to align overflow starts

The output frame rate equals the source frame rate, because `renderWithSpeed()`
forces `fps=${probeVideoFps(source)}`. One value throughout — that is the
"single clock" thesis of #22, and it is what makes W1 expressible.

### W1 — frame-indexed voiceover freezes (item 5). No flag.

Two halves, both in continuous time today.

**Planning.** `planVoiceoverFreezes(freezes, videoDur)` (`renderer.ts:508`,
already a pure function with its own tests) currently returns
`FreezeSegmentPlan` in seconds. It gains an `fps` parameter and returns frame
indices:

```ts
export interface FreezeSegmentPlan {
  startFrame: number
  /** Exclusive; null means "to end of video". */
  endFrame: number | null
  startHoldFrames: number
  stopHoldFrames: number
}
```

Cut points convert with `Math.ceil(seconds * fps)`, so a boundary frame belongs
to the cue that starts on or after it rather than to whichever side ffmpeg
rounds toward. A slice that collapses to zero frames has its holds merged into
the preceding slice — the existing planner already handles the zero-width case
for seconds and the same branch carries over.

**Slicing.** `applyVoiceoverFreezes()` (`renderer.ts:654-661`) replaces
timestamp input seeking with frame-indexed trimming:

```
-vf trim=start_frame=<s>:end_frame=<e>,setpts=PTS-STARTPTS[,tpad=…]
```

and keeps `-frames:v` on the result, exactly as `renderWithSpeed()` now does.

**Overflow alignment.** `voiceover-processor.ts:166` records
`atVideoMs: originalEndsMs[si]` in continuous ms. It aligns up to the next
output frame boundary, with the fractional remainder moved *out of* the hold —
so the freeze's **end position is preserved**:

```ts
const alignedMs = Math.ceil(atVideoMs * fps / 1000) * 1000 / fps
const shift = alignedMs - atVideoMs
freezes.push({ atVideoMs: alignedMs, durationMs: Math.max(0, overflow - shift) })
```

Subtracting, not adding, is load-bearing. Pushing the hold `shift` later means
the video plays `shift` more milliseconds before it pauses, so the hold needs
`shift` less to resume at the same output position. Adding instead would extend
every freeze by up to one frame and push the rest of the video later — the
accumulation this issue exists to remove. The accumulator that shifts subtitles
(`timeShift`) must advance by the **aligned** duration for the same reason.

This is not flagged. It changes output by at most one frame, and only where the
frame is currently on the wrong side of a cut — the definition of a bug fix
under the binding constraint.

### W2 — hold sub-frame intervals (item 4b). No flag.

A speed segment allocated ≥1 frame whose source interval contains no native
frame currently encodes to an empty file, which then breaks the concat demuxer.

#22 proposes probing `best_effort_timestamp_time` for every source frame up
front. This design does not: that is a full decode pass over the recording to
serve a rare case. Instead, detect it where it manifests — after encoding each
segment, probe its frame count; if zero, re-encode that one segment as a hold:

```
-ss <last source frame at or before startSec> -frames:v 1
-vf tpad=stop_mode=clone:stop_duration=<allocatedFrames/fps>
```

The scene then holds the last settled visual for its allocated frames instead
of vanishing. Cheaper than a global probe, and it cannot misfire on segments
that encoded correctly.

This is not flagged: producing an empty file is not behaviour anyone depends
on.

### W3 — audio concat normalisation (item 7). No flag, but conditional.

`voiceover-processor.ts:200` concatenates TTS segments and generated silence
with `-c copy`. When segments disagree on sample rate or channel layout the
demuxer preserves the first one's and the rest play at the wrong speed or not
at all.

#22 proposes always re-encoding to 44.1 kHz mono `libmp3lame`. **This design
does not**, because it would re-encode the many pipelines whose segments
already agree, changing their audio for no reason — a breaking change under the
binding constraint.

Instead: probe each segment's sample rate and channel layout.

- **All agree** → keep `-c copy`. Byte-identical to today.
- **They disagree** → normalise every segment to the most common rate and
  layout among them, falling back to 44.1 kHz mono when there is no majority.

Only the broken case changes.

### W4 — `speedUp({ exactBoundaries: true })` (item 2). Opt-in.

`speed-processor.ts:151` walks a fixed 100 ms grid and skips hidden samples.
A visible narration scene shorter than 100 ms can be missed entirely, and every
boundary is rounded to the grid.

Add `exactBoundaries?: boolean` to `SpeedConfig` (`types/speed.ts`), default
`false`. When set, the sampling points become the sorted unique union of:

- visible start and end
- the regular 100 ms samples
- every narration-boundary action timestamp
- every hidden-range start and end

and each interval *between consecutive points* is classified, rather than each
grid point. When unset, the existing loop runs unchanged — same code path, same
output.

Note the interaction already discussed: this option is what generates sub-frame
segments. W2 is what keeps them visible. They ship together or the option is
worse than useless.

### W5 — `autoZoom({ containInCue: true })` (item 6). Opt-in.

`buildSegments()` (`zoom-expression.ts:105`) sets the zoom-in transition to
`[startSec - T, startSec]` and the zoom-out to end at `endSec + T`, so both
overrun the cue that requested them.

Add `containInCue?: boolean` to `AutoZoomConfig` (`pipeline/stages.ts:41`),
default `false`, threaded through `state.zoomConfig` (`executor.ts:715`) and
`RenderableTrace.zoomConfig` (`executor.ts:67`) into `ZoomExprConfig`
(`zoom-expression.ts:10`). When set:

```text
transitionSec  = min(configuredTransitionSec, (endSec - startSec) / 2)
zoomInEndSec   = startSec + transitionSec
zoomOutStartSec = endSec - transitionSec
```

Zoom-in begins at the cue start, the hold occupies the middle when one exists,
and zoom-out finishes at the cue end. The `skipTransIn` coalescing for
back-to-back cues and the gap handling at `:138`/`:144` become unnecessary in
this mode — there is no cross-cue transition left to coalesce.

When unset, `buildSegments()` runs exactly as today.

## Components

| Unit | Responsibility | New? |
|---|---|---|
| `planVoiceoverFreezes(freezes, videoDur, fps)` | Pure planner, now in frame indices | Changed signature |
| `FreezeSegmentPlan` | Frame-indexed slice plan | Changed shape |
| `alignOverflowToFrame(atVideoMs, overflowMs, fps)` | Pure; frame-aligned overflow point + adjusted duration | New |
| `holdSegmentFallback(...)` | Re-encode a zero-frame segment as a clone-hold | New |
| `probeAudioFormat(path)` | Sample rate + channel layout | New |
| `planAudioConcat(formats)` | Pure; decides copy vs normalise and the target format | New |
| `buildSamplePoints(...)` | Pure; the sorted unique boundary set for `exactBoundaries` | New |
| `buildSegments(keyframes, T, containInCue)` | Zoom segments, optionally cue-contained | Changed signature |

Every pure unit follows the `planVoiceoverFreezes` / `planSpeedSegments`
precedent: arithmetic in an exported function, unit-tested without ffmpeg.

## Testing

**Pure units, no ffmpeg:**
- `planVoiceoverFreezes` in frames: boundary frame lands with the cue starting on or after it; zero-width slice merges into its predecessor; existing seconds-based cases translated.
- `alignOverflowToFrame`: fractional remainder is added to the duration, never lost; an already-aligned point is unchanged.
- `planAudioConcat`: uniform formats → copy; mixed → normalise to the majority; no majority → 44.1 kHz mono.
- `buildSamplePoints`: narration and hidden boundaries present, sorted, deduped; a <100 ms visible scene survives; with the flag off the point set is exactly the old grid.
- `buildSegments` with `containInCue`: transitions never leave `[startSec, endSec]`; a cue shorter than `2T` splits its transition evenly with no hold; with the flag off, output identical to today.

**ffmpeg-backed:**
- Frame-indexed slicing produces exactly the planned frame counts across a multi-freeze timeline.
- A speed segment whose source interval contains no native frame yields the allocated frames of held content rather than an empty file.
- A concat of segments with deliberately mismatched sample rates plays at the right duration after normalisation.

**Non-breaking regression guards — the most important tests here:**
- With both flags off, `buildSamplePoints` and `buildSegments` produce output identical to the pre-change implementations. Assert against captured fixtures, not against a re-derivation.
- Uniform-format audio concat still takes the `-c copy` path.

## Open verification

The final review of #20 assumed the source video is CFR 25 "by construction"
via `screencast-assembler.ts`. That holds only for the fallback path;
`findSourceVideo()` (`executor.ts:1092`) returns a real Playwright `recordVideo`
`.webm` on the happy path, which is not guaranteed CFR. A synthetic
irregular-timing source was measured and the post-#20 encoder produced the
planned frame count where the old one overshot — i.e. the intended correction —
but this has not been verified against an authentic Playwright recording. No
`.webm` exists in the repo.

This is not a blocker for the work below, but it should be checked against a
real trace before the release that carries #20 and #22, since both change what
`speedUp()` pipelines render.

## Acceptance criteria

- [ ] Freeze slices land the boundary frame with the cue that owns it, verified in frames not seconds
- [ ] Voiceover overflow starts are frame-aligned with no fractional time lost
- [ ] A sub-frame source interval renders held content instead of an empty segment
- [ ] Mismatched TTS segment formats are normalised; matching ones still take `-c copy` unchanged
- [ ] `exactBoundaries: true` preserves narration and hidden-range boundaries exactly; a sub-100 ms visible scene survives
- [ ] `containInCue: true` keeps every zoom transition inside its cue
- [ ] **With both flags unset, rendered output is unchanged from today** — asserted by fixture, for both the sampler and the zoom segment builder
- [ ] The frame allocator is untouched
