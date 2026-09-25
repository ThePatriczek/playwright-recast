import { describe, it, expect } from 'vitest'
import { upscaleFactor, upscaleWarning } from '../../../src/render/sharpness'

const p1080 = { width: 1920, height: 1080 }
const p1440 = { width: 2560, height: 1440 }
const p2160 = { width: 3840, height: 2160 }

describe('upscaleFactor()', () => {
  it('is the output size at the tightest zoom over the source size', () => {
    expect(upscaleFactor(p1080, p1440, 1.8)).toBeCloseTo(2.4, 5)
    expect(upscaleFactor(p2160, p1440, 1.5)).toBeCloseTo(1.0, 5)
  })

  it('uses the tighter axis for a source with another aspect ratio', () => {
    expect(upscaleFactor({ width: 2560, height: 1080 }, p1440, 1)).toBeCloseTo(1440 / 1080, 5)
  })
})

describe('upscaleWarning()', () => {
  it('stays quiet up to 1.25x, where text still looks crisp', () => {
    expect(upscaleWarning(p2160, p1440, 1.8)).toBeNull() // 1.2x
    expect(upscaleWarning(p2160, p1440, 1.875)).toBeNull() // 1.25x
  })

  it('calls up to 1.5x slightly soft', () => {
    expect(upscaleWarning(p2160, p1440, 2.2)).toMatch(/upscaled 1\.47x .* slightly soft/)
  })

  it('calls beyond 1.5x soft and names the recording size that would be sharp', () => {
    const warning = upscaleWarning(p1080, p1440, 1.8)
    expect(warning).toMatch(/upscaled 2\.40x .* zoom 1\.8; text will be soft\./)
    expect(warning).toMatch(/Record at 4608x2592 or more/)
  })
})
