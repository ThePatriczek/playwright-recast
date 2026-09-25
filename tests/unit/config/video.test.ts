import { describe, it, expect } from 'vitest'
import { recastVideo } from '../../../src/config/video'

describe('recastVideo()', () => {
  it('records at viewport x scale, headless, with the forced device scale', () => {
    expect(recastVideo({ viewport: { width: 1920, height: 1080 } })).toEqual({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 2,
      headless: true,
      launchOptions: { args: ['--force-device-scale-factor=2'] },
      video: { mode: 'on', size: { width: 3840, height: 2160 } },
    })
  })

  it('honours an explicit scale', () => {
    const use = recastVideo({ viewport: { width: 1280, height: 720 }, scale: 3 })
    expect(use.video).toEqual({ mode: 'on', size: { width: 3840, height: 2160 } })
    expect(use.launchOptions).toEqual({ args: ['--force-device-scale-factor=3'] })
  })

  it('takes a decimal scale that gives whole, even pixels as is', () => {
    const use = recastVideo({ viewport: { width: 1920, height: 1080 }, scale: 4 / 3 })
    expect(use.video.size).toEqual({ width: 2560, height: 1440 })
  })

  it.each([
    [{ width: 1920, height: 1080 }, 1.3334, 1.35, { width: 2592, height: 1458 }],
    [{ width: 320, height: 240 }, 1.33, 1.35, { width: 432, height: 324 }],
    [{ width: 1366, height: 768 }, 1.5, 2, { width: 2732, height: 1536 }],
  ])('rounds %o x %s up to %s, the next whole, even size', (viewport, requested, scale, size) => {
    const use = recastVideo({ viewport, scale: requested })
    expect(use.deviceScaleFactor).toBeCloseTo(scale, 10)
    expect(use.launchOptions.args).toEqual([`--force-device-scale-factor=${use.deviceScaleFactor}`])
    expect(use.video.size).toEqual(size)
  })

  it.each([{ width: 1920.5, height: 1080 }, { width: 0, height: 0 }, { width: -1920, height: 1080 }])('rejects viewport %o', (viewport) => {
    expect(() => recastVideo({ viewport })).toThrow(/positive, whole CSS pixels/)
  })

  it.each([0.5, 0, -2, Number.NaN])('rejects scale %s', (scale) => {
    expect(() => recastVideo({ viewport: { width: 1920, height: 1080 }, scale })).toThrow(/>= 1/)
  })
})
