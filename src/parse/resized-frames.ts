import type { MonotonicMs, ScreencastFrame, TraceAction } from '../types/trace.js'
import { jpegSize } from './jpeg.js'

type Size = { width: number; height: number }
type Frame = Pick<ScreencastFrame, 'pageId' | 'timestamp' | 'width' | 'height'>

/**
 * Spans to cut where a page was briefly rendered at another size than its
 * viewport, which Chromium does for a clip, element or toHaveScreenshot()
 * screenshot: the video shows it over gray padding. A size change counts when
 * it is unexplained (no setViewportSize() on the page, or without a page id,
 * since the last frame) and brief (the page returns to its size); the span
 * runs to that frame.
 */
export function resizedFrameSpans(
  frames: ReadonlyArray<Frame>,
  pixelsOf: (frameIndex: number) => Size | undefined,
  actions: ReadonlyArray<Pick<TraceAction, 'method' | 'pageId' | 'startTime'>>,
): Array<{ pageId: string; start: MonotonicMs; end: MonotonicMs }> {
  const resizes = actions.filter((a) => a.method === 'setViewportSize')
  const resizedBetween = (pageId: string, after: number, upTo: number): boolean =>
    resizes.some((a) => (a.pageId === undefined || a.pageId === pageId) && (a.startTime as number) > after && (a.startTime as number) <= upTo)

  const spans: Array<{ pageId: string; start: MonotonicMs; end: MonotonicMs }> = []
  const pages = new Map<string, { size: string; last: number; start?: MonotonicMs }>()
  frames.forEach((f, i) => {
    const pixels = pixelsOf(i)
    if (!pixels) return
    const size = `${f.width}x${f.height}/${pixels.width}x${pixels.height}`
    const page = pages.get(f.pageId)
    if (!page) {
      pages.set(f.pageId, { size, last: f.timestamp as number })
      return
    }
    if (size === page.size) {
      if (page.start !== undefined) spans.push({ pageId: f.pageId, start: page.start, end: f.timestamp })
      page.start = undefined
    } else if (resizedBetween(f.pageId, page.last, f.timestamp as number)) {
      // Playwright changed the viewport: the new size is the page's
      page.size = size
      page.start = undefined
    } else if (page.start === undefined) {
      page.start = f.timestamp
    }
    page.last = f.timestamp as number
  })
  // A run still open at the end never returned: not brief, nothing to cut
  return spans
}

/** resizedFrameSpans() for a trace, reading each frame's JPEG size. */
export function resizedFrameSpansFromJpegs(
  frames: ReadonlyArray<Frame & Pick<ScreencastFrame, 'sha1'>>,
  readJpeg: (sha1: string) => Buffer | undefined,
  actions: ReadonlyArray<Pick<TraceAction, 'method' | 'pageId' | 'startTime'>>,
): Array<{ pageId: string; start: MonotonicMs; end: MonotonicMs }> {
  return resizedFrameSpans(frames, (i) => {
    const data = readJpeg(frames[i]!.sha1)
    return data ? jpegSize(data) : undefined
  }, actions)
}
