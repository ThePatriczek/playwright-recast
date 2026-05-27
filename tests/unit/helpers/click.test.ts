import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { TestInfo, Locator } from '@playwright/test'
import { markClick, click, setupRecast, CLICK_TITLE_PREFIX } from '../../../src/helpers'

type Annotation = { type: string; description?: string }
type StepRecord = { title: string }

function makeEnv() {
  const annotations: Annotation[] = []
  const steps: StepRecord[] = []
  const calls: string[] = []
  const info = { annotations } as unknown as TestInfo
  const fakeTest = {
    info: () => info,
    step: async <T,>(title: string, body: () => T | Promise<T>): Promise<T> => {
      calls.push(`step:${title}`)
      steps.push({ title })
      return body()
    },
  }
  return { info, steps, calls, fakeTest }
}

function makeLocator(
  box: { x: number; y: number; width: number; height: number } | null,
  calls: string[],
  sink: { clickOptions?: unknown },
): Locator {
  return {
    async boundingBox() { calls.push('boundingBox'); return box },
    async waitFor(opts: { state?: string }) { calls.push(`waitFor:${opts?.state}`) },
    async click(options?: unknown) { calls.push('click'); sink.clickOptions = options },
  } as unknown as Locator
}

describe('markClick()', () => {
  let env: ReturnType<typeof makeEnv>
  beforeEach(() => { env = makeEnv(); setupRecast(env.fakeTest) })

  it('writes one marker step with the element center as JSON', async () => {
    const sink: { clickOptions?: unknown } = {}
    const loc = makeLocator({ x: 100, y: 200, width: 40, height: 20 }, env.calls, sink)
    await markClick(loc)
    expect(env.steps).toHaveLength(1)
    expect(env.steps[0]!.title).toBe(`${CLICK_TITLE_PREFIX}${JSON.stringify({ x: 120, y: 210 })}`)
  })

  it('pushes no annotations', async () => {
    const sink: { clickOptions?: unknown } = {}
    const loc = makeLocator({ x: 0, y: 0, width: 10, height: 10 }, env.calls, sink)
    await markClick(loc)
    expect(env.info.annotations).toEqual([])
  })

  it('no-ops when boundingBox() is null', async () => {
    const sink: { clickOptions?: unknown } = {}
    const loc = makeLocator(null, env.calls, sink)
    await markClick(loc)
    expect(env.steps).toEqual([])
  })
})

describe('click()', () => {
  let env: ReturnType<typeof makeEnv>
  beforeEach(() => { env = makeEnv() })

  it('waits visible, settles, marks, then clicks — forwarding options', async () => {
    setupRecast(env.fakeTest, { clickSettleMs: 20 })
    const sink: { clickOptions?: unknown } = {}
    const loc = makeLocator({ x: 10, y: 10, width: 20, height: 20 }, env.calls, sink)
    const t0 = Date.now()
    await click(loc, { button: 'left', force: true })
    const elapsed = Date.now() - t0
    expect(env.calls).toEqual([
      'waitFor:visible',
      'boundingBox',
      `step:${CLICK_TITLE_PREFIX}${JSON.stringify({ x: 20, y: 20 })}`,
      'click',
    ])
    expect(sink.clickOptions).toEqual({ button: 'left', force: true })
    expect(elapsed).toBeGreaterThanOrEqual(15)
    expect(elapsed).toBeLessThan(300)
  })

  it('skips the settle wait when clickSettleMs is 0', async () => {
    setupRecast(env.fakeTest, { clickSettleMs: 0 })
    const sink: { clickOptions?: unknown } = {}
    const loc = makeLocator({ x: 0, y: 0, width: 10, height: 10 }, env.calls, sink)
    const t0 = Date.now()
    await click(loc)
    expect(Date.now() - t0).toBeLessThan(50)
    expect(env.calls).toContain('click')
  })
})

describe('click helpers without setupRecast()', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('markClick no-ops before reading the locator box when setupRecast was not called', async () => {
    const { markClick } = await import('../../../src/helpers')
    const calls: string[] = []
    const sink: { clickOptions?: unknown } = {}
    const loc = makeLocator({ x: 10, y: 20, width: 30, height: 40 }, calls, sink)

    await markClick(loc)

    expect(calls).toEqual([])
  })

  it('click falls back to the real locator click without settle or marker work', async () => {
    const { click } = await import('../../../src/helpers')
    const calls: string[] = []
    const sink: { clickOptions?: unknown } = {}
    const loc = makeLocator({ x: 10, y: 20, width: 30, height: 40 }, calls, sink)
    const t0 = Date.now()

    await click(loc, { force: true })

    expect(Date.now() - t0).toBeLessThan(50)
    expect(calls).toEqual(['click'])
    expect(sink.clickOptions).toEqual({ force: true })
  })
})
