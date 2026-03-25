import type { SpeedMappedTrace } from './speed'

/** Zoom instruction for a subtitle/step */
export interface StepZoom {
  /** Center X as fraction of video width (0.0–1.0) */
  x: number
  /** Center Y as fraction of video height (0.0–1.0) */
  y: number
  /** Zoom level (1.0 = no zoom, 2.0 = 2x zoom) */
  level: number
}

/** A single subtitle entry */
export interface SubtitleEntry {
  index: number
  startMs: number
  endMs: number
  text: string
  keyword?: string
  /** Optional zoom instruction for this step */
  zoom?: StepZoom
}

/** Subtitle format */
export type SubtitleFormat = 'srt' | 'vtt'

/** Subtitle generation options */
export interface SubtitleOptions {
  format?: SubtitleFormat
}

/** Trace after subtitles have been generated */
export interface SubtitledTrace extends SpeedMappedTrace {
  subtitles: SubtitleEntry[]
}
