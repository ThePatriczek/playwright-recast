import { describe, it, expect } from 'vitest'
import { buildRippleArgs } from '../../../src/click-effect/ripple-generator'

describe('buildRippleArgs', () => {
  it('produces valid ffmpeg args for default config', () => {
    const args = buildRippleArgs({
      color: '#3B82F6',
      opacity: 0.5,
      radius: 30,
      duration: 400,
      outputPath: '/tmp/ripple.mov',
      scaleFactor: 1.0,
    })

    expect(args).toContain('-f')
    expect(args).toContain('lavfi')
    expect(args.some(a => a.includes('geq'))).toBe(true)
    expect(args.some(a => a.includes('format=rgba'))).toBe(true)
    expect(args).toContain('/tmp/ripple.mov')
  })

  it('scales radius by scaleFactor', () => {
    const args1x = buildRippleArgs({
      color: '#FF0000', opacity: 0.6, radius: 30, duration: 400,
      outputPath: '/tmp/ripple.mov', scaleFactor: 1.0,
    })
    const args2x = buildRippleArgs({
      color: '#FF0000', opacity: 0.6, radius: 30, duration: 400,
      outputPath: '/tmp/ripple.mov', scaleFactor: 2.0,
    })

    const getSize = (args: string[]) => {
      const lavfi = args.find(a => a.includes('color='))!
      const match = lavfi.match(/s=(\d+)x(\d+)/)
      return match ? Number(match[1]) : 0
    }
    expect(getSize(args2x)).toBe(getSize(args1x) * 2)
  })

  it('embeds correct color components in geq', () => {
    const args = buildRippleArgs({
      color: '#FF8800', opacity: 0.5, radius: 30, duration: 400,
      outputPath: '/tmp/ripple.mov', scaleFactor: 1.0,
    })
    const vf = args.find(a => a.includes('geq'))!
    expect(vf).toContain('r=255')
    expect(vf).toContain('g=136')
    expect(vf).toContain('b=0')
  })
})
