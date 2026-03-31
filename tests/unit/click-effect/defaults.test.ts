import { describe, it, expect } from 'vitest'
import { resolveClickEffectConfig, DEFAULT_CLICK_EFFECT } from '../../../src/click-effect/defaults'

describe('resolveClickEffectConfig', () => {
  it('returns all defaults when no config provided', () => {
    const resolved = resolveClickEffectConfig({})
    expect(resolved.color).toBe('#3B82F6')
    expect(resolved.opacity).toBe(0.5)
    expect(resolved.radius).toBe(30)
    expect(resolved.duration).toBe(400)
    expect(resolved.soundVolume).toBe(0.8)
  })

  it('overrides specific values', () => {
    const resolved = resolveClickEffectConfig({ color: '#FF0000', radius: 50 })
    expect(resolved.color).toBe('#FF0000')
    expect(resolved.radius).toBe(50)
    expect(resolved.opacity).toBe(0.5)
  })

  it('preserves filter function', () => {
    const filter = () => true
    const resolved = resolveClickEffectConfig({ filter })
    expect(resolved.filter).toBe(filter)
  })
})

describe('DEFAULT_CLICK_EFFECT', () => {
  it('has all required fields', () => {
    expect(DEFAULT_CLICK_EFFECT.color).toBeDefined()
    expect(DEFAULT_CLICK_EFFECT.opacity).toBeDefined()
    expect(DEFAULT_CLICK_EFFECT.radius).toBeDefined()
    expect(DEFAULT_CLICK_EFFECT.duration).toBeDefined()
    expect(DEFAULT_CLICK_EFFECT.soundVolume).toBeDefined()
  })
})
