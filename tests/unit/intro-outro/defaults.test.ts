import { describe, it, expect } from 'vitest'
import { resolveIntroConfig, resolveOutroConfig } from '../../../src/render/intro-outro'

describe('resolveIntroConfig', () => {
  it('applies default fadeDuration when not provided', () => {
    const resolved = resolveIntroConfig({ path: '/tmp/intro.mov' })
    expect(resolved.fadeDuration).toBe(500)
    expect(resolved.path).toBe('/tmp/intro.mov')
  })

  it('preserves custom fadeDuration', () => {
    const resolved = resolveIntroConfig({ path: '/tmp/intro.mov', fadeDuration: 800 })
    expect(resolved.fadeDuration).toBe(800)
  })

  it('preserves the path exactly', () => {
    const resolved = resolveIntroConfig({ path: '/some/path/with spaces/intro.mov' })
    expect(resolved.path).toBe('/some/path/with spaces/intro.mov')
  })
})

describe('resolveOutroConfig', () => {
  it('applies default fadeDuration when not provided', () => {
    const resolved = resolveOutroConfig({ path: '/tmp/outro.mov' })
    expect(resolved.fadeDuration).toBe(500)
    expect(resolved.path).toBe('/tmp/outro.mov')
  })

  it('preserves custom fadeDuration', () => {
    const resolved = resolveOutroConfig({ path: '/tmp/outro.mov', fadeDuration: 300 })
    expect(resolved.fadeDuration).toBe(300)
  })

  it('allows fadeDuration of 0', () => {
    const resolved = resolveOutroConfig({ path: '/tmp/outro.mov', fadeDuration: 0 })
    expect(resolved.fadeDuration).toBe(0)
  })
})
