import type { ScreencastFrame } from '../types/trace.js'

/**
 * The recording page (the last frame's) and its first frame, the video's
 * t=0: every stage times the video from here.
 */
export function recordingFrame(frames: ReadonlyArray<ScreencastFrame>): { pageId?: string; firstFrameMs?: number } {
  const pageId = frames[frames.length - 1]?.pageId
  return { pageId, firstFrameMs: frames.find((f) => f.pageId === pageId)?.timestamp as number | undefined }
}
