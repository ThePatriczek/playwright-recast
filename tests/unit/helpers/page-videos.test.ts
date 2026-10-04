import { describe, it, expect, vi } from 'vitest'
import { PAGES_TITLE_PREFIX, recastPageVideos } from '../../../src/helpers'

const step = vi.hoisted(() => vi.fn(async (_title: string, body: () => Promise<void>) => body()))
vi.mock('@playwright/test', () => ({ test: { step } }))

/** A page as the fixture sees it: its private trace id and whether it records. */
const fakePage = (guid: unknown, video = true) => ({ _guid: guid, url: () => 'https://example.com/', video: () => (video ? {} : null) })

function fakeContext(initial: unknown[]) {
  let onPage: ((page: unknown) => void) | undefined
  return {
    context: { pages: () => initial, on: (_e: string, fn: (page: unknown) => void) => { onPage = fn } },
    open: (page: unknown) => onPage!(page),
  }
}

const run = async (initial: unknown[], during: (open: (page: unknown) => void) => void = () => {}) => {
  step.mockClear()
  const { context, open } = fakeContext(initial)
  const used: unknown[] = []
  await recastPageVideos.context({ context } as never, async (c) => { used.push(c); during(open) })
  return { used: used[0], context, titles: step.mock.calls.map((c) => c[0]) }
}

describe('recastPageVideos', () => {
  it('hands the context on and writes one step with the page id of each video, in the order the pages opened', async () => {
    const { used, context, titles } = await run([fakePage('page@aa')], (open) => { open(fakePage('page@cc', false)); open(fakePage('page@bb')) })
    expect(used).toBe(context)
    expect(titles).toEqual([`${PAGES_TITLE_PREFIX}["page@aa","page@bb"]`])
  })

  it('does nothing without video recording', async () => {
    expect((await run([fakePage('page@aa', false)])).titles).toEqual([])
  })

  it('keeps the place of a page without a usable id, and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { titles } = await run([fakePage(undefined), fakePage('Page#1'), fakePage('page@bb')])
      expect(titles).toEqual([`${PAGES_TITLE_PREFIX}[null,null,"page@bb"]`])
      expect(warn).toHaveBeenCalledTimes(2)
      expect(String(warn.mock.calls[0]![0])).toContain('cannot be matched to the trace')
    } finally {
      warn.mockRestore()
    }
  })

  it('warns instead of failing the test when the step cannot be written', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    step.mockRejectedValueOnce(new Error('Requiring @playwright/test second time'))
    try {
      const { context } = fakeContext([fakePage('page@aa')])
      await recastPageVideos.context({ context } as never, async () => {})
      expect(String(warn.mock.calls[0]![0])).toContain('could not record the video pages')
    } finally {
      warn.mockRestore()
    }
  })
})
