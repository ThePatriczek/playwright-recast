import { describe, it, expect } from 'vitest'
import { resolveCursorOverlayConfig, DEFAULT_CURSOR_OVERLAY } from '../../../src/cursor-overlay/defaults'

describe('resolveCursorOverlayConfig', () => {
  it('returns all defaults when no config provided', () => {
    const resolved = resolveCursorOverlayConfig({})
    expect(resolved.size).toBe(24)
    expect(resolved.color).toBe('#FFFFFF')
    expect(resolved.opacity).toBe(0.9)
    expect(resolved.easing).toBe('ease-in-out')
    expect(resolved.hideAfterMs).toBe(500)
    expect(resolved.shadow).toBe(true)
  })

  it('overrides specific values', () => {
    const resolved = resolveCursorOverlayConfig({ size: 32, color: '#FF0000' })
    expect(resolved.size).toBe(32)
    expect(resolved.color).toBe('#FF0000')
    expect(resolved.opacity).toBe(0.9)
    expect(resolved.easing).toBe('ease-in-out')
  })

  it('preserves filter function', () => {
    const filter = () => true
    const resolved = resolveCursorOverlayConfig({ filter })
    expect(resolved.filter).toBe(filter)
  })

  it('preserves custom image path', () => {
    const resolved = resolveCursorOverlayConfig({ image: '/path/to/cursor.png' })
    expect(resolved.image).toBe('/path/to/cursor.png')
  })
})

describe('DEFAULT_CURSOR_OVERLAY', () => {
  it('has all required fields', () => {
    expect(DEFAULT_CURSOR_OVERLAY.size).toBeDefined()
    expect(DEFAULT_CURSOR_OVERLAY.color).toBeDefined()
    expect(DEFAULT_CURSOR_OVERLAY.opacity).toBeDefined()
    expect(DEFAULT_CURSOR_OVERLAY.easing).toBeDefined()
    expect(DEFAULT_CURSOR_OVERLAY.hideAfterMs).toBeDefined()
    expect(DEFAULT_CURSOR_OVERLAY.shadow).toBeDefined()
  })
})
