import { describe, it, expect } from 'vitest'
import { resizedFrameSpans } from '../../../src/parse/resized-frames'
import { toMonotonic } from '../../../src/types/trace'

const PAGE = 'page@aa'
type F = [t: number, css: string, px: string]
const spans = (list: F[], resizes: number[] = []) => {
  const frames = list.map(([t, css]) => {
    const [width, height] = css.split('x').map(Number)
    return { pageId: PAGE, timestamp: toMonotonic(t), width: width!, height: height! }
  })
  const pixels = list.map(([, , px]) => { const [width, height] = px.split('x').map(Number); return { width: width!, height: height! } })
  const actions = resizes.map((t) => ({ method: 'setViewportSize', pageId: PAGE, startTime: toMonotonic(t) }))
  return resizedFrameSpans(frames, (i) => pixels[i], actions).map((s) => [s.start as number, s.end as number])
}

describe('resizedFrameSpans', () => {
  it('cuts a brief run of another pixel size up to the frame back at the page size', () => {
    // A clip screenshot (measured): 4608x2309 pixels for a 1920x1080 viewport
    expect(spans([[1654, '1920x1080', '4608x2592'], [2620, '1920x1080', '4608x2309'], [2753, '1920x1080', '4608x2592']]))
      .toEqual([[2620, 2753]])
  })

  it('cuts a brief run where the reported viewport changed too', () => {
    // A page-level toHaveScreenshot() (measured): Chromium reports 800x450 for those frames
    expect(spans([[2445, '1920x1080', '4608x2592'], [2543, '800x450', '1921x1080'], [2810, '1920x1080', '4608x2592']]))
      .toEqual([[2543, 2810]])
  })

  it('keeps a change setViewportSize() made, also when it is undone later', () => {
    expect(spans([
      [1000, '1920x1080', '4608x2592'], [2000, '800x600', '1920x1440'], [3000, '1920x1080', '4608x2592'],
    ], [1958, 2963])).toEqual([])
  })

  it('keeps a change that persists, as when a page resizes its own window', () => {
    expect(spans([[1000, '1280x720', '1280x720'], [2000, '640x480', '640x480'], [3000, '640x480', '640x480']])).toEqual([])
  })

  it('looks at each page on its own', () => {
    const frames = [
      { pageId: 'page@aa', timestamp: toMonotonic(100), width: 100, height: 100 },
      { pageId: 'page@bb', timestamp: toMonotonic(200), width: 50, height: 50 },
      { pageId: 'page@aa', timestamp: toMonotonic(300), width: 100, height: 100 },
    ]
    expect(resizedFrameSpans(frames, (i) => [{ width: 100, height: 100 }, { width: 50, height: 50 }, { width: 100, height: 100 }][i], [])).toEqual([])
  })
})
