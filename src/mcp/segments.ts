/** A step as the analyzer reports it, with the caller's choice of hidden. */
export interface McpStep {
  startTimeMs: number
  endTimeMs: number
  hidden: boolean
}

/** Hidden steps on the video clock, merged under 2 s apart so no sliver of a login shows; dropped if over before t=0. */
export function hiddenRanges(steps: ReadonlyArray<McpStep>, toVideo: (t: number) => number): Array<{ startMs: number; endMs: number }> {
  const raw = steps
    .filter((s) => s.hidden)
    .map((s) => ({ startMs: Math.max(0, toVideo(s.startTimeMs)), endMs: toVideo(s.endTimeMs) }))
    .filter((r) => r.endMs > 0)
    .sort((a, b) => a.startMs - b.startMs)
  const merged: Array<{ startMs: number; endMs: number }> = []
  for (const range of raw) {
    const last = merged[merged.length - 1]
    if (last && range.startMs <= last.endMs + 2000) last.endMs = Math.max(last.endMs, range.endMs)
    else merged.push({ ...range })
  }
  return merged
}

/** Visible at 1x, hidden at a speed that leaves no frames: the renderer applies segments only if one is not 1x. */
export function speedSegments(hidden: ReadonlyArray<{ startMs: number; endMs: number }>, videoEndMs: number): Array<{ startMs: number; endMs: number; speed: number }> {
  const segments: Array<{ startMs: number; endMs: number; speed: number }> = []
  let cursor = 0
  for (const range of hidden) {
    if (cursor < range.startMs) segments.push({ startMs: cursor, endMs: range.startMs, speed: 1.0 })
    segments.push({ startMs: range.startMs, endMs: range.endMs, speed: 9999 })
    cursor = range.endMs
  }
  if (cursor < videoEndMs) segments.push({ startMs: cursor, endMs: videoEndMs, speed: 1.0 })
  return segments
}
