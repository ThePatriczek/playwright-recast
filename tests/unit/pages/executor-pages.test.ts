import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { PipelineExecutor } from '../../../src/pipeline/executor'
import { Recast } from '../../../src/index'
import type { ParsedTrace } from '../../../src/types/trace'
import { PAGES_TITLE_PREFIX } from '../../../src/helpers'

const MAIN = 'page@aa'
const POPUP = 'page@bb'
let dir: string

const webm = (file: string, seconds: number, size = '64x36'): void => {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=gray:s=${size}:r=25:d=${seconds}`, '-c:v', 'libvpx', file])
}
const frame = (pageId: string, timestamp: number) =>
  ({ type: 'screencast-frame', pageId, sha1: `${pageId}-${timestamp}`, width: 64, height: 36, timestamp })
const pageEvent = (pageId: string, time: number, openerPageId?: string) =>
  ({ type: 'event', time, class: 'BrowserContext', method: 'page', params: { pageId, ...(openerPageId ? { openerPageId } : {}) } })

/** A screencast frame's JPEG at `size` (WxH), as the trace stores it. */
const jpeg = (size: string): Uint8Array =>
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=gray:s=${size}`, '-frames:v', '1', '-c:v', 'mjpeg', '-f', 'image2', 'pipe:'])

function recording(name: string, events: object[], videos: Record<string, number>, frameImages: Record<string, string> = {}, videoSize: { width: number; height: number } | null = { width: 64, height: 36 }): string {
  const out = path.join(dir, name)
  fs.mkdirSync(out)
  fs.writeFileSync(path.join(out, 'trace.zip'), zipSync({
    '0-trace.trace': strToU8([{ type: 'context-options', browserName: 'chromium', options: { viewport: { width: 64, height: 36 }, ...(videoSize ? { recordVideo: { size: videoSize } } : {}) } }, ...events].map((e) => JSON.stringify(e)).join('\n')),
    ...Object.fromEntries(Object.entries(frameImages).map(([sha1, size]) => [`resources/${sha1}`, jpeg(size)])),
  }))
  for (const [file, seconds] of Object.entries(videos)) webm(path.join(out, file), seconds)
  return out
}

async function parsed(out: string): Promise<{ parsed: ParsedTrace; sourceVideoPath: string; contentCrop?: { width: number; height: number }; pageTimeline?: Array<{ pageId: string; startMs: number; endMs: number }>; pageVideos?: string[] }> {
  const executor = new PipelineExecutor(out, Recast.from(out).parse().getStages()) as unknown as {
    runStages(): Promise<{ parsed: ParsedTrace; sourceVideoPath: string; contentCrop?: { width: number; height: number }; pageTimeline?: Array<{ pageId: string; startMs: number; endMs: number }>; pageVideos?: string[] }>
  }
  const state = await executor.runStages()
  state.parsed.frameReader.dispose()
  return state
}

beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recast-exec-pages-')) })
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('parse(): which video and which frames', () => {
  it('takes video.webm, not video-1.webm, which sorts first by name', async () => {
    const out = recording('plain', [pageEvent(MAIN, 0), frame(MAIN, 100), frame(MAIN, 1000)], { 'video.webm': 1, 'video-1.webm': 3 })
    expect(path.basename((await parsed(out)).sourceVideoPath)).toBe('video.webm')
  })

  it('times from the primary page when a popup without actions stays open to the end', async () => {
    const out = recording('popup-open', [
      pageEvent(MAIN, 0), frame(MAIN, 100),
      { type: 'before', callId: 'c1', title: 'Click', class: 'Frame', method: 'click', params: {}, startTime: 500, pageId: MAIN },
      { type: 'after', callId: 'c1', endTime: 520 },
      pageEvent(POPUP, 1000, MAIN), frame(POPUP, 1100), frame(POPUP, 2900),
    ], { [`${MAIN}.webm`]: 3, [`${POPUP}.webm`]: 2 })
    const state = await parsed(out)
    expect(path.basename(state.sourceVideoPath)).toBe(`${MAIN}.webm`)
    expect(state.parsed.frames.map((f) => f.pageId)).toEqual([MAIN])
  })
})

