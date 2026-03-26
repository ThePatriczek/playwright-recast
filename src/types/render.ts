/** Zoom keyframe — defines a zoom state at a specific time */
export interface ZoomKeyframe {
  /** Time in output video (ms) when this zoom should be active */
  atMs: number
  /** Center X as fraction of video width (0.0–1.0). Default: 0.5 */
  x?: number
  /** Center Y as fraction of video height (0.0–1.0). Default: 0.5 */
  y?: number
  /** Zoom level (1.0 = no zoom, 2.0 = 2x zoom). Default: 1.0 */
  level?: number
  /** Transition duration in ms to reach this zoom state. Default: 300 */
  transitionMs?: number
}

/** Render output configuration */
export interface RenderConfig {
  format?: 'mp4' | 'webm'
  resolution?: '720p' | '1080p' | '1440p' | '4k' | { width: number; height: number }
  fps?: number
  burnSubtitles?: boolean
  subtitleStyle?: SubtitleStyle
  cursorOverlay?: boolean
  codec?: string
  crf?: number
}

export interface SubtitleStyle {
  /** Font family name (default: 'Arial') */
  fontFamily?: string
  /** Font size in script pixels relative to 1080p (default: 52) */
  fontSize?: number
  /** Text color as hex '#RRGGBB' (default: '#1a1a1a') */
  primaryColor?: string
  /** Background box color as hex '#RRGGBB' (default: '#FFFFFF') */
  backgroundColor?: string
  /** Background opacity 0.0 (transparent) to 1.0 (opaque) (default: 0.75) */
  backgroundOpacity?: number
  /** Box padding in pixels — extends background around text (default: 18) */
  padding?: number
  /** Shadow distance in pixels (default: 0) */
  shadow?: number
  /** Vertical position: 'bottom' or 'top' (default: 'bottom') */
  position?: 'bottom' | 'top'
  /** Bottom/top margin in pixels (default: 50) */
  marginVertical?: number
  /** Left/right margin in pixels (default: 80) */
  marginHorizontal?: number
  /** Bold text (default: true) */
  bold?: boolean
  /** Word wrap: 'smart' (even lines), 'endOfLine', 'none' (default: 'smart') */
  wrapStyle?: 'smart' | 'endOfLine' | 'none'
  /** Split long subtitles into shorter single-line chunks (null = no chunking) */
  chunkOptions?: { maxCharsPerLine?: number; minCharsPerChunk?: number } | null

  // --- Backward-compat aliases (deprecated) ---
  /** @deprecated Use primaryColor */
  color?: string
  /** @deprecated Use marginVertical */
  marginBottom?: number
}

/** Resolved resolution in pixels */
export function resolveResolution(
  resolution: RenderConfig['resolution'],
): { width: number; height: number } {
  if (typeof resolution === 'object' && resolution) return resolution
  switch (resolution) {
    case '720p':
      return { width: 1280, height: 720 }
    case '1440p':
      return { width: 2560, height: 1440 }
    case '4k':
      return { width: 3840, height: 2160 }
    case '1080p':
    default:
      return { width: 1920, height: 1080 }
  }
}
