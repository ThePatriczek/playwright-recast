// src/types/cursor-overlay.ts
import type { TraceAction } from './trace.js'

/** Configuration for the cursor overlay pipeline stage */
export interface CursorOverlayConfig {
  /** Path to a custom cursor image (PNG with transparency). Default: generated circle */
  image?: string
  /** Cursor size in px, relative to 1080p. Default: 24 */
  size?: number
  /** Cursor color as hex '#RRGGBB' (for generated dot). Default: '#FFFFFF' */
  color?: string
  /** Cursor opacity 0.0–1.0. Default: 0.9 */
  opacity?: number
  /** Interpolation easing between positions. Default: 'ease-in-out' */
  easing?: 'linear' | 'ease-in-out' | 'ease-out'
  /** Ms after last action before cursor fades out. Default: 500 */
  hideAfterMs?: number
  /** Show drop shadow on the default cursor dot. Default: true */
  shadow?: boolean
  /** Hold (freeze) duration in ms for marker-driven clicks, giving the cursor
   *  room to play its full approach over the held, painted target. Default 500. */
  approachMs?: number
  /** Filter which actions generate cursor positions. Default: all actions with coordinates */
  filter?: (action: TraceAction) => boolean
}

/** A cursor position at a specific point in video time */
export interface CursorKeyframe {
  /** X coordinate in viewport pixels */
  x: number
  /** Y coordinate in viewport pixels */
  y: number
  /** Timestamp in output video seconds (after speed remapping) */
  videoTimeSec: number
  /** How long (output video seconds) the action spent waiting to become
   *  actionable before landing here — i.e. Playwright auto-wait, typically a
   *  page load. The cursor's pre-click approach is shortened by this so it
   *  does not glide over a still-loading screen before the target appears. */
  autoWaitSec?: number
  /** True when this keyframe came from an explicit click marker — the renderer
   *  holds the frame here so the cursor's full approach plays over it. */
  approach?: boolean
}