describe('parse(): review round 2', () => {
  const TAB = 'page@cc'
  const click = (id: string, pageId: string, t: number) => [
    { type: 'before', callId: id, title: 'Click', class: 'Frame', method: 'click', params: {}, startTime: t, pageId },
    { type: 'after', callId: id, endTime: t + 20 },
  ]

  it('prefers video.webm over other .webm files', async () => {
    const out = recording('intro', [pageEvent(MAIN, 0), frame(MAIN, 100), frame(MAIN, 3000)], { 'video.webm': 1 })
    webm(path.join(out, 'intro.webm'), 3, '128x72')
    expect(path.basename((await parsed(out)).sourceVideoPath)).toBe('video.webm')
  })

  it('composites when only another page gets screen time', async () => {
    // The primary's 50 ms before the popup is flicker; the popup alone is on screen.
    const out = recording('popup-only', [
      pageEvent(MAIN, 0), frame(MAIN, 100),
      pageEvent(POPUP, 120, MAIN), frame(POPUP, 150), ...click('c1', POPUP, 200), ...click('c2', POPUP, 1500),
    ], { [`${MAIN}.webm`]: 2, [`${POPUP}.webm`]: 2 })
    const state = await parsed(out)
    expect(path.basename(state.sourceVideoPath)).toBe('pages.mp4')
    expect(state.parsed.frames[0]!.timestamp).toBe(150)
  })

  it('ends the video with the last page that can come on screen', async () => {
    const IDLE = 'page@dd'
    const out = recording('idle-popup', [
      pageEvent(MAIN, 0), frame(MAIN, 100),
      pageEvent(TAB, 500, MAIN), frame(TAB, 600), ...click('c1', TAB, 700),
      pageEvent(IDLE, 700, MAIN), frame(IDLE, 800),
    ], { [`${MAIN}.webm`]: 3, [`${TAB}.webm`]: 2, [`${IDLE}.webm`]: 5 })
    const state = await parsed(out)
    expect(state.pageTimeline!.at(-1)!.endMs).toBeLessThan(3200)
  })

})

describe('parse(): review round 3', () => {
  const click = (id: string, pageId: string, t: number) => [
    { type: 'before', callId: id, title: 'Click', class: 'Frame', method: 'click', params: {}, startTime: t, pageId },
    { type: 'after', callId: id, endTime: t + 20 },
  ]
  const probe = (file: string) => execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim()

  it('composites a padded primary page as its content only, so CSS maps to the whole frame', async () => {
    // Viewport 64x36 recorded into 128x72 videos: Playwright pads, never scales up
    const out = recording('padded', [
      pageEvent(MAIN, 0), frame(MAIN, 100), ...click('c1', MAIN, 200),
      pageEvent(POPUP, 500, MAIN), { ...frame(POPUP, 600), width: 32, height: 20 }, ...click('c2', POPUP, 700), ...click('c3', MAIN, 1800),
    ], {}, { [`${MAIN}-100`]: '64x36', [`${POPUP}-600`]: '32x20' })
    webm(path.join(out, `${MAIN}.webm`), 2.5, '128x72')
    webm(path.join(out, `${POPUP}.webm`), 1.5, '128x72')
    const state = await parsed(out)
    expect(path.basename(state.sourceVideoPath)).toBe('pages.mp4')
    expect(probe(state.sourceVideoPath)).toBe('64,36')
  })

  it('does not hang on an opener chain that loops', async () => {
    const out = recording('loop', [
      pageEvent(MAIN, 0, POPUP), frame(MAIN, 100), pageEvent(POPUP, 200, MAIN), frame(POPUP, 300), frame(MAIN, 1000),
    ], { 'video.webm': 1 })
    expect((await parsed(out)).sourceVideoPath).toBeDefined()
  })

  const TAB = 'page@cc'
  /** The step recastPageVideos writes: the page of each video.webm / video-N.webm */
  const pagesStep = (ids: Array<string | null>, t = 5000) => [
    { type: 'before', callId: 'pages', title: `${PAGES_TITLE_PREFIX}${JSON.stringify(ids)}`, class: 'Test', method: 'test.step', params: {}, startTime: t },
    { type: 'after', callId: 'pages', endTime: t + 1 },
  ]
  const tabTrace = [pageEvent(MAIN, 0), frame(MAIN, 100), pageEvent(TAB, 1000, MAIN), frame(TAB, 1100), ...click('c1', TAB, 1500), frame(TAB, 2000)]

  it("matches Playwright Test's videos to pages by the fixture's step", async () => {
    const state = await parsed(recording('test-videos', [...tabTrace, ...pagesStep([MAIN, TAB])], { 'video.webm': 3, 'video-1.webm': 2 }))
    expect(state.pageVideos?.map((v) => path.basename(v)).sort()).toEqual(['video-1.webm', 'video.webm'])
    expect(state.pageTimeline?.map((s) => s.pageId)).toEqual([MAIN, TAB])
  })

  it('times the plain video from the primary page only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const state = await parsed(recording('plain-tab', tabTrace, { 'video.webm': 3, 'video-1.webm': 2 }))
      expect(path.basename(state.sourceVideoPath)).toBe('video.webm')
      expect(new Set(state.parsed.frames.map((f) => f.pageId))).toEqual(new Set([MAIN]))
    } finally {
      warn.mockRestore()
    }
  })

  it("keeps the plain video's own page, the context's first, also when another page paints last", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // A tab from context.newPage(): no opener, so not the primary page's popup
      const trace = [pageEvent(MAIN, 0), frame(MAIN, 100), pageEvent(TAB, 1000), frame(TAB, 1100), ...click('c1', MAIN, 1500), frame(TAB, 2000)]
      const state = await parsed(recording('plain-newpage', trace, { 'video.webm': 3, 'video-1.webm': 2 }))
      expect(new Set(state.parsed.frames.map((f) => f.pageId))).toEqual(new Set([MAIN]))
      const listed = await parsed(recording('plain-newpage-listed', [...trace, ...pagesStep([TAB, MAIN])], { 'video.webm': 3 }))
      expect(new Set(listed.parsed.frames.map((f) => f.pageId))).toEqual(new Set([TAB]))
    } finally {
      warn.mockRestore()
    }
  })

  it('keeps the page with the first frame when it was created before tracing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // No page event for MAIN: parsed.pages lists it after the popup
      const state = await parsed(recording('pre-tracing', [frame(MAIN, 100), pageEvent(POPUP, 1000, MAIN), frame(POPUP, 1100), ...click('c1', POPUP, 1500), frame(POPUP, 2000)], { 'video.webm': 3 }))
      expect(new Set(state.parsed.frames.map((f) => f.pageId))).toEqual(new Set([MAIN]))
    } finally {
      warn.mockRestore()
    }
  })

  it('says why when the fixture ran but the main page has no video', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await parsed(recording('no-main-id', [...tabTrace, ...pagesStep([null, TAB])], { 'video.webm': 3, 'video-1.webm': 2 }))
      expect(String(warn.mock.calls[0]![0])).toContain('retain-on-failure')
    } finally {
      warn.mockRestore()
    }
  })

  it('warns about other pages with actions, pointing to the fixture', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await parsed(recording('idle-other', [pageEvent(MAIN, 0), frame(MAIN, 100), pageEvent(POPUP, 200, MAIN), frame(POPUP, 300), frame(MAIN, 1000)], { 'video.webm': 1 }))
      expect(warn).not.toHaveBeenCalled()
      await parsed(recording('busy-other', [pageEvent(MAIN, 0), frame(MAIN, 100), pageEvent(POPUP, 200, MAIN), frame(POPUP, 300), ...click('c1', POPUP, 400), frame(MAIN, 1000)], { 'video.webm': 1 }))
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]![0])).toContain('recastPageVideos')
    } finally {
      warn.mockRestore()
    }
  })
})

