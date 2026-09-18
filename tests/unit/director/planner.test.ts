import { describe, expect, it, vi } from 'vitest'
import { Recast } from '../../../src/index.js'
import { planDirection } from '../../../src/director/planner.js'
import type { DirectorProvider, DirectorRequest, VisualObservation } from '../../../src/types/director.js'

function choose(request: DirectorRequest, camera: string, confidence = 0.99) {
  return { model: 'test', elapsedMs: 0, answers: Object.fromEntries(Object.entries(request.questions).map(([name, question]) => {
    const choice = name === 'camera' ? camera : 'normal'
    return [name, { choice, confidence, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === choice ? 1 : 0])) }]
  })) }
}
const errorRegion = { id: 'error', x: 0.8, y: 0.3, width: 0.18, height: 0.15, text: 'Report generation failed', kind: 'text' as const, changed: true }
const observations: VisualObservation[] = [
  { atMs: 0, regions: [], changeFraction: 0 },
  { atMs: 1000, regions: [errorRegion], changeFraction: 0.15 },
  { atMs: 1500, regions: [{ ...errorRegion, changed: false }], changeFraction: 0 },
  { atMs: 2000, regions: [{ ...errorRegion, changed: false }], changeFraction: 0 },
]

describe('visual direction', () => {
  it('reveals a newly observed result without any manual zoom or highlight markers', async () => {
    const provider: DirectorProvider = { name: 'test', async decide(request) {
      const key = Object.keys(request.questions.camera.criteria).find(key => key.startsWith('reveal_')) ?? 'stay'
      return choose(request, key)
    } }
    const plan = await planDirection(provider, { goal: 'Show the report result' }, observations, 3000, false)
    expect(plan.decisions.map(item => item.action)).toContain('reveal')
    const reveal = plan.decisions.find(item => item.action === 'reveal')!
    expect(reveal.sourceStartMs).toBe(1000)
    expect(reveal.targetIds).toEqual(['error'])
    expect(reveal.to.x).toBeGreaterThan(0.5)
    expect(plan.keyframes.at(-1)?.zoom).toBeCloseTo(1.35)
  })

  it('replaces uncertain motion with STAY and preserves voiceover timing', async () => {
    const requests: DirectorRequest[] = []
    const provider: DirectorProvider = { name: 'test', async decide(request) {
      requests.push(request)
      return choose(request, Object.keys(request.questions.camera.criteria).find(key => key.startsWith('focus_')) ?? 'stay', 0.2)
    } }
    const plan = await planDirection(provider, { goal: 'Show the report result' }, observations, 3000, true)
    expect(plan.decisions.every(item => item.action === 'stay' && item.tempo === 'normal')).toBe(true)
    expect(requests.every(request => Object.keys(request.questions.tempo.criteria).join() === 'normal')).toBe(true)
    expect(plan.outputDurationMs).toBe(3000)
  })

  it('follows moving text across 500ms decision boundaries without static emphasis', async () => {
    const moving: VisualObservation[] = Array.from({ length: 8 }, (_, index) => ({
      atMs: index * 500,
      changeFraction: 0.01,
      regions: [{ ...errorRegion, id: 'moving', x: 0.1 + index * 0.05, changed: index > 0 }],
    }))
    const provider: DirectorProvider = { name: 'test', async decide(request) {
      const follow = Object.keys(request.questions.camera.criteria).find(key => key.startsWith('follow_'))
      return choose(request, follow ?? 'stay')
    } }
    const plan = await planDirection(provider, { goal: 'Follow the moving result' }, moving, 4000, true)

    expect(plan.decisions).toHaveLength(8)
    for (const request of plan.requests.slice(0, -1)) {
      const choices = Object.keys(request.questions.camera.criteria)
      expect(choices).toContain('follow_0')
      expect(choices.some(key => key.startsWith('spotlight_') || key.startsWith('pulse_'))).toBe(false)
    }
    expect(plan.decisions[0].action).toBe('follow')
    expect(plan.requests[0].state.after).toEqual(moving[1])
    expect(plan.decisions[0].to.zoom).toBeGreaterThan(1)
    expect(plan.keyframes.some(point => point.atMs === 500 && point.zoom > 1)).toBe(true)
  })

  it('does not promote boundary-only results into earlier camera or tempo choices', async () => {
    const appearing: VisualObservation[] = [
      { atMs: 0, regions: [], changeFraction: 0 },
      { atMs: 500, regions: [errorRegion], changeFraction: 0.15 },
      { atMs: 1000, regions: [{ ...errorRegion, changed: false }], changeFraction: 0 },
    ]
    const provider: DirectorProvider = { name: 'test', decide: async request => choose(request, 'stay') }
    const plan = await planDirection(provider, { goal: 'Show the result when it appears' }, appearing, 1500, false)

    expect(plan.decisions[0].sourceEndMs).toBe(500)
    expect(Object.keys(plan.requests[0].questions.camera.criteria)).toEqual(['stay'])
    expect(Object.keys(plan.requests[0].questions.tempo.criteria)).toEqual(['normal', 'fast'])
    expect(plan.requests[0].state.observations).toEqual([appearing[0]])
    expect(plan.requests[1].questions.camera.criteria).toHaveProperty('reveal_0')
  })

  it('does not follow a lost target through the next boundary to a later reappearance', async () => {
    const tracked: VisualObservation[] = [
      { atMs: 0, regions: [{ ...errorRegion, x: 0.1, changed: false }], changeFraction: 0 },
      { atMs: 500, regions: [{ ...errorRegion, x: 0.2 }], changeFraction: 0.15 },
      { atMs: 1000, regions: [], changeFraction: 0.15 },
      { atMs: 1500, regions: [{ ...errorRegion, x: 0.8 }], changeFraction: 0.15 },
    ]
    const provider: DirectorProvider = { name: 'test', decide: async request => choose(request, 'stay') }
    const plan = await planDirection(provider, { goal: 'Follow only visible results' }, tracked, 2000, true)

    expect(plan.requests[0].questions.camera.criteria).toHaveProperty('follow_0')
    expect(plan.requests[1].questions.camera.criteria).not.toHaveProperty('follow_0')
    expect(Object.keys(plan.requests[2].questions.camera.criteria)).toEqual(['stay'])
  })

  it('checks the decision budget before making any paid requests', async () => {
    const decide = vi.fn()
    await expect(planDirection({ name: 'test', decide }, { goal: 'Show result', maxDecisions: 1 }, observations, 3000, false)).rejects.toThrow('budget exceeded')
    expect(decide).not.toHaveBeenCalled()
  })

  it('adds an immutable stage and rejects competing camera controllers before reading files', async () => {
    const provider: DirectorProvider = { name: 'test', decide: async request => choose(request, 'stay') }
    const base = Recast.from('missing.zip').parse()
    const directed = base.direct(provider, { goal: 'Show result' })
    expect(base.getStages()).toHaveLength(1)
    expect(directed.getStages().map(stage => stage.type)).toEqual(['parse', 'direct'])
    await expect(directed.autoZoom().toFile('/tmp/unused-director.mp4')).rejects.toThrow('owns the camera')
    await expect(directed.direct(provider, { goal: 'Duplicate' }).toFile('/tmp/unused-director.mp4')).rejects.toThrow('Only one')
  })
})
