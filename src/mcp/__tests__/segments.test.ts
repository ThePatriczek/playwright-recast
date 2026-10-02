import { describe, it, expect } from 'vitest'
import { hiddenRanges, speedSegments } from '../segments.js'

const toVideo = (t: number) => t - 1000 // video t=0 at trace 1000

describe('hiddenRanges', () => {
  it('cuts hidden steps on the video clock and merges ranges under 2 s apart', () => {
    expect(hiddenRanges([
      { startTimeMs: 3000, endTimeMs: 4000, hidden: true },
      { startTimeMs: 5500, endTimeMs: 6000, hidden: true },
      { startTimeMs: 7000, endTimeMs: 8000, hidden: false },
      { startTimeMs: 10_000, endTimeMs: 11_000, hidden: true },
    ], toVideo)).toEqual([{ startMs: 2000, endMs: 5000 }, { startMs: 9000, endMs: 10_000 }])
  })

  it('drops steps that end before the video starts, and clamps one that spans its start', () => {
    expect(hiddenRanges([
      { startTimeMs: 200, endTimeMs: 900, hidden: true },
      { startTimeMs: 800, endTimeMs: 1500, hidden: true },
    ], toVideo)).toEqual([{ startMs: 0, endMs: 500 }])
  })
})

describe('speedSegments', () => {
  it('plays visible stretches at 1x up to the video end and skips hidden ones', () => {
    expect(speedSegments([{ startMs: 2000, endMs: 5000 }], 8000)).toEqual([
      { startMs: 0, endMs: 2000, speed: 1 },
      { startMs: 2000, endMs: 5000, speed: 9999 },
      { startMs: 5000, endMs: 8000, speed: 1 },
    ])
  })
})
