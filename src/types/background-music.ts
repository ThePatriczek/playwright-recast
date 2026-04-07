/** Configuration for background music added to the video */
export interface BackgroundMusicConfig {
  /** Path to the music audio file (mp3, wav, ogg, m4a) */
  path: string
  /** Base volume level 0.0–1.0 (default: 0.3) */
  volume?: number
  /** Auto-duck music during voiceover segments (default: true) */
  ducking?: boolean
  /** Volume level during voiceover 0.0–1.0 (default: 0.1) */
  duckLevel?: number
  /** Fade duration in ms for ducking transitions (default: 500) */
  duckFadeMs?: number
  /** Fade-out duration in ms at end of video (default: 3000) */
  fadeOutMs?: number
  /** Loop audio if shorter than video (default: true) */
  loop?: boolean
}
