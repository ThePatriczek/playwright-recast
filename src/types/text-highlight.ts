// src/types/text-highlight.ts

/** Configuration for the text highlight pipeline stage */
export interface TextHighlightConfig {
  /** Default highlight color as hex '#RRGGBB'. Default: '#FFEB3B' (yellow) */
  color?: string
  /** Default highlight opacity 0.0–1.0. Default: 0.35 */
  opacity?: number
  /** Default visibility duration in ms. Default: 3000 */
  duration?: number
  /** Default fade out duration in ms. Default: 500 */
  fadeOut?: number
  /** Default swipe animation duration in ms. Default: 300 */
  swipeDuration?: number
  /** Default padding around the bounding box in px */
  padding?: { x?: number; y?: number }
  /** Filter which highlight events to render */
  filter?: (highlight: HighlightEvent) => boolean
}

/** A processed highlight event ready for the renderer */
export interface HighlightEvent {
  /** X position in viewport pixels */
  x: number
  /** Y position in viewport pixels */
  y: number
  /** Width in viewport pixels */
  width: number
  /** Height in viewport pixels */
  height: number
  /** Timestamp in video time (ms), after speed remapping */
  videoTimeMs: number
  /** End timestamp in video time (ms) */
  endTimeMs: number
  /** Highlight color as hex '#RRGGBB' */
  color: string
  /** Highlight opacity 0.0–1.0 */
  opacity: number
  /** Swipe animation duration in ms */
  swipeDuration: number
  /** Fade out duration in ms */
  fadeOut: number
}
