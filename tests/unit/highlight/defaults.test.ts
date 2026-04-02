import { describe, it, expect } from 'vitest'
import { resolveTextHighlightConfig, DEFAULT_TEXT_HIGHLIGHT } from '../../../src/text-highlight/defaults'

describe('resolveTextHighlightConfig', () => {
  it('returns all defaults when no config provided', () => {
    const resolved = resolveTextHighlightConfig({})
    expect(resolved.color).toBe('#FFEB3B')
    expect(resolved.opacity).toBe(0.35)
    expect(resolved.duration).toBe(2000)
    expect(resolved.fadeOut).toBe(0)
    expect(resolved.swipeDuration).toBe(300)
    expect(resolved.padding).toEqual({ x: 4, y: 2 })
  })

  it('overrides specific values', () => {
    const resolved = resolveTextHighlightConfig({ color: '#FF0000', opacity: 0.6 })
    expect(resolved.color).toBe('#FF0000')
    expect(resolved.opacity).toBe(0.6)
    expect(resolved.duration).toBe(2000)
  })

  it('overrides padding partially', () => {
    const resolved = resolveTextHighlightConfig({ padding: { x: 10 } })
    expect(resolved.padding).toEqual({ x: 10, y: 2 })
  })

  it('preserves filter function', () => {
    const filter = () => true
    const resolved = resolveTextHighlightConfig({ filter })
    expect(resolved.filter).toBe(filter)
  })
})

describe('DEFAULT_TEXT_HIGHLIGHT', () => {
  it('has all required fields', () => {
    expect(DEFAULT_TEXT_HIGHLIGHT.color).toBeDefined()
    expect(DEFAULT_TEXT_HIGHLIGHT.opacity).toBeDefined()
    expect(DEFAULT_TEXT_HIGHLIGHT.duration).toBeDefined()
    expect(DEFAULT_TEXT_HIGHLIGHT.fadeOut).toBeDefined()
    expect(DEFAULT_TEXT_HIGHLIGHT.swipeDuration).toBeDefined()
    expect(DEFAULT_TEXT_HIGHLIGHT.paddingX).toBeDefined()
    expect(DEFAULT_TEXT_HIGHLIGHT.paddingY).toBeDefined()
  })
})
