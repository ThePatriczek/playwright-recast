import { describe, it, expect } from 'vitest'
import { cursorClock } from '../../../src/cursor-overlay/clock'
import { toMonotonic, type ScreencastFrame } from '../../../src/types/trace'

const frame = (pageId: string, t: number) => ({ sha1: '', pageId, width: 1, height: 1, timestamp: toMonotonic(t) }) as ScreencastFrame
// A setup page's frame first, then the recording page's.
const frames = [frame('setup', 1000), frame('rec', 4000), frame('rec', 5000)]

describe('cursorClock()', () => {
  it('times from the first frame without a speed map, as clicks and cursor always have', () => {
    expect(cursorClock(frames, 0, undefined)(6000)).toBe(5000)
  })

  it("times from the recording page's first frame through the speed map", () => {
    const toVideo = cursorClock(frames, 0, { speedSegments: [{}], timeRemap: (t: number) => t / 2 } as never)
    expect(toVideo(6000)).toBe(1000)
  })
})
