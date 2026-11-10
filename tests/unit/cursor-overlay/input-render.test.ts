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

// A real recording: a drag whose 30 steps take seconds (the page works on
// every mousemove, like a canvas redrawing a selection frame), a right-button
// press and Ctrl+Z. Skipped where Chromium is not installed. The textured
// band keeps the renderer from trimming the start as blank lead-in; at 60px
// ffmpeg 6.1's probe PNG stayed under the blank threshold.
const available = fs.existsSync(chromium.executablePath())
const BG = [255, 233, 199]
let dir: string
let server: http.Server
let output: string
let drag: { start: number; end: number }
let rightPress: number
let undo: number

const BAND = '<div style="height:150px;background:repeating-linear-gradient(45deg,#000 0 3px,#fff 3px 6px)"></div>'
const PAGE = `<!doctype html><body style="margin:0;height:100vh;background:#ffe9c7">${BAND}
<script>addEventListener('mousemove', () => { const t = performance.now(); while (performance.now() - t < 40); })</script></body>`

/** The row y between x0 and x1, as RGB triples. */
function row(file: string, sec: number, y: number, x0: number, x1: number): number[][] {
  expect(sec).toBeLessThan(getVideoDuration(file))
  const raw = execFileSync('ffmpeg', [
    '-v', 'error', '-ss', sec.toFixed(3), '-i', file, '-frames:v', '1',
    '-vf', `format=rgb24,crop=${x1 - x0}:1:${x0}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ])
  return Array.from({ length: x1 - x0 }, (_, i) => [...raw.subarray(i * 3, i * 3 + 3)])
}
const offBackground = (px: number[]) => px.some((v, i) => Math.abs(v - BG[i]!) > 40)
const bluish = (px: number[]) => px[2]! > px[0]! + 60

describe.skipIf(!available)('mouse input in a real recording', () => {
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recast-input-render-'))
    server = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(PAGE) })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const rec = path.join(dir, 'rec')
    const browser = await chromium.launch()
    const context = await browser.newContext({ viewport: { width: 640, height: 360 }, recordVideo: { dir: rec, size: { width: 640, height: 360 } } })
    await context.tracing.start({ screenshots: true, snapshots: true })
    const page = await context.newPage()
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`)
    await page.waitForTimeout(500)
    await page.mouse.move(100, 200, { steps: 3 })
    await page.mouse.down()
    await page.mouse.move(500, 200, { steps: 30 })
    await page.mouse.up()
    await page.waitForTimeout(600)
    await page.mouse.down({ button: 'right' })
    await page.waitForTimeout(300)
    await page.mouse.up({ button: 'right' })
    await page.waitForTimeout(600)
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(1500)
    await context.tracing.stop({ path: path.join(rec, 'trace.zip') })
    await context.close()
    await browser.close()

    const trace = await parseTrace(path.join(rec, 'trace.zip'))
    const t0 = trace.frames[0]!.timestamp as number
    const sec = (ms: number) => (ms - t0) / 1000
    const move = trace.actions.filter((a) => a.method === 'mouseMove')[1]!
    drag = { start: sec(move.startTime as number), end: sec(move.endTime as number) }
    rightPress = sec(trace.actions.find((a) => a.method === 'mouseDown' && a.params.button === 'right')!.endTime as number)
    undo = sec(trace.actions.find((a) => a.method === 'keyboardPress')!.endTime as number)
    trace.frameReader.dispose()

    output = path.join(dir, 'out', 'demo.mp4')
    await Recast.from(rec).parse()
      .cursorOverlay({ mouseIndicator: { size: 90, accentColor: '#0000FF' } })
      .keyOverlay({ background: '#000000', backgroundOpacity: 1 })
      .render({ resolution: { width: 640, height: 360 } })
      .toFile(output)
  }, 120_000)
  afterAll(() => {
    server?.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('records a drag whose move takes long enough to matter', () => {
    expect(drag.end - drag.start).toBeGreaterThan(0.8)
  })

  it('moves the cursor with the drag, not after it', () => {
    // Halfway through the move the pointer is near x=300: the cursor is there, not at the start.
    const mid = row(output, (drag.start + drag.end) / 2, 212, 0, 640)
    const cursorXs = mid.map((px, x) => (offBackground(px) ? x : -1)).filter((x) => x >= 0)
    expect(cursorXs.length).toBeGreaterThan(0)
    expect(Math.min(...cursorXs)).toBeGreaterThan(200)
    expect(Math.max(...cursorXs)).toBeLessThan(420)
  })

  it('shows the right button beside the cursor while it is down', () => {
    // Icon 30px high at 360p, beside the 30x44 cursor image at (500, 200): its right button.
    expect(row(output, rightPress + 0.15, 235, 530, 550).some(bluish)).toBe(true)
  })

  it('shows Ctrl + Z as a keycap at the bottom', () => {
    expect(row(output, undo + 0.5, 330, 280, 360).some((px) => px.every((v) => v < 40))).toBe(true)
    expect(row(output, undo - 0.5, 330, 280, 360).some((px) => px.every((v) => v < 40))).toBe(false)
  })
})
