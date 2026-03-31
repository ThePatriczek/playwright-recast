// src/types/click-effect.ts
import type { TraceAction } from './trace.js'

/** Configuration for the click effect pipeline stage */
export interface ClickEffectConfig {
  /** Ripple color as hex '#RRGGBB'. Default: '#3B82F6' (blue) */
  color?: string
  /** Ripple opacity 0.0–1.0. Default: 0.5 */
  opacity?: number
  /** Max ripple radius in px, relative to 1080p. Default: 30 */
  radius?: number
  /** Ripple animation duration in ms. Default: 400 */
  duration?: number
  /** Path to click sound file, or `true` for generated default. Default: undefined (no sound) */
  sound?: string | true
  /** Click sound volume 0.0–1.0. Default: 0.8 */
  soundVolume?: number
  /** Filter which click actions to highlight. Default: all clicks with coordinates */
  filter?: (action: TraceAction) => boolean
}

/** A processed click event ready for the renderer */
export interface ClickEvent {
  /** X coordinate in viewport pixels */
  x: number
  /** Y coordinate in viewport pixels */
  y: number
  /** Timestamp in video time (ms), after speed remapping */
  videoTimeMs: number
}
