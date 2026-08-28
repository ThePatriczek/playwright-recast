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

  it('moves the first keyframe from the scaled initial offset', () => {
    const result = buildOverlayExpressions(
      [{ x: 100, y: 200, videoTimeSec: 5 }],
      defaultConfig,
      viewport,
      srcRes,
    )

    // 1.5x source scaling: target x=150, initial offset=60, start x=90.
    expect(result.x).toContain('90+(60)*')
    // Target y=300, start y=240.
    expect(result.y).toContain('240+(60)*')
  })

  it('moves later keyframes from the previous pointer position', () => {
    const result = buildOverlayExpressions(
      [
        { x: 100, y: 100, videoTimeSec: 2 },
        { x: 500, y: 400, videoTimeSec: 5 },
      ],
      defaultConfig,
      viewport,
      srcRes,
    )

    // Previous scaled x=150, target scaled x=750.
    expect(result.x).toContain('150+(600)*')
    // Previous scaled y=150, target scaled y=600.
    expect(result.y).toContain('150+(450)*')
  })

  it('honors a custom move duration and reaches the target at its timestamp', () => {
    const config = resolveCursorOverlayConfig({ moveDurationMs: 400 })
    const result = buildOverlayExpressions(
      [{ x: 100, y: 100, videoTimeSec: 5 }],
      config,
      viewport,
      srcRes,
    )

    expect(result.x).toContain('between(t\\,4.6000\\,5.0000)')
    expect(result.x).toContain('(t-4.6000)/0.4000')
  })

  it('clamps movement to the interval between closely spaced keyframes', () => {
    const result = buildOverlayExpressions(
      [
        { x: 100, y: 100, videoTimeSec: 2 },
        { x: 200, y: 200, videoTimeSec: 2.1 },
      ],
      defaultConfig,
      viewport,
      srcRes,
    )

    expect(result.x).toContain('between(t\\,2.0000\\,2.1000)')
    expect(result.x).toContain('(t-2.0000)/0.1000')
  })

  it('uses a 50ms safety floor for coincident keyframes', () => {
    const result = buildOverlayExpressions(
      [
        { x: 100, y: 100, videoTimeSec: 2 },
        { x: 200, y: 200, videoTimeSec: 2 },
      ],
      defaultConfig,
      viewport,
      srcRes,
    )

    expect(result.x).toContain('between(t\\,1.9500\\,2.0000)')
    expect(result.x).toContain('(t-1.9500)/0.0500')
  })

  it('uses a 50ms safety floor for non-positive configured durations', () => {
    const config = resolveCursorOverlayConfig({ moveDurationMs: 0 })
    const result = buildOverlayExpressions(
      [{ x: 100, y: 100, videoTimeSec: 5 }],
      config,
      viewport,
      srcRes,
    )

    expect(result.x).toContain('between(t\\,4.9500\\,5.0000)')
    expect(result.x).toContain('(t-4.9500)/0.0500')
  })

  it.each([
    ['linear', '*ld(0)'],
    ['ease-out', '*(1-(1-ld(0))*(1-ld(0)))'],
    ['ease-in-out', '*(3*ld(0)*ld(0)-2*ld(0)*ld(0)*ld(0))'],
  ] as const)('uses %s easing', (easing, expected) => {
    const config = resolveCursorOverlayConfig({ easing })
    const result = buildOverlayExpressions(
      [{ x: 500, y: 400, videoTimeSec: 3 }],
      config,
      viewport,
      srcRes,
    )

    expect(result.x).toContain(expected)
  })

  it('uses the configured post-arrival visibility time', () => {
    const config = resolveCursorOverlayConfig({ hideAfterMs: 750 })
    const result = buildOverlayExpressions(
      [{ x: 100, y: 100, videoTimeSec: 5 }],
      config,
      viewport,
      srcRes,
    )

    expect(result.x).toContain('between(t\\,4.7500\\,5.7500)')
  })

  it('clamps a negative post-arrival visibility time to zero', () => {
    const config = resolveCursorOverlayConfig({ hideAfterMs: -100 })
    const result = buildOverlayExpressions(
      [{ x: 100, y: 100, videoTimeSec: 5 }],
      config,
      viewport,
      srcRes,
    )

    expect(result.x).toContain('between(t\\,4.7500\\,5.0000)')
  })

  it('keeps the cursor at the target after a long auto-wait', () => {
    const result = buildOverlayExpressions(
      [{ x: 100, y: 100, videoTimeSec: 5, autoWaitSec: 2 }],
      defaultConfig,
      viewport,
      srcRes,
    )

    // The target only just painted, so do not glide over the loading screen.
    expect(result.x).toContain('150+(0)*')
    expect(result.x).toContain('between(t\\,4.8500\\,5.0000)')
  })

  it('gives later movements priority when visibility windows overlap', () => {
    const config = resolveCursorOverlayConfig({ moveDurationMs: 500, hideAfterMs: 500 })
    const result = buildOverlayExpressions(
      [
        { x: 100, y: 100, videoTimeSec: 2 },
        { x: 200, y: 200, videoTimeSec: 2.2 },
      ],
      config,
      viewport,
      srcRes,
    )

    // Both windows are present, and the expression bisects on the later
    // movement start, so t >= 2.0 resolves to the later keyframe.
    // expression-eval.test.ts checks the resulting positions with ffmpeg.
    expect(result.x).toContain('1.5000\\,2.5000')
    expect(result.x).toContain('2.0000\\,2.7000')
    expect(result.x.startsWith('if(lt(t\\,2.0000)\\,')).toBe(true)
  })
})

describe('buildEnableExpression', () => {
  it('returns 0 for empty keyframes', () => {
    expect(buildEnableExpression([], defaultConfig)).toBe('0')
  })

  it('uses configured movement and visibility timing', () => {
    const config = resolveCursorOverlayConfig({ moveDurationMs: 400, hideAfterMs: 750 })
    const result = buildEnableExpression(
      [{ x: 100, y: 100, videoTimeSec: 5 }],
      config,
    )

    expect(result).toBe('between(t\\,4.6000\\,5.7500)')
  })

  it('creates multiple windows for multiple keyframes', () => {
    const keyframes = [
      { x: 100, y: 100, videoTimeSec: 2 },
      { x: 500, y: 400, videoTimeSec: 8 },
    ]
    const result = buildEnableExpression(keyframes, defaultConfig)
    expect(result.split('+')).toHaveLength(2)
  })

  it('shortens the pre-click lead when the target appeared after a long wait', () => {
    const keyframes = [{ x: 100, y: 100, videoTimeSec: 5, autoWaitSec: 2 }]
    const result = buildEnableExpression(keyframes, defaultConfig)
    expect(result).toContain('4.8500')
    expect(result).not.toContain('4.7500')
  })

  it('matches the position expression visibility window', () => {
    const config = resolveCursorOverlayConfig({ moveDurationMs: 350, hideAfterMs: 600 })
    const keyframes = [{ x: 100, y: 100, videoTimeSec: 5 }]
    const position = buildOverlayExpressions(keyframes, config, viewport, srcRes)
    const enable = buildEnableExpression(keyframes, config)

    expect(enable).toBe('between(t\\,4.6500\\,5.6000)')
    expect(position.x).toContain(enable)
    expect(position.y).toContain(enable)
  })
})
