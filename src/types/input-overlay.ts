/** Mouse inputs the indicator can show. */
export type MouseIndicatorInput = 'left' | 'right' | 'middle' | 'wheel'

export type WheelDirection = 'up' | 'down' | 'left' | 'right'

/**
 * A small mouse icon beside the cursor showing the pressed button or the
 * wheel's direction: `cursorOverlay({ mouseIndicator })`.
 */
export interface MouseIndicatorConfig {
  /**
   * Inputs that show the icon. `withMouseIndicator()` overrides it for the
   * interactions it wraps. Default: `['right', 'middle', 'wheel']`
   */
  inputs?: MouseIndicatorInput[]
  /** Icon height in px at 1080p, scaled with the video. Default: 36 */
  size?: number
  /** Body color, hex `#RRGGBB`. Default: `'#FFFFFF'` */
  color?: string
  /** Outline and idle wheel color. Default: `'#1F2328'` */
  outlineColor?: string
  /** Pressed button, wheel and direction arrow color. Default: `'#2563EB'` */
  accentColor?: string
  /** Icon's top-left corner from the pointer tip, px at 1080p. Default: beside the cursor image */
  offset?: { x: number; y: number }
  /** Shortest time the icon shows, for a click or one wheel notch, in ms. Default: 400 */
  minShowMs?: number
}

/** One mouse input shown by the indicator, on the output video. */
export interface MouseInputEvent {
  input: MouseIndicatorInput
  /** Wheel inputs only */
  direction?: WheelDirection
  videoTimeMs: number
  /** Release (press) or the turn itself (click, wheel) */
  endTimeMs: number
  /** Trace times, to place the event against holds */
  traceMs?: number
  endTraceMs?: number
}

/**
 * Key presses the key overlay can show:
 * - `'combos'`: with Ctrl, Alt or Meta, or Shift with a named key (`Ctrl + Z`, `Shift + Tab`)
 * - `'special'`: a named key alone (`Esc`, `Enter`, `Del`, arrows, F-keys)
 * - `'mouse-modifiers'`: a modifier held over a click, drag or wheel turn (`Alt + drag`)
 * - `'keys'`: any other single key (`A`, `Shift + A`)
 *
 * Text from `fill()`, `type()` and `pressSequentially()` never shows.
 */
export type KeyOverlayInput = 'combos' | 'special' | 'mouse-modifiers' | 'keys'

/** Configuration for the `.keyOverlay()` pipeline stage. */
export interface KeyOverlayConfig {
  /**
   * Presses that show. `withKeyOverlay()` overrides it for the interactions
   * it wraps. Default: `['combos', 'special', 'mouse-modifiers']`
   */
  inputs?: KeyOverlayInput[]
  /** Labels by Playwright key name, over the defaults (`Control: 'Ctrl'`, `Escape: 'Esc'`, ...) */
  labels?: Record<string, string>
  /** Between keys. Default: `' + '` */
  separator?: string
  /** Shortest time a press shows, in output ms; a held key shows until released. Default: 1200 */
  minShowMs?: number
  /** Default: `'bottom'` (above a URL bar on the same edge) */
  position?: 'bottom' | 'top'
  /** Text size in px at 1080p, scaled with the output. Default: 32 */
  fontSize?: number
  /** Font file for the text. Default: ffmpeg's fontconfig default font */
  fontFile?: string
  /** Text color, hex `#RRGGBB`. Default: `'#FFFFFF'` */
  color?: string
  /** Keycap color, hex `#RRGGBB`. Default: `'#1F2328'` */
  background?: string
  /** Keycap opacity 0-1. Default: 0.85 */
  backgroundOpacity?: number
}

/** One key press shown by the key overlay, on the output video. */
export interface KeyOverlayEvent {
  /** Display text, e.g. `Ctrl + Z` */
  text: string
  input: KeyOverlayInput
  videoTimeMs: number
  endTimeMs: number
  traceMs?: number
  endTraceMs?: number
}
