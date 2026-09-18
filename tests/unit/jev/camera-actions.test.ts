import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { actionCandidates, buildEffectGraph, frameTargets, planAction, stabilizeAction } from '../../../demo/jev/camera-actions.js'
import { focusInShot, overview, poseAt, validatePath } from '../../../demo/jev/camera-rig.js'

const left = { x: 0.1, y: 0.4, width: 0.1, height: 0.1, label: 'Input' }
const right = { x: 0.85, y: 0.4, width: 0.1, height: 0.1, label: 'Result' }
const context = { focus: left, related: [left, right], result: right }

describe('semantic camera actions', () => {
  it('fits both distant subjects and keeps small edge targets inside the image', () => {
    const fit = frameTargets([left, right])
    expect(focusInShot(fit, left).visibleFraction).toBeCloseTo(1)
    expect(focusInShot(fit, right).visibleFraction).toBeCloseTo(1)
    const focus = planAction('focus', overview, context, 0, 3000)
    validatePath(focus.keyframes)
    expect(focus.keyframes.at(-1)?.zoom).toBeCloseTo(1.45)
    expect(focusInShot(focus.keyframes.at(-1)!, left).visibleFraction).toBeCloseTo(1)
    expect(poseAt(focus.keyframes, 2000)).toMatchObject(poseAt(focus.keyframes, 3000))
  })

  it('reveals the observed result instead of the clicked control', () => {
    const plan = planAction('reveal', overview, context, 0, 3000)
    expect(plan.targets).toEqual([right])
    expect(plan.keyframes.at(-1)?.x).toBeGreaterThan(0.5)
    expect(planAction('reveal', overview, { related: [], focus: left }, 0, 3000).action).toBe('stay')
  })

  it('does not offer tracking without measured positions or effects outside the crop', () => {
    const candidates = actionCandidates(frameTargets([left]), { ...context, focus: right }, 0, 3000)
    expect(candidates.follow).toBeUndefined()
    expect(candidates.spotlight).toBeUndefined()
    expect(candidates.pulse).toBeUndefined()
    expect(candidates.stay).toBeDefined()
  })

  it('follows measured positions and stops when the target disappears', () => {
    const track = [
      { atMs: 0, region: left },
      { atMs: 500, region: { ...left, x: 0.4 } },
      { atMs: 1000, region: right },
      { atMs: 1500, region: null },
      { atMs: 2000, region: left },
    ]
    const plan = planAction('follow', frameTargets([left]), { ...context, track }, 0, 3000)
    validatePath(plan.keyframes)
    expect(poseAt(plan.keyframes, 1000).x).toBeGreaterThan(poseAt(plan.keyframes, 0).x)
    expect(poseAt(plan.keyframes, 2500)).toMatchObject(poseAt(plan.keyframes, 1000))
    expect(plan.reason).toBe('target-lost-hold-last-position')
  })

  it('leaves the pose untouched for stay and both emphasis effects', () => {
    for (const action of ['stay', 'spotlight', 'pulse'] as const) {
      const plan = planAction(action, overview, context, 0, 3000)
      expect(plan.action).toBe(action)
      expect(plan.keyframes.map(({ x, y, zoom }) => ({ x, y, zoom }))).toEqual([overview, overview])
    }
    expect(planAction('overview', frameTargets([left]), context, 0, 3000).keyframes.at(-1)).toMatchObject(overview)
  })

  it('keeps uncertain actions and repeated emphasis from disturbing a settled shot', () => {
    const candidates = actionCandidates(overview, context, 3000, 6000)
    expect(stabilizeAction({ choice: 'focus', confidence: 0.4, probabilities: { focus: 0.6, stay: 0.4 } }, candidates, overview, 3000, -10000, -10000).action).toBe('stay')
    expect(stabilizeAction({ choice: 'spotlight', confidence: 0.99, probabilities: { spotlight: 0.99, stay: 0.01 } }, candidates, overview, 3000, -10000, 2500)).toEqual({ action: 'stay', reason: 'effect-cooldown' })
  })

  it('burns spotlight and pulse into frames without altering their target or timing', () => {
    const target = { x: 0.4, y: 0.3, width: 0.2, height: 0.4, label: 'Subject' }
    const render = (kind: 'spotlight' | 'pulse') => {
      const effect = buildEffectGraph([{ kind, atMs: 500, endMs: 1500, target }], 160, 90)
      return execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=160x90:r=10:d=2', '-filter_complex', effect.graph, '-map', `[${effect.output}]`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'])
    }
    const spot = render('spotlight')
    const pixel = (frame: Buffer, time: number, x: number, y: number) => frame[(time * 160 * 90 + y * 160 + x) * 3]
    expect(pixel(spot, 0, 5, 5)).toBeGreaterThan(240)
    expect(pixel(spot, 10, 5, 5)).toBeLessThan(130)
    expect(pixel(spot, 10, 80, 45)).toBeGreaterThan(240)
    expect(pixel(spot, 19, 5, 5)).toBeGreaterThan(240)
    const pulse = render('pulse')
    expect(pixel(pulse, 0, 54, 45)).toBeGreaterThan(240)
    expect(pixel(pulse, 8, 54, 45)).toBeLessThan(230)
    expect(pixel(pulse, 8, 80, 45)).toBeGreaterThan(240)
    expect(pixel(pulse, 19, 54, 45)).toBeGreaterThan(240)
  })
})
