# Animated Zoom with Customizable Easing

## Problem

The current `autoZoom` implementation uses a segment-based rendering approach:
- Video is cut into separate segments (non-zoom, transition-in, static-zoom, transition-out)
- Each segment is encoded individually via ffmpeg
- Segments are concatenated with `-c copy`
- Transitions use linear `fade` filter on alpha channel only
- Hard-coded 0.4s transition duration, no easing configuration
- No smooth panning between consecutive zoom targets (always returns to 1.0x between zooms)

This produces visible seams at segment boundaries, limits transition quality to linear ramps, and is slower due to multiple encode passes.

## Solution

Replace the segment-based renderer with a **single-pass expression-based approach** using ffmpeg's `crop` filter with time-dependent expressions for `w`, `h`, `x`, `y`. Easing functions control the interpolation curve during transitions.

A **hybrid easing strategy** handles all easing types optimally:
- **Analytic mode**: Built-in easings (linear, ease-in, ease-out, ease-in-out) are expressed directly as ffmpeg math expressions. Compact, exact, zero approximation.
- **Sampled mode**: Cubic-bezier and custom JS functions are pre-evaluated in TypeScript and encoded as piecewise-linear interpolation segments in the expression. ~30 samples/sec during transitions.

## Architecture

### Data Flow

```
autoZoom executor (existing)
  → SubtitleEntry[].zoom (StepZoom per subtitle)
    → mergeAdjacentZooms()   [NEW: detects close zoom targets, creates pan transitions]
      → buildZoomCropFilter() [NEW: generates crop expressions with easing]
        → single ffmpeg pass: crop=w='...':h='...':x='...':y='...',scale=W:H
```

### Rendering

Single ffmpeg invocation:

```
ffmpeg -i input.mp4 \
  -vf "crop=w='<W_EXPR>':h='<H_EXPR>':x='<X_EXPR>':y='<Y_EXPR>',scale=1920:1080" \
  -c:v libx264 -preset fast -crf 18 -an output.mp4
```

Where each expression is a piecewise function of `t` (time in seconds):
- **Hold segments**: `if(between(t,T0,T1), constant, ...)`
- **Analytic transitions**: `if(between(t,T0,T1), st(0,(t-T0)/dur); start+(end-start)*easing(ld(0)), ...)`
- **Sampled transitions**: `if(between(t,t_i,t_{i+1}), v_i+(v_{i+1}-v_i)*(t-t_i)/(t_{i+1}-t_i), ...)`

### Zoom-to-Zoom Panning

When two zoom windows are close (gap < 2 x transitionMs), instead of zoom1 -> 1.0x -> zoom2, merge into a direct pan: zoom1 -> zoom2. The merging happens at the keyframe preprocessing level before expression generation.

## Types

### EasingSpec (new)

```typescript
// src/types/easing.ts
export type EasingPreset = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out'

export type EasingSpec =
  | EasingPreset
  | { cubicBezier: [number, number, number, number] }
  | { fn: (t: number) => number }
```

### AutoZoomConfig (modified)

```typescript
// src/pipeline/stages.ts — two new fields
export interface AutoZoomConfig {
  clickLevel?: number       // default 1.5
  inputLevel?: number       // default 1.6
  idleLevel?: number        // default 1.0
  centerBias?: number       // default 0.2
  transitionMs?: number     // NEW, default 400
  easing?: EasingSpec       // NEW, default 'ease-in-out'
  followCursor?: boolean
  /** @deprecated */ actionLevel?: number
}
```

### Existing types (unchanged)

- `StepZoom` (subtitle.ts) — executor output, unchanged
- `ZoomKeyframe` (render.ts) — already defined but unused, now gets used as internal representation

## New Files

### `src/render/easing.ts`

Easing resolution and expression generation:

- `resolveEasing(spec: EasingSpec): AnalyticEasing | SampledEasing`
  - Analytic: returns `(paramExpr: string) => string` — generates ffmpeg sub-expression
  - Sampled: returns `(t: number) => number` — JS function for pre-computation
