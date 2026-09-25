import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright-core'
import type { TestInfo } from '@playwright/test'
import { zoom, highlight, setupRecast, ZOOM_TITLE_PREFIX, HIGHLIGHT_TITLE_PREFIX } from '../../../src/helpers'

// Real layout, not a fake locator: text boxes and iframe offsets only exist
// in a browser. Skipped where Chromium is not installed; a launch failure fails.
const browser: Browser | undefined = fs.existsSync(chromium.executablePath()) ? await chromium.launch() : undefined

const VIEWPORT = { width: 1000, height: 500 }
// An iframe offset by (200, 100) holding a full-width "line" whose text is
// short, one whose text is wider than a 2x zoom frame (500px), one just
// narrower, and a full-width input with a short value.
const FRAME = `
  <style>body{margin:0;font:16px monospace} div{width:780px;height:20px;white-space:pre}</style>
  <div id="short">  SELECT 1</div>
  <div id="long">${'x'.repeat(70)}</div>
  <div id="fits">${'x'.repeat(49)}</div>
  <input id="field" style="width:780px;font:16px monospace" value="abc">`
const PAGE = `<body style="margin:0"><iframe style="position:absolute;left:200px;top:100px;width:800px;height:300px;border:0" srcdoc="${FRAME.replace(/"/g, '&quot;')}"></iframe></body>`

function capture() {
  const steps: string[] = []
  const info = { annotations: [] } as unknown as TestInfo
  setupRecast({ info: () => info, step: async (title: string, body: () => unknown) => { steps.push(title); return body() } } as never)
  return steps
}
const payload = (steps: string[], prefix: string) => JSON.parse(steps.find((s) => s.startsWith(prefix))!.slice(prefix.length))

describe.skipIf(!browser)('text boxes in zoom() and highlight()', () => {
  let page: Page
  let steps: string[]

  beforeAll(async () => {
    page = await browser!.newPage({ viewport: VIEWPORT })
    await page.setContent(PAGE)
    await page.frameLocator('iframe').locator('#long').waitFor()
  })
  afterAll(async () => { await browser?.close() })
  beforeEach(() => { steps = capture() })

  const frame = () => page.frameLocator('iframe')

  it('zooms onto the text, not the full-width element', async () => {
    const text = await frame().locator('#short').evaluate((el) => {
      const r = document.createRange(); r.selectNodeContents(el); const b = r.getBoundingClientRect()
      return { center: b.x + b.width / 2 }
    })
    await zoom(frame().locator('#short'), 2, { text: true })
    // Text center in page space = iframe offset + center inside the frame.
    expect(payload(steps, ZOOM_TITLE_PREFIX).x).toBeCloseTo((200 + text.center) / VIEWPORT.width, 3)
  })

  it('keeps the start of a target wider than the zoomed frame in view', async () => {
    await zoom(frame().locator('#long'), 2, { text: true, align: 'start' })
    // Frame is 500px wide at 2x; the centre sits 45% of it past the text start (x=200).
    expect(payload(steps, ZOOM_TITLE_PREFIX).x).toBeCloseTo((200 + 225) / VIEWPORT.width, 3)
  })

  it('centres a target that fits the zoomed frame, even with align start', async () => {
    const text = await frame().locator('#fits').evaluate((el) => {
      const r = document.createRange(); r.selectNodeContents(el); const b = r.getBoundingClientRect()
      return { width: b.width, center: b.x + b.width / 2 }
    })
    expect(text.width).toBeGreaterThan(450) // past 90% of the 500px frame, still inside it
    await zoom(frame().locator('#fits'), 2, { text: true, align: 'start' })
    expect(payload(steps, ZOOM_TITLE_PREFIX).x).toBeCloseTo((200 + text.center) / VIEWPORT.width, 3)
  })

  it("zooms onto an input's value, not the full-width control", async () => {
    await zoom(frame().locator('#field'), 2, { text: true })
    // The control's centre is at 200 + 390; its three-character value starts near 200.
    expect(payload(steps, ZOOM_TITLE_PREFIX).x * VIEWPORT.width).toBeLessThan(260)
  })

  it('places a text highlight inside an iframe in page space', async () => {
    const inFrame = await frame().locator('#short').evaluate((el) => {
      const node = el.firstChild!; const r = document.createRange()
      r.setStart(node, 2); r.setEnd(node, 8); const b = r.getBoundingClientRect()
      return { x: b.x, y: b.y }
    })
    await highlight(frame().locator('#short'), { text: 'SELECT' })
    const box = payload(steps, HIGHLIGHT_TITLE_PREFIX)
    expect(box.x).toBeCloseTo(200 + inFrame.x, 1)
    expect(box.y).toBeCloseTo(100 + inFrame.y, 1)
  })
})
