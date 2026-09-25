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

  it('rounds the video size for a decimal scale', () => {
    const use = recastVideo({ viewport: { width: 1920, height: 1080 }, scale: 1.3334 })
    expect(use.video).toEqual({ mode: 'on', size: { width: 2560, height: 1440 } })
  })

  it.each([0.5, 0, -2, Number.NaN])('rejects scale %s', (scale) => {
    expect(() => recastVideo({ viewport: { width: 1920, height: 1080 }, scale })).toThrow(/>= 1/)
  })
})
