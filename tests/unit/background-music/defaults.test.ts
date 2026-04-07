import { describe, it, expect } from 'vitest'
import { resolveBackgroundMusicConfig, DEFAULT_BACKGROUND_MUSIC } from '../../../src/background-music/defaults'

describe('resolveBackgroundMusicConfig', () => {
  it('returns all defaults when only path provided', () => {
    const resolved = resolveBackgroundMusicConfig({ path: '/tmp/music.mp3' })
    expect(resolved.path).toBe('/tmp/music.mp3')
    expect(resolved.volume).toBe(0.3)
    expect(resolved.ducking).toBe(true)
    expect(resolved.duckLevel).toBe(0.1)
    expect(resolved.duckFadeMs).toBe(500)
    expect(resolved.fadeOutMs).toBe(3000)
    expect(resolved.loop).toBe(true)
  })

  it('overrides specific values', () => {
    const resolved = resolveBackgroundMusicConfig({
      path: '/tmp/music.mp3',
      volume: 0.5,
      ducking: false,
      fadeOutMs: 5000,
    })
    expect(resolved.volume).toBe(0.5)
    expect(resolved.ducking).toBe(false)
    expect(resolved.fadeOutMs).toBe(5000)
    // Defaults preserved for unset fields
    expect(resolved.duckLevel).toBe(0.1)
    expect(resolved.duckFadeMs).toBe(500)
    expect(resolved.loop).toBe(true)
  })

  it('produces no undefined values', () => {
    const resolved = resolveBackgroundMusicConfig({ path: '/tmp/music.mp3' })
    for (const [key, value] of Object.entries(resolved)) {
      expect(value, `${key} should not be undefined`).toBeDefined()
    }
  })
})

describe('DEFAULT_BACKGROUND_MUSIC', () => {
  it('has all required fields', () => {
    expect(DEFAULT_BACKGROUND_MUSIC.volume).toBeDefined()
    expect(DEFAULT_BACKGROUND_MUSIC.ducking).toBeDefined()
    expect(DEFAULT_BACKGROUND_MUSIC.duckLevel).toBeDefined()
    expect(DEFAULT_BACKGROUND_MUSIC.duckFadeMs).toBeDefined()
    expect(DEFAULT_BACKGROUND_MUSIC.fadeOutMs).toBeDefined()
    expect(DEFAULT_BACKGROUND_MUSIC.loop).toBeDefined()
  })
})
