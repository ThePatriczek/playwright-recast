import type { CursorKeyframe } from '../types/cursor-overlay.js'
import type { ResolvedCursorOverlayConfig } from './defaults.js'

interface Resolution {
  width: number
  height: number
}

/** How long before a click the cursor appears (seconds) */
const APPEAR_BEFORE = 0.5
/** How long after a click the cursor stays visible (seconds) */
const VISIBLE_AFTER = 0.2
/** How long the cursor moves to the click position (seconds) */
const MOVE_DURATION = 0.25
/** Offset in viewport px — cursor arrives from this offset above-left */
const ARRIVE_OFFSET = 40

/**
 * Build ffmpeg overlay x/y expressions for per-click cursor animation.
 * Cursor appears briefly before each click, moves quickly to click position,
 * then disappears shortly after.
 */
export function buildOverlayExpressions(
  keyframes: CursorKeyframe[],
  _config: ResolvedCursorOverlayConfig,
  viewport: Resolution,
  srcRes: Resolution,
): { x: string; y: string } {
  if (keyframes.length === 0) {
    return { x: '0', y: '0' }
  }

  const scaleX = srcRes.width / viewport.width
  const scaleY = srcRes.height / viewport.height

  const points = keyframes.map(kf => ({
    x: Math.max(0, Math.round(kf.x * scaleX)),
    y: Math.max(0, Math.round(kf.y * scaleY)),
    t: Number(kf.videoTimeSec.toFixed(4)),
  }))

  return {
    x: buildPerClickAxis(points, 'x', scaleX),
    y: buildPerClickAxis(points, 'y', scaleY),
  }
}

function buildPerClickAxis(
  points: Array<{ x: number; y: number; t: number }>,
  axis: 'x' | 'y',
  scale: number,
): string {
  if (points.length === 0) return '0'

  const offset = Math.round(ARRIVE_OFFSET * scale)
  const segments: string[] = []

  for (const p of points) {
    const target = p[axis]
    const start = target - offset // arrive from above-left
    const moveStart = p.t - APPEAR_BEFORE
    const moveEnd = moveStart + MOVE_DURATION

    // During movement: ease-out from offset to target
    // After movement: stay at target until disappear
    const segment =
      `if(between(t\\,${moveStart.toFixed(4)}\\,${moveEnd.toFixed(4)})\\,` +
      `st(0\\,(t-${moveStart.toFixed(4)})/${MOVE_DURATION.toFixed(4)})\\;` +
      `${start}+(${offset})*(1-(1-ld(0))*(1-ld(0)))\\,` + // ease-out
      `${target})`

    segments.push(
      `if(between(t\\,${moveStart.toFixed(4)}\\,${(p.t + VISIBLE_AFTER).toFixed(4)})\\,${segment}\\,`
    )
  }

  // Default position (when hidden, doesn't matter but need valid value)
  let expr = segments.join('')
  expr += '0'
  expr += ')'.repeat(segments.length)

  return expr
}

/**
 * Build the enable expression for per-click cursor visibility.
 * Cursor is visible from APPEAR_BEFORE before each click to VISIBLE_AFTER after.
 */
export function buildEnableExpression(
  keyframes: CursorKeyframe[],
): string {
  if (keyframes.length === 0) return '0'

  const windows = keyframes.map(kf => {
    const start = (kf.videoTimeSec - APPEAR_BEFORE).toFixed(4)
    const end = (kf.videoTimeSec + VISIBLE_AFTER).toFixed(4)
    return `between(t\\,${start}\\,${end})`
  })

  return windows.join('+')
}

// Keep for backwards compat with tests
export interface FadeTiming {
  firstT: number
  fadeOutStartT: number
  fadeInDur: number
  fadeOutDur: number
}

export function buildFadeTiming(): null {
  return null // No longer used — visibility is per-click via enable expression
}
