import { describe, it, expect } from 'vitest'
import { stabilizePan } from '../../../src/render/zoom-expression'

const kf = (atMs: number, x: number, y: number, level = 2) => ({ atMs, x, y, level, transitionMs: 1000 })
const config = { transitionMs: 400, containInCue: false }
const centres = (kfs: ReturnType<typeof stabilizePan>) => kfs.map((k) => [k.x, k.y])

// At level 2 the crop is half the frame, so a threshold of 0.3 reaches 0.15 of the
// frame from the visible centre, on each axis.
describe('stabilizePan()', () => {
  it('holds the camera for targets within the threshold on both axes', () => {
    const out = stabilizePan([kf(0, 0.5, 0.5), kf(1000, 0.6, 0.4), kf(2000, 0.45, 0.62)], 0.3, config)
    expect(centres(out)).toEqual([[0.5, 0.5], [0.5, 0.5], [0.5, 0.5]])
  })

  it('pans only the axis whose target moved past the threshold', () => {
    const out = stabilizePan([kf(0, 0.5, 0.5), kf(1000, 0.55, 0.8)], 0.3, config)
    expect(centres(out)).toEqual([[0.5, 0.5], [0.5, 0.8]])
  })

  it('measures from the new camera position after a pan', () => {
    const out = stabilizePan([kf(0, 0.5, 0.3, config), kf(1000, 0.5, 0.7), kf(2000, 0.5, 0.6)], 0.3, config)
    expect(centres(out)).toEqual([[0.5, 0.3], [0.5, 0.7], [0.5, 0.7]])
  })

  it('measures from the visible, edge-clamped centre', () => {
    // A target at x=0.1 shows a crop centred at 0.25; 0.38 is within 0.15 of that.
    const out = stabilizePan([kf(0, 0.1, 0.5), kf(1000, 0.38, 0.5)], 0.3, config)
    expect(centres(out)).toEqual([[0.1, 0.5], [0.1, 0.5]])
  })

  it('moves both axes when the level changes', () => {
    const out = stabilizePan([kf(0, 0.5, 0.5), kf(1000, 0.55, 0.55, 1.5)], 0.3, config)
    expect(centres(out)).toEqual([[0.5, 0.5], [0.55, 0.55]])
  })

  it('moves when the camera zoomed out between the cues', () => {
    // Hold ends at 1000; a gap of 2 x transitionMs zooms out in between.
    const out = stabilizePan([kf(0, 0.5, 0.5), kf(1800, 0.55, 0.55)], 0.3, config)
    expect(centres(out)).toEqual([[0.5, 0.5], [0.55, 0.55]])
  })

  it('moves with containInCue, which zooms out after every cue', () => {
    const out = stabilizePan([kf(0, 0.5, 0.5), kf(1000, 0.55, 0.55)], 0.3, { ...config, containInCue: true })
    expect(centres(out)).toEqual([[0.5, 0.5], [0.55, 0.55]])
  })

  it('is off at threshold 0', () => {
    const input = [kf(0, 0.5, 0.5), kf(1000, 0.51, 0.49)]
    expect(stabilizePan(input, 0, config)).toBe(input)
  })
})
