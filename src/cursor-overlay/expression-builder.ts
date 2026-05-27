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
/** Smallest pre-click lead, even when the target appeared at the last moment */
const MIN_LEAD = 0.15

/**
 * How long before a click the cursor should appear, trimmed by the action's
 * auto-wait. If the click waited on a page load, the target only became
 * visible near the click moment, so a full APPEAR_BEFORE lead would glide the
 * cursor over the still-loading screen. Subtracting the wait keeps the cursor
 * from appearing before the target does (clamped to MIN_LEAD).
 */
function appearLead(autoWaitSec: number | undefined): number {
  return Math.max(MIN_LEAD, APPEAR_BEFORE - (autoWaitSec ?? 0))
}

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

  const points = keyframes.map(kf => {
    const lead = appearLead(kf.autoWaitSec)
    // When the target only appeared after a wait (a page load), there is no
    // stable context to glide across — a slide-in would travel over the
    // still-loading screen. Drop the approach and let the cursor appear
    // directly at the target instead.
    const glide = (kf.autoWaitSec ?? 0) <= APPEAR_BEFORE - MIN_LEAD
    return {
      x: Math.max(0, Math.round(kf.x * scaleX)),
      y: Math.max(0, Math.round(kf.y * scaleY)),
      t: Number(kf.videoTimeSec.toFixed(4)),
      lead,
      // Move can't outlast the lead, otherwise the cursor would still be
      // gliding when the click fires.
      moveDur: Math.min(MOVE_DURATION, lead),
      glide,
    }
  })

  return {
    x: buildPerClickAxis(points, 'x', scaleX),
    y: buildPerClickAxis(points, 'y', scaleY),
  }
}

function buildPerClickAxis(
  points: Array<{ x: number; y: number; t: number; lead: number; moveDur: number; glide: boolean }>,
  axis: 'x' | 'y',
  scale: number,
): string {
  if (points.length === 0) return '0'

  const baseOffset = Math.round(ARRIVE_OFFSET * scale)
  const segments: string[] = []

  for (const p of points) {
    const target = p[axis]
    const offset = p.glide ? baseOffset : 0 // no slide-in for late-appearing targets
    const start = target - offset // arrive from above-left
    const moveStart = p.t - p.lead
    const moveEnd = moveStart + p.moveDur

    // During movement: ease-out from offset to target
    // After movement: stay at target until disappear
    const segment =
      `if(between(t\\,${moveStart.toFixed(4)}\\,${moveEnd.toFixed(4)})\\,` +
      `st(0\\,(t-${moveStart.toFixed(4)})/${p.moveDur.toFixed(4)})\\;` +
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
    const start = (kf.videoTimeSec - appearLead(kf.autoWaitSec)).toFixed(4)
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
