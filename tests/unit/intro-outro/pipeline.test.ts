import { describe, it, expect } from 'vitest'
import { Pipeline as Recast } from '../../../src/pipeline/pipeline'

describe('Pipeline intro/outro stages', () => {
  it('adds intro stage to pipeline', () => {
    const pipeline = Recast.from('/tmp/test').parse().intro({ path: '/tmp/intro.mov' })
    const stages = pipeline.getStages()
    expect(stages).toHaveLength(2)
    expect(stages[1]).toEqual({ type: 'intro', config: { path: '/tmp/intro.mov' } })
  })

  it('adds outro stage to pipeline', () => {
    const pipeline = Recast.from('/tmp/test').parse().outro({ path: '/tmp/outro.mov' })
    const stages = pipeline.getStages()
    expect(stages).toHaveLength(2)
    expect(stages[1]).toEqual({ type: 'outro', config: { path: '/tmp/outro.mov' } })
  })

  it('preserves fadeDuration in intro config', () => {
    const pipeline = Recast.from('/tmp/test').parse().intro({ path: '/tmp/intro.mov', fadeDuration: 800 })
    const stage = pipeline.getStages().find(s => s.type === 'intro')
    expect(stage).toBeDefined()
    if (stage?.type === 'intro') {
      expect(stage.config.fadeDuration).toBe(800)
    }
  })

  it('preserves fadeDuration in outro config', () => {
    const pipeline = Recast.from('/tmp/test').parse().outro({ path: '/tmp/outro.mov', fadeDuration: 300 })
    const stage = pipeline.getStages().find(s => s.type === 'outro')
    expect(stage).toBeDefined()
    if (stage?.type === 'outro') {
      expect(stage.config.fadeDuration).toBe(300)
    }
  })

  it('supports both intro and outro in same pipeline', () => {
    const pipeline = Recast.from('/tmp/test')
      .parse()
      .intro({ path: '/tmp/intro.mov' })
      .outro({ path: '/tmp/outro.mov' })
      .render()

    const stages = pipeline.getStages()
    expect(stages.map(s => s.type)).toEqual(['parse', 'intro', 'outro', 'render'])
  })

  it('is immutable — does not modify original pipeline', () => {
    const base = Recast.from('/tmp/test').parse()
    const withIntro = base.intro({ path: '/tmp/intro.mov' })
    const withOutro = base.outro({ path: '/tmp/outro.mov' })

    expect(base.getStages()).toHaveLength(1)
    expect(withIntro.getStages()).toHaveLength(2)
    expect(withOutro.getStages()).toHaveLength(2)
  })

  it('fadeDuration is optional (defaults applied at execution time)', () => {
    const pipeline = Recast.from('/tmp/test').parse().intro({ path: '/tmp/intro.mov' })
    const stage = pipeline.getStages().find(s => s.type === 'intro')
    if (stage?.type === 'intro') {
      expect(stage.config.fadeDuration).toBeUndefined()
    }
  })
})
