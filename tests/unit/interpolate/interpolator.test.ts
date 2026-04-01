import { describe, it, expect } from 'vitest'
import { buildMinterpolateFilter, computePassFps } from '../../../src/interpolate/interpolator'

describe('buildMinterpolateFilter', () => {
  it('returns default config (60fps, mci, balanced)', () => {
    const filter = buildMinterpolateFilter({})
    expect(filter).toBe('minterpolate=fps=60:mi_mode=mci:scd=fdiff:scd_threshold=5:mc_mode=aobmc:me_mode=bidir:vsbmc=1:search_param=64')
  })

  it('respects custom fps', () => {
    const filter = buildMinterpolateFilter({ fps: 30 })
    expect(filter).toContain('fps=30')
  })

  it('maps fast quality preset', () => {
    const filter = buildMinterpolateFilter({ quality: 'fast' })
    expect(filter).toContain('mc_mode=obmc')
    expect(filter).toContain('me_mode=bilat')
    expect(filter).toContain('vsbmc=0')
    expect(filter).toContain('search_param=32')
  })

  it('maps balanced quality preset', () => {
    const filter = buildMinterpolateFilter({ quality: 'balanced' })
    expect(filter).toContain('mc_mode=aobmc')
    expect(filter).toContain('me_mode=bidir')
    expect(filter).toContain('vsbmc=1')
    expect(filter).toContain('search_param=64')
  })

  it('maps quality quality preset', () => {
    const filter = buildMinterpolateFilter({ quality: 'quality' })
    expect(filter).toContain('mc_mode=aobmc')
    expect(filter).toContain('me_mode=bidir')
    expect(filter).toContain('vsbmc=1')
    expect(filter).toContain('search_param=400')
  })

  it('dup mode omits mc parameters', () => {
    const filter = buildMinterpolateFilter({ mode: 'dup' })
    expect(filter).toContain('mi_mode=dup')
    expect(filter).toContain('scd_threshold=5')
    expect(filter).not.toContain('mc_mode')
    expect(filter).not.toContain('me_mode')
  })

  it('blend mode omits mc parameters', () => {
    const filter = buildMinterpolateFilter({ mode: 'blend' })
    expect(filter).toContain('mi_mode=blend')
    expect(filter).toContain('scd_threshold=5')
  })

  it('combines all options', () => {
    const filter = buildMinterpolateFilter({ fps: 120, mode: 'mci', quality: 'quality' })
    expect(filter).toBe('minterpolate=fps=120:mi_mode=mci:scd=fdiff:scd_threshold=5:mc_mode=aobmc:me_mode=bidir:vsbmc=1:search_param=400')
  })

  it('respects targetFps override parameter', () => {
    const filter = buildMinterpolateFilter({ fps: 60, mode: 'blend' }, 42)
    expect(filter).toContain('fps=42')
    expect(filter).toContain('mi_mode=blend')
  })
})

describe('computePassFps', () => {
  it('returns target fps for single pass', () => {
    expect(computePassFps(25, 60, 1)).toEqual([60])
  })

  it('distributes geometrically for 2 passes', () => {
    const result = computePassFps(25, 60, 2)
    expect(result).toHaveLength(2)
    expect(result[0]).toBeGreaterThan(25)
    expect(result[0]).toBeLessThan(60)
    expect(result[1]).toBe(60)
  })

  it('distributes geometrically for 3 passes', () => {
    const result = computePassFps(25, 60, 3)
    expect(result).toHaveLength(3)
    expect(result[0]).toBeGreaterThan(25)
    expect(result[1]).toBeGreaterThan(result[0]!)
    expect(result[2]).toBe(60)
  })

  it('last pass always equals target fps exactly', () => {
    for (const passes of [1, 2, 3, 4]) {
      const result = computePassFps(25, 60, passes)
      expect(result[result.length - 1]).toBe(60)
    }
  })

  it('intermediate values are monotonically increasing', () => {
    const result = computePassFps(24, 120, 4)
    for (let i = 1; i < result.length; i++) {
      expect(result[i]).toBeGreaterThan(result[i - 1]!)
    }
  })
})
