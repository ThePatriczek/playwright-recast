import type { ZoomKeyframe } from '../types/render.js'
import type { EasingSpec } from '../types/easing.js'
import { resolveEasing, type ResolvedEasing } from './easing.js'

interface Resolution {
  width: number
  height: number
}

export interface ZoomExprConfig {
  transitionMs: number
  easing: EasingSpec
  fps: number
}

/** Samples per second for piecewise-linear sampled easing */
const SAMPLE_RATE = 30

/** Internal keyframe with hold duration */
interface InternalKeyframe {
  atMs: number       // when zoom hold starts (ms)
  holdMs: number     // how long the zoom holds (ms)
  x: number          // 0.0–1.0
  y: number          // 0.0–1.0
  level: number      // zoom multiplier (>1.0)
}

/** A timeline segment — either a constant hold or a transition between two states */
type Segment =
  | { type: 'hold'; startSec: number; endSec: number; level: number; cx: number; cy: number }
  | { type: 'transition'; startSec: number; endSec: number; fromLevel: number; toLevel: number; fromCx: number; toCx: number; fromCy: number; toCy: number }

/**
 * Build the zoompan filter string for animated zoom.
 *
 * Uses ffmpeg `zoompan` filter with `d=1` (1:1 frame mapping for video).
 * Time is derived from `in/FPS` (frame counter / fps).
 * Zoompan `z` = zoom level, `x`/`y` = top-left crop position in zoomed coordinates.
 *
 * Zoompan coordinate system:
 * - `z` = zoom level (1.0 = no zoom, 1.5 = 1.5x)
 * - `x`, `y` = top-left corner of the visible region in the ZOOMED image
 * - Zoomed image size = iw*z × ih*z, visible region = s (output size)
 * - To center at (cx, cy) fraction: x = cx*iw*z - ow/2, y = cy*ih*z - oh/2
 *   (clamped to 0 .. iw*z - ow for x, 0 .. ih*z - oh for y)
 */
export function buildZoomFilter(
  keyframes: ZoomKeyframe[],
  srcRes: Resolution,
  targetRes: Resolution,
  config: ZoomExprConfig,
): string {
  const scaleOnly = `scale=${targetRes.width}:${targetRes.height}`
  if (keyframes.length === 0) return scaleOnly

  const internal = toInternal(keyframes)
  if (internal.length === 0) return scaleOnly

  const easing = resolveEasing(config.easing)
  const T = config.transitionMs / 1000
  const fps = config.fps

  const segments = buildSegments(internal, T)
  if (segments.length === 0) return scaleOnly

  // Time variable: in/fps (frame number / fps = seconds)
  const tVar = `in/${fps}`

  // Build expressions for z (zoom level), cx (center x 0..1), cy (center y 0..1)
  const zExpr = buildTimeExpr(segments, 'level', 1.0, easing, tVar)
  const cxExpr = buildTimeExpr(segments, 'cx', 0.5, easing, tVar)
  const cyExpr = buildTimeExpr(segments, 'cy', 0.5, easing, tVar)

  // zoompan x/y: convert center fraction to top-left pixel in zoomed space
  // x = max(0, min(cx * iw * zoom - ow/2, iw * zoom - ow))
  // y = max(0, min(cy * ih * zoom - oh/2, ih * zoom - oh))
  // Note: zoompan expressions don't need \\, escaping (uses ':' separator, not ',')
  const xExpr = `max(0,min((${cxExpr})*iw*zoom-ow/2,iw*zoom-ow))`
  const yExpr = `max(0,min((${cyExpr})*ih*zoom-oh/2,ih*zoom-oh))`

  return `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=1:s=${targetRes.width}x${targetRes.height}:fps=${fps}`
}

/**
 * Convert ZoomKeyframe[] to internal format.
 */
function toInternal(keyframes: ZoomKeyframe[]): InternalKeyframe[] {
  return keyframes
    .filter((kf) => (kf.level ?? 1.0) > 1.0)
    .map((kf) => ({
      atMs: kf.atMs,
      holdMs: kf.transitionMs ?? 2000,
      x: kf.x ?? 0.5,
      y: kf.y ?? 0.5,
      level: kf.level ?? 1.5,
    }))
    .sort((a, b) => a.atMs - b.atMs)
}

/**
 * Build timeline segments from keyframes.
 */
