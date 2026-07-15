import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Locator, TestInfo } from '@playwright/test'
import { setupRecast, typeText } from '../../../src/helpers'

type Call =
  | { method: 'fill'; value: string }
  | { method: 'pressSequentially'; character: string; delay: number }

function makeFakeTest() {
  const info = { annotations: [] } as unknown as TestInfo
  return {
    info: () => info,
    step: async <T,>(_title: string, body: () => T | Promise<T>): Promise<T> => body(),
  }
}

function makeLocator(
  calls: Call[],
  options?: { fillError?: Error; pressErrorAt?: number },
): Locator {
  let pressCount = 0
  return {
    async fill(value: string) {
      calls.push({ method: 'fill', value })
      if (options?.fillError) throw options.fillError
    },
    async pressSequentially(character: string, pressOptions?: { delay?: number }) {
      calls.push({
        method: 'pressSequentially',
        character,
        delay: pressOptions?.delay ?? 0,
      })
      if (pressCount === options?.pressErrorAt) {
        throw new Error('typing failed')
      }
      pressCount += 1
    },
  } as unknown as Locator
}

describe('typeText()', () => {
  beforeEach(() => {
    setupRecast(makeFakeTest())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('clears first and types one action per Unicode code point in order', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const calls: Call[] = []

    await typeText(makeLocator(calls), 'A😀B')

    expect(calls).toEqual([
      { method: 'fill', value: '' },
      { method: 'pressSequentially', character: 'A', delay: 100 },
      { method: 'pressSequentially', character: '😀', delay: 100 },
      { method: 'pressSequentially', character: 'B', delay: 100 },
    ])
  })

  it('varies the built-in 100ms average within the 65-135ms bounds', async () => {
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(1)
    const calls: Call[] = []

    await typeText(makeLocator(calls), 'abc')

    const delays = calls
      .filter((call): call is Extract<Call, { method: 'pressSequentially' }> =>
        call.method === 'pressSequentially')
      .map((call) => call.delay)
    expect(delays).toEqual([65, 100, 135])
    expect(delays.every((delay) => delay >= 65 && delay <= 135)).toBe(true)
  })

  it('uses the suite-wide typingDelayMs default', async () => {
    setupRecast(makeFakeTest(), { typingDelayMs: 200 })
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const calls: Call[] = []

    await typeText(makeLocator(calls), 'a')

    expect(calls[1]).toEqual({
      method: 'pressSequentially',
      character: 'a',
      delay: 200,
    })
  })

  it('lets a per-call delayMs override the suite default', async () => {
    setupRecast(makeFakeTest(), { typingDelayMs: 200 })
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const calls: Call[] = []

    await typeText(makeLocator(calls), 'a', { delayMs: 40 })

    expect(calls[1]).toEqual({
      method: 'pressSequentially',
      character: 'a',
      delay: 40,
    })
  })

  it('resets typingDelayMs when setupRecast is called without the option', async () => {
    setupRecast(makeFakeTest(), { typingDelayMs: 200 })
    setupRecast(makeFakeTest())
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const calls: Call[] = []

    await typeText(makeLocator(calls), 'a')

    expect(calls[1]).toEqual({
      method: 'pressSequentially',
      character: 'a',
      delay: 100,
    })
  })

  it('accepts delayMs 0 and forwards zero for every character', async () => {
    const random = vi.spyOn(Math, 'random')
    const calls: Call[] = []

    await typeText(makeLocator(calls), 'ab', { delayMs: 0 })

    expect(calls).toEqual([
      { method: 'fill', value: '' },
      { method: 'pressSequentially', character: 'a', delay: 0 },
      { method: 'pressSequentially', character: 'b', delay: 0 },
    ])
    expect(random).toHaveBeenCalledTimes(2)
  })

  it('only clears the field when text is empty', async () => {
    const calls: Call[] = []

    await typeText(makeLocator(calls), '')

    expect(calls).toEqual([{ method: 'fill', value: '' }])
  })

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects invalid delay %s before changing the field',
    async (delayMs) => {
      const calls: Call[] = []

      await expect(typeText(makeLocator(calls), 'a', { delayMs }))
        .rejects.toThrow(RangeError)
      expect(calls).toEqual([])
    },
  )

  it('rejects an invalid suite default before changing the field', async () => {
    setupRecast(makeFakeTest(), { typingDelayMs: Number.NaN })
    const calls: Call[] = []

    await expect(typeText(makeLocator(calls), 'a')).rejects.toThrow(RangeError)
    expect(calls).toEqual([])
  })

  it('propagates locator failures and leaves already typed characters intact', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const calls: Call[] = []

    await expect(typeText(makeLocator(calls, { pressErrorAt: 1 }), 'abc'))
      .rejects.toThrow('typing failed')
    expect(calls).toEqual([
      { method: 'fill', value: '' },
      { method: 'pressSequentially', character: 'a', delay: 100 },
      { method: 'pressSequentially', character: 'b', delay: 100 },
    ])
  })

  it('propagates a failure while clearing the existing value', async () => {
    const calls: Call[] = []
    const fillError = new Error('clear failed')

    await expect(typeText(makeLocator(calls, { fillError }), 'abc'))
      .rejects.toBe(fillError)
    expect(calls).toEqual([{ method: 'fill', value: '' }])
  })
})

describe('typeText() without setupRecast()', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses the built-in default without requiring helper setup', async () => {
    vi.resetModules()
    const { typeText: unconfiguredTypeText } = await import('../../../src/helpers')
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const calls: Call[] = []

    await unconfiguredTypeText(makeLocator(calls), 'a')

    expect(calls).toEqual([
      { method: 'fill', value: '' },
      { method: 'pressSequentially', character: 'a', delay: 100 },
    ])
  })
})
