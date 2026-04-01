import { describe, it, expect } from 'vitest'
import { buildOverlayExpressions, buildEnableExpression } from '../../../src/cursor-overlay/expression-builder'
import { resolveCursorOverlayConfig } from '../../../src/cursor-overlay/defaults'

const defaultConfig = resolveCursorOverlayConfig({})

const viewport = { width: 1280, height: 720 }
const srcRes = { width: 1920, height: 1080 }

describe('buildOverlayExpressions', () => {
  it('returns 0,0 for empty keyframes', () => {
    const result = buildOverlayExpressions([], defaultConfig, viewport, srcRes)
    expect(result.x).toBe('0')
    expect(result.y).toBe('0')
  })

  it('builds per-click segments for single keyframe', () => {
    const keyframes = [{ x: 640, y: 360, videoTimeSec: 5.0 }]
    const result = buildOverlayExpressions(keyframes, defaultConfig, viewport, srcRes)
    expect(result.x).toContain('between(t')
    expect(result.y).toContain('between(t')
  })

  it('builds per-click segments for multiple keyframes', () => {
    const keyframes = [
      { x: 100, y: 100, videoTimeSec: 2.0 },
      { x: 500, y: 400, videoTimeSec: 5.0 },
    ]
    const result = buildOverlayExpressions(keyframes, defaultConfig, viewport, srcRes)
    // Two click windows = two between() blocks
    const betweenCount = (result.x.match(/between\(t/g) || []).length
    expect(betweenCount).toBeGreaterThanOrEqual(2)
  })

  it('uses ease-out (st/ld pattern) for movement', () => {
    const keyframes = [{ x: 500, y: 400, videoTimeSec: 3.0 }]
    const result = buildOverlayExpressions(keyframes, defaultConfig, viewport, srcRes)
    expect(result.x).toContain('st(0')
    expect(result.x).toContain('ld(0)')
  })
})

describe('buildEnableExpression', () => {
  it('returns 0 for empty keyframes', () => {
    expect(buildEnableExpression([])).toBe('0')
  })

  it('creates visibility window for single click', () => {
    const keyframes = [{ x: 100, y: 100, videoTimeSec: 5.0 }]
    const result = buildEnableExpression(keyframes)
    expect(result).toContain('between(t')
    // Window should start before 5.0 and end after 5.0
    expect(result).toContain('4.5')
    expect(result).toContain('5.2')
  })

  it('creates multiple windows for multiple clicks', () => {
    const keyframes = [
      { x: 100, y: 100, videoTimeSec: 2.0 },
      { x: 500, y: 400, videoTimeSec: 8.0 },
    ]
    const result = buildEnableExpression(keyframes)
    const windows = result.split('+')
    expect(windows).toHaveLength(2)
  })
})