describe('urlBar() with direct()', () => {
  it('is refused before anything renders', async () => {
    const provider = { name: 'fake' } as never
    await expect(Recast.from(dir).parse().direct(provider, { goal: 'x' } as never).urlBar().render().toFile(path.join(dir, 'x.mp4')))
      .rejects.toThrow(/urlBar\(\) is not supported with direct\(\)/)
  })
})

describe('parse(): review round 4, sizes from the trace\'s frames', () => {
  const probe = (file: string) => execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim()
  const click = (id: string, pageId: string, t: number) => [
    { type: 'before', callId: id, title: 'Click', class: 'Frame', method: 'click', params: {}, startTime: t, pageId },
    { type: 'after', callId: id, endTime: t + 20 },
  ]

  it('hands a single padded page to the renderer with its content rect, the video unchanged', async () => {
    // 1366x768 into an 800x448 video records at 797x448
    const out = recording('single-padded', [pageEvent(MAIN, 0), frame(MAIN, 100), frame(MAIN, 2000)], {}, { [`${MAIN}-2000`]: '63x36' })
    webm(path.join(out, `${MAIN}.webm`), 2, '128x72')
    const state = await parsed(out)
    expect(path.basename(state.sourceVideoPath)).toBe(`${MAIN}.webm`)
    expect(state.contentCrop).toEqual({ width: 63, height: 36 })
  })

  it('takes the largest recorded size over a page\'s frames, so a late viewport change cannot shrink the video', async () => {
    const out = recording('late-resize', [
      pageEvent(MAIN, 0), frame(MAIN, 100), { ...frame(MAIN, 2000), width: 20, height: 36 },
    ], {}, { [`${MAIN}-100`]: '64x36', [`${MAIN}-2000`]: '20x36' })
    webm(path.join(out, `${MAIN}.webm`), 2, '128x72')
    const state = await parsed(out)
    expect(state.contentCrop).toEqual({ width: 64, height: 36 })
    expect(state.parsed.metadata.viewport).toEqual({ width: 64, height: 36 })
  })

  it('derives the viewport at one CSS-to-pixel ratio, so both axes map alike after a resize', async () => {
    // 64x36 records at 40x22 (0.625); after a resize to 64x52 the frame is 28x22
    const out = recording('ratio', [
      pageEvent(MAIN, 0), frame(MAIN, 100), { ...frame(MAIN, 2000), width: 64, height: 52 },
    ], {}, { [`${MAIN}-100`]: '40x22', [`${MAIN}-2000`]: '28x22' })
    webm(path.join(out, `${MAIN}.webm`), 2, '128x72')
    const { contentCrop, parsed: p } = await parsed(out)
    expect(contentCrop).toEqual({ width: 40, height: 22 })
    expect(p.metadata.viewport.width / contentCrop!.width).toBeCloseTo(p.metadata.viewport.height / contentCrop!.height, 6)
  })

  it('reads another frame of the same size when one JPEG is unreadable', async () => {
    const out = recording('retry-jpeg', [pageEvent(MAIN, 0), frame(MAIN, 100), frame(MAIN, 2000)], {}, { [`${MAIN}-100`]: '40x22' })
    webm(path.join(out, `${MAIN}.webm`), 2, '128x72')
    expect((await parsed(out)).contentCrop).toEqual({ width: 40, height: 22 })
  })

  it('reports the page videos it composited', async () => {
    const out = recording('report', [
      pageEvent(MAIN, 0), frame(MAIN, 100),
      pageEvent(POPUP, 120, MAIN), frame(POPUP, 150), ...click('c1', POPUP, 200), ...click('c2', POPUP, 1500),
    ], { [`${MAIN}.webm`]: 2, [`${POPUP}.webm`]: 2 }, { [`${MAIN}-100`]: '64x36', [`${POPUP}-150`]: '32x18' })
    const state = await parsed(out)
    expect(path.basename(state.sourceVideoPath)).toBe('pages.mp4')
    expect(state.pageVideos!.map((f) => path.basename(f)).sort()).toEqual([`${MAIN}.webm`, `${POPUP}.webm`])
  })

  it('trusts frame sizes only in Chromium, where the video records the same frames', async () => {
    const out = path.join(dir, 'firefox')
    fs.mkdirSync(out)
    fs.writeFileSync(path.join(out, 'trace.zip'), zipSync({
      '0-trace.trace': strToU8([{ type: 'context-options', browserName: 'firefox', options: { viewport: { width: 64, height: 36 } } }, pageEvent(MAIN, 0), frame(MAIN, 100), frame(MAIN, 2000)].map((e) => JSON.stringify(e)).join('\n')),
      [`resources/${MAIN}-2000`]: jpeg('40x30'),
    }))
    webm(path.join(out, `${MAIN}.webm`), 2, '128x72')
    expect((await parsed(out)).contentCrop).toBeUndefined()
  })

  it('uses a .webm of another size as is when no video of the recording is next to the trace', async () => {
    // As before multi-page support: the one plain video found, uncropped
    const out = recording('screen-webm', [pageEvent(MAIN, 0), frame(MAIN, 100), frame(MAIN, 2000)], {}, { [`${MAIN}-2000`]: '40x30' }, { width: 128, height: 72 })
    webm(path.join(out, 'screen.webm'), 2, '256x144')
    const state = await parsed(out)
    expect(path.basename(state.sourceVideoPath)).toBe('screen.webm')
    expect(state.contentCrop).toBeUndefined()
  })

  it('starts the stages\' clock with a frame at the timeline\'s start', async () => {
    // The primary's first stretch (1000-1060) is flicker and dropped; the
    // popup's next frame comes after the timeline starts
    const out = recording('lead-frame', [
      pageEvent(MAIN, 0), frame(MAIN, 1000), pageEvent(POPUP, 1010, MAIN), frame(POPUP, 1030),
      ...click('c1', MAIN, 1060), ...click('c2', POPUP, 1100), frame(POPUP, 2500),
    ], { [`${MAIN}.webm`]: 3, [`${POPUP}.webm`]: 2 })
    const state = await parsed(out)
    expect(state.parsed.frames[0]!.timestamp).toBe(state.pageTimeline![0]!.startMs)
  })
})

describe('render(): urlBar() font check', () => {
  it('checks the last urlBar(), the one that renders', async () => {
    const out = recording('font-check', [pageEvent(MAIN, 0), frame(MAIN, 100), frame(MAIN, 1000)], { 'video.webm': 1 })
    const pipeline = Recast.from(out).parse().urlBar().urlBar({ fontFile: '/missing/font.ttf' })
    await expect(pipeline.toFile(path.join(out, 'out', 'demo.mp4'))).rejects.toThrow(/no such file: \/missing\/font.ttf/)
  })
})