- `cubicBezierFn(x1, y1, x2, y2): (t: number) => number` — standard cubic bezier solver (Newton's method)
- Built-in analytic expressions:
  - linear: `p`
  - ease-in: `p*p`
  - ease-out: `(1-(1-p)*(1-p))`
  - ease-in-out (smoothstep): `(3*p*p-2*p*p*p)`

### `src/render/zoom-expression.ts`

Expression building and keyframe management:

- `buildZoomCropFilter(keyframes: ZoomKeyframe[], srcRes, targetRes, config): string`
  - Main entry point. Returns complete `-vf` filter string.
  - Builds four parallel expressions (w, h, x, y) from keyframe timeline.
- `mergeAdjacentZooms(keyframes: ZoomKeyframe[], transitionMs): ZoomKeyframe[]`
  - Detects zoom windows where gap < 2 x transitionMs
  - Replaces zoom-out + zoom-in pair with direct pan transition
- `buildTransitionExpr(from, to, startSec, endSec, easing, axis): string`
  - For analytic easing: `st(0,(t-T0)/dur); from+(to-from)*easing(ld(0))`
  - For sampled easing: piecewise linear segments with ~30 samples/sec
- `clampCrop(expr, maxVal): string`
  - Wraps expression in `min(max(expr,0),maxVal)` to prevent out-of-bounds

## Modified Files

### `src/render/renderer.ts`

- Delete `renderWithZoom()` (lines 136-314) — all dead code including unused ramp builders
- New `renderWithZoom()`:
  1. Filter subtitles with `zoom.level > 1.0`
  2. Convert `StepZoom[]` → `ZoomKeyframe[]`
  3. Call `mergeAdjacentZooms()`
  4. Call `buildZoomCropFilter()`
  5. Single ffmpeg invocation with the crop filter
  6. Return output path

### `src/pipeline/stages.ts`

- Add `transitionMs?: number` and `easing?: EasingSpec` to `AutoZoomConfig`

### `src/pipeline/executor.ts`

- Pass `transitionMs` and `easing` from config through to `RenderableTrace` so the renderer can access them
- No changes to zoom detection logic

### `src/types/render.ts` / `src/index.ts`

- Export `EasingSpec` and `EasingPreset`

## Easing Mode Decision Table

| EasingSpec | Mode | Implementation |
|---|---|---|
| `'linear'` | Analytic | `p` |
| `'ease-in'` | Analytic | `p*p` |
| `'ease-out'` | Analytic | `1-(1-p)*(1-p)` |
| `'ease-in-out'` | Analytic | `3*p*p-2*p*p*p` |
| `{ cubicBezier: [a,b,c,d] }` | Sampled | Pre-compute via Newton's method, piecewise-linear in expression |
| `{ fn: (t) => number }` | Sampled | Call JS function, piecewise-linear in expression |

## Expression Structure Example

For a video with two zoom targets (2.0-5.0s at 1.5x, 8.0-12.0s at 1.6x) with ease-in-out and 400ms transitions:

```
// cropW expression (simplified):
if(between(t,1.6,2.0),
  st(0,(t-1.6)/0.4); 1920+(1280-1920)*(3*ld(0)*ld(0)-2*ld(0)*ld(0)*ld(0)),
  if(between(t,2.0,5.0), 1280,
    if(between(t,5.0,5.4),
      st(0,(t-5.0)/0.4); 1280+(1920-1280)*(3*ld(0)*ld(0)-2*ld(0)*ld(0)*ld(0)),
      if(between(t,7.6,8.0),
        st(0,(t-7.6)/0.4); 1920+(1200-1920)*(3*ld(0)*ld(0)-2*ld(0)*ld(0)*ld(0)),
        if(between(t,8.0,12.0), 1200,
          if(between(t,12.0,12.4),
            st(0,(t-12.0)/0.4); 1200+(1920-1200)*(3*ld(0)*ld(0)-2*ld(0)*ld(0)*ld(0)),
            1920))))))
```

## Testing

### Unit Tests

- `tests/unit/render/easing.test.ts` — easing function boundary values (0, 0.5, 1), monotonicity, cubic-bezier accuracy
- `tests/unit/render/zoom-expression.test.ts` — expression structure, keyframe merging, crop bounds clamping, hold segments

### Integration Test

Run recast on existing trace with different easing configs:
```typescript
// Default ease-in-out
pipeline.autoZoom()

// Custom bezier
pipeline.autoZoom({ easing: { cubicBezier: [0.42, 0, 0.58, 1] } })

// Custom function
pipeline.autoZoom({ easing: { fn: t => t * t * t } })
```

Verify:
- Video renders without ffmpeg errors
- Zoom transitions are visually smooth
- No crop out-of-bounds artifacts
- Zoom-to-zoom pan works when targets are close together
