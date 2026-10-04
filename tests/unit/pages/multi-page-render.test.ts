import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { chromium } from 'playwright-core'
import { Recast } from '../../../src/index'
import { parseTrace } from '../../../src/parse/trace-parser'
import { getVideoDuration } from '../../../src/render/renderer'

// A main page opens a smaller popup with window.open, which closes itself:
// the raw page@<pageId>.webm videos have to be cut into one video, the popup
// centered over the dimmed main page. Skipped where Chromium is not installed.
const available = fs.existsSync(chromium.executablePath())
const MAIN_BG = [255, 233, 199]
const POPUP_BG = [207, 232, 255]
let dir: string
let server: http.Server

// A textured band on top: the renderer trims flat, near-empty frames at the
// start as blank lead-in, which would cut a flat page's whole video. The
// colour checks sample below it.
const BAND = '<div style="height:60px;background:repeating-linear-gradient(45deg,#000 0 3px,#fff 3px 6px)"></div>'
const page = (title: string, bg: string, body: string) =>
  `<!doctype html><title>${title}</title><body style="margin:0;height:100vh;background:${bg}">${BAND}${body}</body>`

async function record(out: string, port: number): Promise<void> {
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 640, height: 360 }, recordVideo: { dir: out, size: { width: 640, height: 360 } } })
  await context.tracing.start({ screenshots: true, snapshots: true })
  const main = await context.newPage()
  await main.goto(`http://127.0.0.1:${port}/main`)
  await main.waitForTimeout(600)
  const popupPromise = main.waitForEvent('popup')
  await main.click('#open')
  const popup = await popupPromise
  await popup.waitForLoadState()
  await popup.click('#ok')
  await popup.waitForTimeout(1500)
  await popup.evaluate(() => window.close())
  await main.waitForTimeout(800)
  await main.click('#open', { trial: true })
  await context.tracing.stop({ path: path.join(out, 'trace.zip') })
  await context.close()
  await browser.close()
}

/** The main page opens a full-size tab and closes; the test goes on in the tab. */
async function recordTabHandover(out: string, port: number): Promise<void> {
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 640, height: 360 }, recordVideo: { dir: out, size: { width: 640, height: 360 } } })
  await context.tracing.start({ screenshots: true, snapshots: true })
  const main = await context.newPage()
  // Textured: the renderer trims flat, near-empty frames at the start as blank.
  await main.goto(`http://127.0.0.1:${port}/busy`)
  await main.waitForTimeout(600)
  const tabPromise = main.waitForEvent('popup')
  await main.evaluate((p) => { window.open(`http://localhost:${p}/popup`) }, port)
  const tab = await tabPromise
  await tab.waitForLoadState()
  await main.close()
  await tab.click('#ok')
  await tab.waitForTimeout(1500)
  await context.tracing.stop({ path: path.join(out, 'trace.zip') })
  await context.close()
  await browser.close()
}

