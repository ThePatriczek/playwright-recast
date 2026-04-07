/** Configuration for the intro pipeline stage */
export interface IntroConfig {
  /** Path to the intro video file (.mp4, .mov, .webm) */
  path: string
  /** Crossfade duration in ms (default: 500) */
  fadeDuration?: number
}

/** Configuration for the outro pipeline stage */
export interface OutroConfig {
  /** Path to the outro video file (.mp4, .mov, .webm) */
  path: string
  /** Crossfade duration in ms (default: 500) */
  fadeDuration?: number
}
