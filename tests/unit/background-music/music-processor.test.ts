import { describe, it, expect } from 'vitest'
import { mergeAdjacentSegments, buildDuckingFilters } from '../../../src/background-music/music-processor'
import type { ResolvedBackgroundMusicConfig } from '../../../src/background-music/defaults'

const baseConfig: ResolvedBackgroundMusicConfig = {
  path: '/tmp/music.mp3',
  volume: 0.3,
  ducking: true,
  duckLevel: 0.1,
  duckFadeMs: 500,
  fadeOutMs: 3000,
  loop: true,
}

describe('mergeAdjacentSegments', () => {
  it('returns empty array for empty input', () => {
    expect(mergeAdjacentSegments([], 1000)).toEqual([])
  })

  it('returns single segment unchanged', () => {
    const result = mergeAdjacentSegments([{ startMs: 1000, endMs: 3000 }], 1000)
    expect(result).toEqual([{ startMs: 1000, endMs: 3000 }])
  })

  it('keeps distant segments separate', () => {
    const result = mergeAdjacentSegments(
      [
        { startMs: 1000, endMs: 2000 },
        { startMs: 5000, endMs: 6000 },
      ],
      1000,
    )
    expect(result).toHaveLength(2)
  })

  it('merges segments closer than gapMs', () => {
    const result = mergeAdjacentSegments(
      [
        { startMs: 1000, endMs: 2000 },
        { startMs: 2500, endMs: 3500 }, // 500ms gap, less than 1000
      ],
      1000,
    )
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ startMs: 1000, endMs: 3500 })
  })

  it('sorts unsorted segments before merging', () => {
    const result = mergeAdjacentSegments(
      [
        { startMs: 5000, endMs: 6000 },
        { startMs: 1000, endMs: 2000 },
      ],
      1000,
    )
    expect(result[0]!.startMs).toBe(1000)
  })

  it('merges chain of close segments into one', () => {
    const result = mergeAdjacentSegments(
      [
        { startMs: 1000, endMs: 2000 },
        { startMs: 2200, endMs: 3000 },
        { startMs: 3100, endMs: 4000 },
      ],
      500,
    )
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ startMs: 1000, endMs: 4000 })
  })
})

describe('buildDuckingFilters', () => {
  it('includes base volume filter', () => {
    const filters = buildDuckingFilters([], baseConfig, 30)
    expect(filters[0]).toBe('volume=0.3')
  })

  it('includes fade-out filter', () => {
    const filters = buildDuckingFilters([], baseConfig, 30)
    const fadeFilter = filters.find(f => f.startsWith('afade='))
    expect(fadeFilter).toBeDefined()
    expect(fadeFilter).toContain('t=out')
    expect(fadeFilter).toContain('st=27.000') // 30 - 3
    expect(fadeFilter).toContain('d=3.000')
  })

  it('skips ducking when no segments', () => {
    const filters = buildDuckingFilters([], baseConfig, 30)
    // Should only have base volume + fade out
    expect(filters).toHaveLength(2)
  })

  it('skips ducking when ducking is disabled', () => {
    const config = { ...baseConfig, ducking: false }
    const filters = buildDuckingFilters(
      [{ startMs: 5000, endMs: 8000 }],
      config,
      30,
    )
    // Should only have base volume + fade out (no volume with enable)
    const duckingFilters = filters.filter(f => f.includes('enable='))
    expect(duckingFilters).toHaveLength(0)
  })

  it('adds ducking filter for each voiceover segment', () => {
    const filters = buildDuckingFilters(
      [
        { startMs: 5000, endMs: 8000 },
        { startMs: 15000, endMs: 18000 },
      ],
      baseConfig,
      30,
    )
    const duckingFilters = filters.filter(f => f.includes('enable='))
    expect(duckingFilters).toHaveLength(2)
  })

  it('merges adjacent voiceover segments', () => {
    // Two segments 200ms apart, with duckFadeMs=500 → gap < 2*500=1000 → merge
    const filters = buildDuckingFilters(
      [
        { startMs: 5000, endMs: 8000 },
        { startMs: 8200, endMs: 11000 },
      ],
      baseConfig,
      30,
    )
    const duckingFilters = filters.filter(f => f.includes('enable='))
    expect(duckingFilters).toHaveLength(1)
  })

  it('skips fade-out when fadeOutMs is 0', () => {
    const config = { ...baseConfig, fadeOutMs: 0 }
    const filters = buildDuckingFilters([], config, 30)
    const fadeFilter = filters.find(f => f.startsWith('afade='))
    expect(fadeFilter).toBeUndefined()
  })

  it('clamps fade-out start to 0 for very short videos', () => {
    const filters = buildDuckingFilters([], baseConfig, 1)
    const fadeFilter = filters.find(f => f.startsWith('afade='))
    expect(fadeFilter).toContain('st=0.000')
  })
})