function buildSegments(keyframes: InternalKeyframe[], T: number): Segment[] {
  const segments: Segment[] = []

  for (let i = 0; i < keyframes.length; i++) {
    const kf = keyframes[i]!
    const startSec = kf.atMs / 1000
    const endSec = startSec + kf.holdMs / 1000

    const lastSeg = segments[segments.length - 1]
    const skipTransIn = lastSeg?.type === 'transition' && Math.abs(lastSeg.endSec - startSec) < 0.01

    if (!skipTransIn) {
      const transInStart = Math.max(0, startSec - T)
      if (startSec - transInStart > 0.01) {
        segments.push({
          type: 'transition',
          startSec: transInStart,
          endSec: startSec,
          fromLevel: 1.0, fromCx: 0.5, fromCy: 0.5,
          toLevel: kf.level, toCx: kf.x, toCy: kf.y,
        })
      }
    }

    if (endSec - startSec > 0.01) {
      segments.push({ type: 'hold', startSec, endSec, level: kf.level, cx: kf.x, cy: kf.y })
    }

    const nextKf = keyframes[i + 1]
    if (nextKf) {
      const nextStartSec = nextKf.atMs / 1000
      const gap = nextStartSec - endSec

      if (gap < 2 * T && gap > 0.01) {
        segments.push({
          type: 'transition', startSec: endSec, endSec: nextStartSec,
          fromLevel: kf.level, fromCx: kf.x, fromCy: kf.y,
          toLevel: nextKf.level ?? 1.5, toCx: nextKf.x ?? 0.5, toCy: nextKf.y ?? 0.5,
        })
      } else if (gap > 0.01) {
        const transOutEnd = Math.min(endSec + T, nextStartSec - T)
        if (transOutEnd - endSec > 0.01) {
          segments.push({
            type: 'transition', startSec: endSec, endSec: transOutEnd,
            fromLevel: kf.level, fromCx: kf.x, fromCy: kf.y,
            toLevel: 1.0, toCx: 0.5, toCy: 0.5,
          })
        }
      }
    } else {
      segments.push({
        type: 'transition', startSec: endSec, endSec: endSec + T,
        fromLevel: kf.level, fromCx: kf.x, fromCy: kf.y,
        toLevel: 1.0, toCx: 0.5, toCy: 0.5,
      })
    }
  }

  return segments
}

/**
 * Build a time-based expression for a property using the given time variable.
 * zoompan expressions use plain commas (no escaping needed).
 */
function buildTimeExpr(
  segments: Segment[],
  prop: 'level' | 'cx' | 'cy',
  defaultVal: number,
  easing: ResolvedEasing,
  tVar: string,
): string {
  if (segments.length === 0) return String(defaultVal)

  const parts: string[] = []

  for (const seg of segments) {
    const s = seg.startSec.toFixed(4)
    const e = seg.endSec.toFixed(4)

    if (seg.type === 'hold') {
      const val = seg[prop]
      parts.push(`if(between(${tVar},${s},${e}),${val},`)
    } else {
      const fromVal = prop === 'level' ? seg.fromLevel : prop === 'cx' ? seg.fromCx : seg.fromCy
      const toVal = prop === 'level' ? seg.toLevel : prop === 'cx' ? seg.toCx : seg.toCy

      if (Math.abs(fromVal - toVal) < 0.001) {
        parts.push(`if(between(${tVar},${s},${e}),${fromVal},`)
      } else {
        const dur = (seg.endSec - seg.startSec).toFixed(4)
        const transExpr = buildTransitionExpr(fromVal, toVal, s, dur, easing, tVar)
        parts.push(`if(between(${tVar},${s},${e}),${transExpr},`)
      }
    }
  }

  parts.push(String(defaultVal))
  parts.push(')'.repeat(segments.length))

  return parts.join('')
}

/**
 * Build a transition expression between two values with easing.
 */
function buildTransitionExpr(
  from: number,
  to: number,
  startSecStr: string,
  durStr: string,
  easing: ResolvedEasing,
  tVar: string,
): string {
  const delta = to - from
  const fromStr = from.toFixed(4)
  const deltaStr = delta.toFixed(4)

  if (easing.mode === 'analytic') {
    const p = `(${tVar}-${startSecStr})/${durStr}`
    const easedP = easing.expr('ld(0)')
    return `st(0,${p})*0+${fromStr}+(${deltaStr})*${easedP}`
  }

  return buildSampledTransitionExpr(from, to, Number(startSecStr), Number(durStr), easing.fn, tVar)
}

/**
 * Build piecewise-linear expression for sampled easing.
 */
function buildSampledTransitionExpr(
  from: number,
  to: number,
  startSec: number,
  dur: number,
  easingFn: (t: number) => number,
  tVar: string,
): string {
  const delta = to - from
  const numSamples = Math.max(2, Math.ceil(dur * SAMPLE_RATE))
  const points: Array<{ t: number; val: number }> = []

  for (let i = 0; i <= numSamples; i++) {
    const progress = i / numSamples
    const easedProgress = easingFn(progress)
    points.push({
      t: startSec + progress * dur,
      val: from + delta * easedProgress,
    })
  }

  const subParts: string[] = []
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i]!
    const p1 = points[i + 1]!
    const ts = p0.t.toFixed(4)
    const te = p1.t.toFixed(4)
    const segDur = (p1.t - p0.t).toFixed(4)
    const v0 = p0.val.toFixed(4)
    const segDelta = (p1.val - p0.val).toFixed(4)
    subParts.push(`if(between(${tVar},${ts},${te}),${v0}+(${segDelta})*(${tVar}-${ts})/${segDur},`)
  }

  subParts.push(points[points.length - 1]!.val.toFixed(4))
  subParts.push(')'.repeat(points.length - 1))

  return subParts.join('')
}

/**
 * Convert StepZoom (per-subtitle) data to ZoomKeyframe[].
 */
export function stepZoomsToKeyframes(
  subtitles: Array<{ zoom?: { x: number; y: number; level: number; startMs?: number; endMs?: number }; startMs: number; endMs: number }>,
): ZoomKeyframe[] {
  return subtitles
    .filter((s) => s.zoom && s.zoom.level > 1.0)
    .map((s) => ({
      atMs: s.zoom!.startMs ?? s.startMs,
      x: s.zoom!.x,
      y: s.zoom!.y,
      level: s.zoom!.level,
      transitionMs: (s.zoom!.endMs ?? s.endMs) - (s.zoom!.startMs ?? s.startMs),
    }))
}
