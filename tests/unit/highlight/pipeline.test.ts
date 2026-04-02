import { describe, it, expect } from 'vitest'
import { Pipeline as Recast } from '../../../src/pipeline/pipeline'

describe('Pipeline textHighlight stage', () => {
  it('adds textHighlight stage to pipeline', () => {
    const pipeline = Recast.from('/tmp/test').parse().textHighlight()
    const stages = pipeline.getStages()
    expect(stages).toHaveLength(2)
    expect(stages[1]).toEqual({ type: 'textHighlight', config: {} })
  })

  it('accepts custom config', () => {
    const pipeline = Recast.from('/tmp/test').parse().textHighlight({
      color: '#FF0000',
      duration: 1500,
    })
    const stages = pipeline.getStages()
    const hlStage = stages[1] as { type: string; config: { color?: string; duration?: number } }
    expect(hlStage.config.color).toBe('#FF0000')
    expect(hlStage.config.duration).toBe(1500)
  })

  it('is immutable — does not modify original pipeline', () => {
    const base = Recast.from('/tmp/test').parse()
    const withHighlight = base.textHighlight()
    expect(base.getStages()).toHaveLength(1)
    expect(withHighlight.getStages()).toHaveLength(2)
  })
})
