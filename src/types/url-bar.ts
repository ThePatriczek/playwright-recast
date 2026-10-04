/** Configuration for the `.urlBar()` pipeline stage. */
export interface UrlBarConfig {
  /**
   * When the URL bar shows:
   * - `'host-change'`: when the page on screen moves to another host, from
   *   the first visible frame on, for `durationMs`. Hosts seen only inside
   *   hidden steps do not count.
   * - `'always'`: the whole video, following every URL change.
   * - `'marked'`: at each `showUrl()` call, for `durationMs`.
   * Default: `'host-change'`
   */
  show?: 'host-change' | 'always' | 'marked'
  /** How long the bar stays, in output ms (`'host-change'`, `'marked'`). Default: 3000 */
  durationMs?: number
  /**
   * Drop the query string, also inside a hash route, and a fragment that is
   * not a route (`#/...`, `#!/...`), such as OAuth's `#access_token=...`.
   * Default: true
   */
  stripQuery?: boolean
  /** Parts of the URL to mask: a string matches literally, a RegExp should be global to mask every match. */
  redact?: Array<RegExp | string>
  /** Replacement for redacted parts. Default: `'***'` */
  redactWith?: string
  /** Default: `'bottom'` */
  position?: 'bottom' | 'top'
  /** Text size in px at 1080p, scaled with the output. Default: 28 */
  fontSize?: number
  /** Font file for the text. Default: ffmpeg's fontconfig default font */
  fontFile?: string
  /** Text color, hex `#RRGGBB`. Default: `'#FFFFFF'` */
  color?: string
  /** Pill color, hex `#RRGGBB`. Default: `'#1F2328'` */
  background?: string
  /** Pill opacity 0-1. Default: 0.8 */
  backgroundOpacity?: number
}

/** One URL bar appearance on the output video. */
export interface UrlBarEvent {
  /** Display text, already stripped and redacted. */
  text: string
  videoTimeMs: number
  /** Undefined: until the end of the video. */
  endTimeMs?: number
  /** Trace time of the start, to place it against holds. */
  traceMs?: number
  /** Trace time of the end, when the end is a trace event (`'always'`). */
  endTraceMs?: number
}
