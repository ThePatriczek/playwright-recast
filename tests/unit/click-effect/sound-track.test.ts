import { describe, it, expect } from 'vitest'
import { buildClickSoundArgs } from '../../../src/click-effect/sound-track'

describe('buildClickSoundArgs', () => {
  it('creates correct silence durations for clicks at given timestamps', () => {
    const result = buildClickSoundArgs({
      clicks: [
        { videoTimeMs: 1000 },
        { videoTimeMs: 5000 },
        { videoTimeMs: 8000 },
      ],
      soundPath: '/tmp/click.mp3',
      soundDurationMs: 50,
      outputPath: '/tmp/click-track.mp3',
      volume: 0.8,
    })

    expect(result.silenceDurations).toHaveLength(3)
    expect(result.silenceDurations[0]).toBe(1000)
    expect(result.silenceDurations[1]).toBe(3950) // 5000 - (1000+50)
    expect(result.silenceDurations[2]).toBe(2950) // 8000 - (5000+50)
  })

  it('handles single click at t=0', () => {
    const result = buildClickSoundArgs({
      clicks: [{ videoTimeMs: 0 }],
      soundPath: '/tmp/click.mp3',
      soundDurationMs: 50,
      outputPath: '/tmp/click-track.mp3',
      volume: 0.8,
    })
    expect(result.silenceDurations).toHaveLength(1)
    expect(result.silenceDurations[0]).toBe(0)
  })

  it('skips clicks too close together (within sound duration)', () => {
    const result = buildClickSoundArgs({
      clicks: [
        { videoTimeMs: 1000 },
        { videoTimeMs: 1020 }, // only 20ms after, sound is 50ms
        { videoTimeMs: 3000 },
      ],
      soundPath: '/tmp/click.mp3',
      soundDurationMs: 50,
      outputPath: '/tmp/click-track.mp3',
      volume: 0.8,
    })
    expect(result.silenceDurations).toHaveLength(2) // second click skipped
    expect(result.filteredClicks).toHaveLength(2)
  })

  it('sorts unsorted clicks', () => {
    const result = buildClickSoundArgs({
      clicks: [
        { videoTimeMs: 5000 },
        { videoTimeMs: 1000 },
        { videoTimeMs: 3000 },
      ],
      soundPath: '/tmp/click.mp3',
      soundDurationMs: 50,
      outputPath: '/tmp/click-track.mp3',
      volume: 0.8,
    })
    expect(result.filteredClicks.map(c => c.videoTimeMs)).toEqual([1000, 3000, 5000])
  })
})
