/** Options for the browser recorder */
export interface RecordOptions {
  viewport: { width: number; height: number }
  loadStorage?: string
  ignoreHttpsErrors: boolean
}

/** Output from the recorder */
export interface RecordingResult {
  /** Directory containing trace.zip and video */
  outputDir: string
  /** Path to trace.zip */
  tracePath: string
  /** Path to recorded .webm video */
  videoPath: string
  /** Number of actions detected in trace */
  actionCount: number
  /** Total recording duration in ms */
  durationMs: number
}
