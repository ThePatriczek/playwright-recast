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
// narrower, a full-width input with a short value, a line split into token
// spans, an input whose long value scrolls, and form controls whose
// spacing, box sizing or wrap mode move the text.
const FRAME = `
  <style>body{margin:0;font:16px monospace} div{width:780px;height:20px;white-space:pre}</style>
  <div id="short">  SELECT 1</div>
  <div id="long">${'x'.repeat(70)}</div>
  <div id="fits">${'x'.repeat(49)}</div>
  <input id="field" style="width:780px;font:16px monospace" value="abc">
  <div id="tokens"><span>SEL</span><span>ECT</span> 1</div>
  <input id="scrolled" style="width:200px;font:16px monospace;padding:0;border:0" value="${'a'.repeat(60)}TARGET">
  <input id="spaced" style="width:400px;font:16px monospace;letter-spacing:6px;padding:0;border:0" value="abcdefTARGET">
  <textarea id="boxed" style="box-sizing:content-box;width:200px;padding:0 40px;border:0;font:16px monospace;resize:none">${'word '.repeat(4)}TARGET</textarea>
  <textarea id="nowrap" wrap="off" style="width:200px;height:24px;font:16px monospace;padding:0;border:0;resize:none">${'word '.repeat(12)}TARGET</textarea>`
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

  it('finds a substring split across token spans', async () => {
    const inFrame = await frame().locator('#tokens').evaluate((el) => {
      const r = document.createRange(); r.setStart(el.firstChild!.firstChild!, 0); r.setEnd(el.childNodes[2]!, 2)
      const b = r.getBoundingClientRect(); return { x: b.x, width: b.width }
    })
    await highlight(frame().locator('#tokens'), { text: 'SELECT 1' })
    const box = payload(steps, HIGHLIGHT_TITLE_PREFIX)
    expect(box.x).toBeCloseTo(200 + inFrame.x, 1)
    expect(box.width).toBeCloseTo(inFrame.width, 1)
  })

  it("measures a long input value on one line, where it scrolled to", async () => {
    const field = frame().locator('#scrolled')
    await field.evaluate((el: HTMLInputElement) => { el.scrollLeft = el.scrollWidth })
    await highlight(field, { text: 'TARGET' })
    const box = payload(steps, HIGHLIGHT_TITLE_PREFIX)
    const input = (await field.boundingBox())!
    // Scrolled to the end, TARGET is the value's visible tail, on the input's own line.
    expect(box.x + box.width).toBeCloseTo(input.x + input.width, -1)
    expect(box.y).toBeCloseTo(input.y, -1)
  })

  // Where the text really is, measured by selecting it in the control itself.
  const selected = (id: string) => frame().locator(id).evaluate((el: HTMLInputElement | HTMLTextAreaElement) => {
    const start = el.value.indexOf('TARGET')
    const probe = document.createElement('div')
    const style = getComputedStyle(el)
    for (const p of style) probe.style.setProperty(p, style.getPropertyValue(p))
    probe.style.position = 'absolute'
    probe.style.whiteSpace = el instanceof HTMLInputElement || el.wrap === 'off' ? 'pre' : 'pre-wrap'
    const mark = document.createElement('span')
    mark.textContent = 'TARGET'
    probe.append(el.value.slice(0, start), mark)
    el.after(probe)
    const r = el.getBoundingClientRect(), p = probe.getBoundingClientRect(), m = mark.getBoundingClientRect()
    probe.remove()
    return { x: r.x + m.x - p.x - el.scrollLeft, y: r.y + m.y - p.y - el.scrollTop }
  })

  it.each(['#spaced', '#boxed'])('measures %s with its own letter spacing and box sizing', async (id) => {
    const expected = await selected(id)
    await highlight(frame().locator(id), { text: 'TARGET' })
    const box = payload(steps, HIGHLIGHT_TITLE_PREFIX)
    expect(box.x).toBeCloseTo(200 + expected.x, 0)
    expect(box.y).toBeCloseTo(100 + expected.y, 0)
  })

  it('measures a textarea with wrap="off" on one line, where it scrolled to', async () => {
    const field = frame().locator('#nowrap')
    await field.evaluate((el: HTMLTextAreaElement) => { el.scrollLeft = el.scrollWidth })
    await highlight(field, { text: 'TARGET' })
    const box = payload(steps, HIGHLIGHT_TITLE_PREFIX)
    const area = (await field.boundingBox())!
    expect(box.x + box.width).toBeCloseTo(area.x + area.width, -1)
    expect(box.y).toBeCloseTo(area.y, -1)
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
