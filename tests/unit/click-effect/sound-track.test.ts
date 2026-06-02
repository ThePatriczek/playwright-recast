import { describe, it, expect } from 'vitest'
import { buildClickSoundPlan } from '../../../src/click-effect/sound-track'

describe('buildClickSoundPlan', () => {
  it('places one sound per click at the click time', () => {
    const result = buildClickSoundPlan([
      { videoTimeMs: 1000 },
      { videoTimeMs: 5000 },
      { videoTimeMs: 8000 },
    ])
    expect(result.delaysMs).toEqual([1000, 5000, 8000])
  })

  it('handles a single click at t=0', () => {
    expect(buildClickSoundPlan([{ videoTimeMs: 0 }]).delaysMs).toEqual([0])
  })

  it('keeps clicks spaced closer than the sound duration (regression: were dropped)', () => {
    // focus-then-type and other rapid clicks must each get a sound; they
    // simply overlap when mixed, matching the ripple overlays.
    const result = buildClickSoundPlan([
      { videoTimeMs: 15846 },
      { videoTimeMs: 16665 }, // 819ms later; default sound is ~1489ms
    ])
    expect(result.delaysMs).toEqual([15846, 16665])
  })

  it('sorts unsorted clicks', () => {
    const result = buildClickSoundPlan([
      { videoTimeMs: 5000 },
      { videoTimeMs: 1000 },
      { videoTimeMs: 3000 },
    ])
    expect(result.delaysMs).toEqual([1000, 3000, 5000])
  })

  it('rounds and clamps negative times to zero', () => {
    expect(buildClickSoundPlan([{ videoTimeMs: -5 }, { videoTimeMs: 12.4 }]).delaysMs)
      .toEqual([0, 12])
  })
})
