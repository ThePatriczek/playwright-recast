import { describe, it, expect, beforeEach } from 'vitest'
import type { TestInfo } from '@playwright/test'
import {
  narrate,
  setupRecast,
  NARRATE_TITLE_PREFIX,
  NARRATE_HIDDEN_TITLE_PREFIX,
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

describe('narrate() — annotation contract (legacy report.json consumers)', () => {
  let env: ReturnType<typeof makeFakeTest>

  beforeEach(() => {
    env = makeFakeTest()
    setupRecast(env.fakeTest)
  })

  it('pushes voiceover + voiceover-hidden annotations even for undefined text', async () => {
    await narrate(undefined, { hidden: true })

    expect(env.info.annotations).toEqual([
      { type: 'voiceover', description: '' },
      { type: 'voiceover-hidden', description: '1' },
    ])
  })

  it('pushes annotations for empty string (hidden=false default)', async () => {
    await narrate('')

    expect(env.info.annotations).toEqual([
      { type: 'voiceover', description: '' },
      { type: 'voiceover-hidden', description: '0' },
    ])
  })

  it('pushes annotations for whitespace-only text and treats it as empty', async () => {
    await narrate('   \n\t  ')

    expect(env.info.annotations).toEqual([
      { type: 'voiceover', description: '' },
      { type: 'voiceover-hidden', description: '0' },
    ])
  })

  it('does NOT write a trace marker step for empty text', async () => {
    await narrate(undefined, { hidden: true })
    await narrate('')

    expect(env.steps).toEqual([])
  })

  it('preserves flat annotation order across mixed hidden/visible narrate calls', async () => {
    // This is the exact pattern that demo-report-writer flat-index mapping
    // depends on. Each narrate() must produce exactly two annotations in
    // order (voiceover, voiceover-hidden), regardless of text content.
    await narrate(undefined, { hidden: true }) // hidden login step
    await narrate(undefined, { hidden: true }) // hidden login step
    await narrate('Open the app', { hidden: true }) // hidden Given with text
    await narrate('Type a query') // visible When
    await narrate('Wait for result') // visible When

    const types = env.info.annotations.map((a) => a.type)
    expect(types).toEqual([
      'voiceover', 'voiceover-hidden',
      'voiceover', 'voiceover-hidden',
      'voiceover', 'voiceover-hidden',
      'voiceover', 'voiceover-hidden',
      'voiceover', 'voiceover-hidden',
    ])

    const descriptions = env.info.annotations.map((a) => a.description)
    expect(descriptions).toEqual([
      '', '1',
      '', '1',
      'Open the app', '1',
      'Type a query', '0',
      'Wait for result', '0',
    ])
  })
})

describe('narrate() — trace marker emission', () => {
  let env: ReturnType<typeof makeFakeTest>

  beforeEach(() => {
    env = makeFakeTest()
    setupRecast(env.fakeTest)
  })

  it('writes a marker-prefixed test.step when text is present', async () => {
    await narrate('Hello world')

    expect(env.steps).toHaveLength(1)
    expect(env.steps[0]!.title).toBe(`${NARRATE_TITLE_PREFIX}Hello world`)
    expect(env.steps[0]!.bodyRan).toBe(true)
  })

  it('uses the hidden prefix when opts.hidden is true', async () => {
    await narrate('Secret note', { hidden: true })

    expect(env.steps).toHaveLength(1)
    expect(env.steps[0]!.title).toBe(`${NARRATE_HIDDEN_TITLE_PREFIX}Secret note`)
  })

  it('detects @hidden in text and strips it from the marker', async () => {
    await narrate('Some text @hidden')

    expect(env.steps).toHaveLength(1)
    expect(env.steps[0]!.title).toBe(`${NARRATE_HIDDEN_TITLE_PREFIX}Some text`)
    expect(env.info.annotations).toEqual([
      { type: 'voiceover', description: 'Some text' },
      { type: 'voiceover-hidden', description: '1' },
    ])
  })
})

describe('narrate({ autoWait })', () => {
  let env: ReturnType<typeof makeFakeTest>

  beforeEach(() => {
    env = makeFakeTest()
    setupRecast(env.fakeTest)
  })

  it('does not wait when autoWait is omitted', async () => {
    const t0 = Date.now()
    await narrate('Hello world this is a longer line')
    expect(Date.now() - t0).toBeLessThan(50)
  })

  it('waits an explicit number of milliseconds', async () => {
    const t0 = Date.now()
    await narrate('hi', { autoWait: 120 })
    const elapsed = Date.now() - t0
    expect(elapsed).toBeGreaterThanOrEqual(110)
    expect(elapsed).toBeLessThan(400)
  })

  it('estimates wait time from character count when autoWait=true', async () => {
    // 28 non-whitespace chars / 14 cps = 2000 ms
    const text = 'abcdefghij abcdefghij abcdefgh'
    const t0 = Date.now()
    await narrate(text, { autoWait: { charactersPerSecond: 14, maxMs: 250 } })
    // capped by maxMs
    const elapsed = Date.now() - t0
    expect(elapsed).toBeGreaterThanOrEqual(240)
    expect(elapsed).toBeLessThan(500)
  })
})

describe('narrate({ autoWait }) — global default via setupRecast', () => {
  let env: ReturnType<typeof makeFakeTest>

  beforeEach(() => {
    env = makeFakeTest()
  })

  it('applies the global narrateAutoWait when no per-call autoWait is given', async () => {
    setupRecast(env.fakeTest, { narrateAutoWait: 120 })
    const t0 = Date.now()
    await narrate('hello')
    const elapsed = Date.now() - t0
    expect(elapsed).toBeGreaterThanOrEqual(110)
    expect(elapsed).toBeLessThan(400)
  })

  it('lets a per-call autoWait override the global default', async () => {
    setupRecast(env.fakeTest, { narrateAutoWait: 500 })
    const t0 = Date.now()
    await narrate('hello', { autoWait: 60 })
    const elapsed = Date.now() - t0
    expect(elapsed).toBeGreaterThanOrEqual(50)
    expect(elapsed).toBeLessThan(300)
  })

  it('lets a per-call autoWait:false disable the wait even with a global default', async () => {
    setupRecast(env.fakeTest, { narrateAutoWait: 500 })
    const t0 = Date.now()
    await narrate('hello', { autoWait: false })
    expect(Date.now() - t0).toBeLessThan(50)
  })

  it('does not wait when neither global nor per-call autoWait is set', async () => {
    setupRecast(env.fakeTest)
    const t0 = Date.now()
    await narrate('Hello world this is a longer line')
    expect(Date.now() - t0).toBeLessThan(50)
  })

  it('resets the global default to off when setupRecast is called without it', async () => {
    setupRecast(env.fakeTest, { narrateAutoWait: 500 })
    setupRecast(env.fakeTest) // re-setup without the option clears it
    const t0 = Date.now()
    await narrate('hello')
    expect(Date.now() - t0).toBeLessThan(50)
  })
})
