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
