import { describe, it, expect } from 'vitest'
import { Recast } from '../../../src/index'

describe('Pipeline (fluent chain)', () => {
  it('creates a pipeline from a source path', () => {
    const pipeline = Recast.from('./trace.zip')
    expect(pipeline.getSource()).toBe('./trace.zip')
    expect(pipeline.getStages()).toEqual([])
  })

  it('is immutable — each method returns a new pipeline', () => {
    const p1 = Recast.from('./trace.zip')
    const p2 = p1.parse()
    const p3 = p2.hideSteps(() => false)

    expect(p1.getStages()).toHaveLength(0)
    expect(p2.getStages()).toHaveLength(1)
    expect(p3.getStages()).toHaveLength(2)
  })

  it('accumulates stages in order', () => {
    const pipeline = Recast.from('./trace.zip')
      .parse()
      .hideSteps((s) => s.keyword === 'Given')
      .speedUp({ duringIdle: 4.0, duringUserAction: 1.0 })
      .subtitles((s) => s.docString ?? s.text)
      .render({ format: 'mp4' })

    const stages = pipeline.getStages()
    expect(stages).toHaveLength(5)
    expect(stages.map((s) => s.type)).toEqual([
      'parse',
      'hideSteps',
      'speedUp',
      'subtitles',
      'render',
    ])
  })

  it('preserves stage config in speedUp', () => {
    const config = { duringIdle: 3.0, duringUserAction: 1.0, minSegmentDuration: 200 }
    const pipeline = Recast.from('./trace.zip').parse().speedUp(config)

    const speedStage = pipeline.getStages().find((s) => s.type === 'speedUp')
    expect(speedStage).toBeDefined()
    if (speedStage?.type === 'speedUp') {
      expect(speedStage.config).toEqual(config)
    }
  })

  it('preserves stage config in render', () => {
    const pipeline = Recast.from('./trace.zip')
      .parse()
      .render({ format: 'webm', resolution: '720p', burnSubtitles: true })

    const renderStage = pipeline.getStages().find((s) => s.type === 'render')
    expect(renderStage).toBeDefined()
    if (renderStage?.type === 'render') {
      expect(renderStage.config.format).toBe('webm')
      expect(renderStage.config.resolution).toBe('720p')
      expect(renderStage.config.burnSubtitles).toBe(true)
    }
  })

  it('preserves predicate function in hideSteps', () => {
    const predicate = (s: { keyword?: string }) => s.keyword === 'Given'
    const pipeline = Recast.from('./trace.zip').parse().hideSteps(predicate)

    const hideStage = pipeline.getStages().find((s) => s.type === 'hideSteps')
    expect(hideStage).toBeDefined()
    if (hideStage?.type === 'hideSteps') {
      expect(hideStage.predicate({ keyword: 'Given' } as any)).toBe(true)
      expect(hideStage.predicate({ keyword: 'When' } as any)).toBe(false)
    }
  })

  it('preserves textFn in subtitles', () => {
    const textFn = (s: { docString?: string; text?: string }) =>
      s.docString ?? s.text
    const pipeline = Recast.from('./trace.zip')
      .parse()
      .subtitles(textFn, { format: 'vtt' })

    const subStage = pipeline.getStages().find((s) => s.type === 'subtitles')
    expect(subStage).toBeDefined()
    if (subStage?.type === 'subtitles') {
      expect(subStage.textFn({ docString: 'hello' } as any)).toBe('hello')
      expect(subStage.textFn({ text: 'fallback' } as any)).toBe('fallback')
      expect(subStage.options?.format).toBe('vtt')
    }
  })

  it('preserves voiceover provider', () => {
    const mockProvider = {
      name: 'mock',
      synthesize: async () => ({ data: Buffer.from(''), durationMs: 0, format: { sampleRate: 24000, channels: 1, codec: 'mp3' } }),
      estimateDurationMs: () => 1000,
      isAvailable: async () => true,
      dispose: async () => {},
    }
    const pipeline = Recast.from('./trace.zip')
      .parse()
      .subtitles((s) => s.text)
      .voiceover(mockProvider)

    const voStage = pipeline.getStages().find((s) => s.type === 'voiceover')
    expect(voStage).toBeDefined()
    if (voStage?.type === 'voiceover') {
      expect(voStage.provider.name).toBe('mock')
    }
  })

  it('supports minimal pipeline (just parse + render)', () => {
    const pipeline = Recast.from('./trace.zip').parse().render()
    expect(pipeline.getStages()).toHaveLength(2)
  })

  it('supports render with default config', () => {
    const pipeline = Recast.from('./trace.zip').parse().render()
    const renderStage = pipeline.getStages().find((s) => s.type === 'render')
    if (renderStage?.type === 'render') {
      expect(renderStage.config).toEqual({})
    }
  })

  it('adds textProcessing stage with config', () => {
    const config = { builtins: true, rules: [{ pattern: 'a', replacement: 'b' }] }
    const pipeline = Recast.from('./trace.zip')
      .parse()
      .subtitles((s) => s.text)
      .textProcessing(config)

    const stages = pipeline.getStages()
    expect(stages).toHaveLength(3)
    expect(stages[2]!.type).toBe('textProcessing')
  })

  it('preserves textProcessing config', () => {
    const config = { builtins: true }
    const pipeline = Recast.from('./trace.zip')
      .parse()
      .subtitles((s) => s.text)
      .textProcessing(config)

    const stage = pipeline.getStages().find((s) => s.type === 'textProcessing')
    expect(stage).toBeDefined()
    if (stage?.type === 'textProcessing') {
      expect(stage.config).toEqual(config)
    }
  })

  it('accumulates textProcessing in correct pipeline position', () => {
    const pipeline = Recast.from('./trace.zip')
      .parse()
      .speedUp({ duringIdle: 4.0 })
      .subtitles((s) => s.text)
      .textProcessing({ builtins: true })
      .render()

    expect(pipeline.getStages().map((s) => s.type)).toEqual([
      'parse',
      'speedUp',
      'subtitles',
      'textProcessing',
      'render',
    ])
  })
})