function rgbAt(file: string, sec: number, x: number, y: number): number[] {
  // Past the end ffmpeg writes nothing: fail loudly rather than pass on []
  expect(sec, `sample at ${sec}s past the end`).toBeLessThan(getVideoDuration(file))
  const rgb = execFileSync('ffmpeg', [
    '-v', 'error', '-ss', sec.toFixed(3), '-i', file, '-frames:v', '1',
    '-vf', `crop=2:2:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ])
  return [...rgb.subarray(0, 3)]
}

const near = (actual: number[], expected: number[], tolerance = 24) =>
  actual.length === expected.length && actual.every((v, i) => Math.abs(v - expected[i]!) <= tolerance)

describe.skipIf(!available)('multi-page render', () => {
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recast-multipage-'))
    server = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html')
      if (req.url?.startsWith('/popup')) res.end(page('Popup', '#cfe8ff', '<button id=ok>Allow</button>'))
      else if (req.url?.startsWith('/busy')) res.end(page('Busy', 'repeating-linear-gradient(45deg,#ffe9c7 0 3px,#c9a46b 3px 6px)', ''))
      else res.end(page('Main', '#ffe9c7', `<button id=open onclick="window.open('http://localhost:${(server.address() as { port: number }).port}/popup?token=secret','p','width=320,height=240')">Connect</button>`))
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    await record(path.join(dir, 'rec'), (server.address() as { port: number }).port)
    await recordTabHandover(path.join(dir, 'tab'), (server.address() as { port: number }).port)
  }, 90_000)
  afterAll(() => {
    server?.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('shows the popup centered over the dimmed main page, and the main page again after it closes', async () => {
    const rec = path.join(dir, 'rec')
    expect(fs.readdirSync(rec).filter((f) => /^page@[0-9a-f]+\.webm$/.test(f))).toHaveLength(2)

    const trace = await parseTrace(path.join(rec, 'trace.zip'))
    const mainId = trace.frames[trace.frames.length - 1]!.pageId
    const t0 = trace.frames.find((f) => f.pageId === mainId)!.timestamp as number
    const popupFrame = trace.frames.find((f) => f.pageId !== mainId)!
    const closedAt = trace.pages!.find((p) => p.pageId === popupFrame.pageId)!.closedAt as number
    // The popup is on screen from its first action until it closes; a busy machine stretches both
    const popupFirstAction = Math.max(popupFrame.timestamp as number, trace.actions.find((a) => a.pageId === popupFrame.pageId)!.startTime as number)
    trace.frameReader.dispose()

    const output = path.join(dir, 'out', 'demo.mp4')
    await Recast.from(rec).parse().urlBar({ show: 'always' }).render({ resolution: { width: 640, height: 360 } }).toFile(output)
    // The output runs on the trace clock from the main page's first frame: at
    // least until the popup closed and the main page showed again
    expect(getVideoDuration(output)).toBeGreaterThan((closedAt - t0 + 400) / 1000)

    const during = ((popupFirstAction + closedAt) / 2 - t0) / 1000
    expect(near(rgbAt(output, during, 320, 200), POPUP_BG)).toBe(true)
    expect(near(rgbAt(output, during, 600, 330), MAIN_BG.map((v) => v * 0.4))).toBe(true)
    expect(near(rgbAt(output, 0.3, 600, 330), MAIN_BG)).toBe(true)
    expect(near(rgbAt(output, (closedAt - t0 + 400) / 1000, 320, 200), MAIN_BG)).toBe(true)
    // No temp files left next to the recording
    expect(fs.readdirSync(rec).filter((f) => f.startsWith('.recast'))).toEqual([])
    // The report keeps naming one source video, and lists the composited ones
    const report = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'recast-report.json'), 'utf8')) as { sourceVideo: unknown; pageVideos?: unknown }
    expect(typeof report.sourceVideo).toBe('string')
    expect(report.pageVideos).toHaveLength(2)
  }, 120_000)

  it('goes on with a tab after the page that opened it closed', async () => {
    const rec = path.join(dir, 'tab')
    const trace = await parseTrace(path.join(rec, 'trace.zip'))
    const mainId = trace.pages!.find((p) => !p.openerPageId)!.pageId
    const t0 = trace.frames.find((f) => f.pageId === mainId)!.timestamp as number
    const mainClosed = trace.pages!.find((p) => p.pageId === mainId)!.closedAt as number
    trace.frameReader.dispose()

    const output = path.join(dir, 'out-tab', 'demo.mp4')
    await Recast.from(rec).parse().render({ resolution: { width: 640, height: 360 } }).toFile(output)

    const after = (mainClosed - t0 + 1000) / 1000
    expect(getVideoDuration(output)).toBeGreaterThan(after)
    expect(near(rgbAt(output, after, 320, 200), POPUP_BG)).toBe(true)
  }, 120_000)
})
