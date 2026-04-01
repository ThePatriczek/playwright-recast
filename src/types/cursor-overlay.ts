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
}
