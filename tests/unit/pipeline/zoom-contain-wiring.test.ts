import { describe, it, expect } from 'vitest'
import { Recast } from '../../../src/index'

describe('autoZoom({ containInCue }) plumbing', () => {
  it('records the flag on the zoom stage config', () => {
    const stages = Recast.from('./trace.zip').parse().autoZoom({ containInCue: true }).getStages()
    const zoomStage = stages.find((s) => s.type === 'autoZoom')
    expect(zoomStage).toBeDefined()
    expect((zoomStage as { config: { containInCue?: boolean } }).config.containInCue).toBe(true)
  })

  it('defaults to undefined when not supplied', () => {
    const stages = Recast.from('./trace.zip').parse().autoZoom({}).getStages()
    const zoomStage = stages.find((s) => s.type === 'autoZoom')
    expect((zoomStage as { config: { containInCue?: boolean } }).config.containInCue).toBeUndefined()
  })
})
