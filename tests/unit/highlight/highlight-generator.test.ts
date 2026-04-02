import { describe, it, expect } from 'vitest'
import { buildHighlightArgs } from '../../../src/text-highlight/highlight-generator'

describe('buildHighlightArgs', () => {
  it('produces valid ffmpeg args', () => {
    const args = buildHighlightArgs({
      color: '#FFEB3B',
      opacity: 0.35,
      width: 200,
      height: 30,
      swipeDuration: 300,
      duration: 2000,
      fadeOut: 0,
      outputPath: '/tmp/highlight.mov',
    })

    expect(args).toContain('-f')
    expect(args).toContain('lavfi')
    expect(args.some(a => a.includes('geq'))).toBe(true)
    expect(args.some(a => a.includes('format=rgba'))).toBe(true)
    expect(args).toContain('/tmp/highlight.mov')
  })

  it('embeds correct color components in geq', () => {
    const args = buildHighlightArgs({
      color: '#FF8800',
      opacity: 0.5,
      width: 100,
      height: 20,
      swipeDuration: 300,
      duration: 2000,
      fadeOut: 0,
      outputPath: '/tmp/highlight.mov',
    })
    const vf = args.find(a => a.includes('geq'))!
    expect(vf).toContain('r=255')
    expect(vf).toContain('g=136')
    expect(vf).toContain('b=0')
  })

  it('uses even dimensions', () => {
    const args = buildHighlightArgs({
      color: '#FFEB3B',
      opacity: 0.35,
      width: 201,
      height: 31,
      swipeDuration: 300,
      duration: 2000,
      fadeOut: 0,
      outputPath: '/tmp/highlight.mov',
    })
    const lavfi = args.find(a => a.includes('color='))!
    const match = lavfi.match(/s=(\d+)x(\d+)/)
    expect(Number(match![1]) % 2).toBe(0)
    expect(Number(match![2]) % 2).toBe(0)
  })

  it('includes swipe animation via geq alpha expression', () => {
    const args = buildHighlightArgs({
      color: '#FFEB3B',
      opacity: 0.35,
      width: 200,
      height: 30,
      swipeDuration: 300,
      duration: 2000,
      fadeOut: 0,
      outputPath: '/tmp/highlight.mov',
    })
    const lavfi = args.find(a => a.includes('geq'))!
    // Should contain time-based alpha for swipe: if(lte(X,...))
    expect(lavfi).toContain('lte(X')
    expect(lavfi).toContain('min(1')
  })

  it('includes fade filter when fadeOut > 0', () => {
    const args = buildHighlightArgs({
      color: '#FFEB3B',
      opacity: 0.35,
      width: 200,
      height: 30,
      swipeDuration: 300,
      duration: 2000,
      fadeOut: 500,
      outputPath: '/tmp/highlight.mov',
    })
    const lavfi = args.find(a => a.includes('fade='))
    expect(lavfi).toBeDefined()
  })

  it('calculates total duration from duration + fadeOut', () => {
    const args = buildHighlightArgs({
      color: '#FFEB3B',
      opacity: 0.35,
      width: 200,
      height: 30,
      swipeDuration: 300,
      duration: 2000,
      fadeOut: 500,
      outputPath: '/tmp/highlight.mov',
    })
    const lavfi = args.find(a => a.includes('color='))!
    // Total = 2000 + 500 = 2500ms = 2.500s
    expect(lavfi).toContain('d=2.500')
  })
})
