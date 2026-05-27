import { describe, it, expect, beforeEach } from 'vitest'
import type { TestInfo } from '@playwright/test'
import {
  waitForNarration,
  setupRecast,
  WAIT_FOR_NARRATION_TITLE_PREFIX,
} from '../../../src/helpers'

type Annotation = { type: string; description?: string }
type StepRecord = { title: string; bodyRan: boolean }

function makeFakeTest(): {
  info: TestInfo
  steps: StepRecord[]
  fakeTest: { info: () => TestInfo; step: <T>(t: string, b: () => T | Promise<T>) => Promise<T> }
} {
  const annotations: Annotation[] = []
  const steps: StepRecord[] = []
  const info = { annotations } as unknown as TestInfo
  const fakeTest = {
    info: () => info,
    step: async <T,>(title: string, body: () => T | Promise<T>): Promise<T> => {
      const rec: StepRecord = { title, bodyRan: false }
      steps.push(rec)
      const result = await body()
      rec.bodyRan = true
      return result
    },
  }
  return { info, steps, fakeTest }
}

describe('waitForNarration()', () => {
  let env: ReturnType<typeof makeFakeTest>

  beforeEach(() => {
    env = makeFakeTest()
    setupRecast(env.fakeTest)
  })

  it('emits a single marker step with the wait-for-narration prefix', async () => {
    await waitForNarration()

    expect(env.steps).toHaveLength(1)
    expect(env.steps[0]!.title).toBe(WAIT_FOR_NARRATION_TITLE_PREFIX)
    expect(env.steps[0]!.bodyRan).toBe(true)
  })

  it('pushes no annotations (legacy report.json flat-index contract preserved)', async () => {
    await waitForNarration()

    expect(env.info.annotations).toEqual([])
  })

  it('resolves promptly — no real-time wait', async () => {
    const t0 = Date.now()
    await waitForNarration()
    expect(Date.now() - t0).toBeLessThan(50)
  })

  it('preserves trace marker order when interleaved with narrate() (sanity)', async () => {
    const { narrate } = await import('../../../src/helpers')
    await narrate('first')
    await waitForNarration()
    await narrate('second')

    expect(env.steps.map((s) => s.title)).toEqual([
      '__recast_narrate__: first',
      WAIT_FOR_NARRATION_TITLE_PREFIX,
      '__recast_narrate__: second',
    ])
  })
})
