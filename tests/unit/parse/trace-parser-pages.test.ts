import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { parseTrace } from '../../../src/parse/trace-parser'

const MAIN = 'page@66f72018fa700308f63e12c45e770d04'
const POPUP = 'page@501657f4dd14a34c1d6eb2ef30287acf'
const snapshot = (pageId: string, frameUrl: string, timestamp: number, isMainFrame = true) =>
  ({ type: 'frame-snapshot', snapshot: { pageId, frameUrl, isMainFrame, timestamp } })

let dir: string
const writeTrace = (name: string, events: object[]): string => {
  const file = path.join(dir, name)
  fs.writeFileSync(file, zipSync({ 'trace.trace': strToU8(events.map((e) => JSON.stringify(e)).join('\n')) }))
  return file
}

beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recast-pages-trace-')) })
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('parseTrace: pages and URLs', () => {
  it('reads page lifetimes and main-frame URLs, deduplicated', async () => {
    const trace = await parseTrace(writeTrace('a.zip', [
      { type: 'context-options', browserName: 'chromium', options: { viewport: { width: 1280, height: 720 } } },
      { type: 'event', time: 334, class: 'BrowserContext', method: 'page', params: { pageId: MAIN } },
      snapshot(MAIN, 'about:blank', 338),
      snapshot(MAIN, 'http://127.0.0.1:4000/main', 358),
      snapshot(MAIN, 'http://127.0.0.1:4000/main', 359),
      snapshot(MAIN, 'https://editor.example/frame', 360, false),
      { type: 'event', time: 1214, class: 'BrowserContext', method: 'page', params: { pageId: POPUP, openerPageId: MAIN } },
      snapshot(POPUP, 'http://localhost:4000/popup', 1220),
      { type: 'event', time: 1954, class: 'BrowserContext', method: 'pageClosed', params: { pageId: POPUP } },
    ]))
    expect(trace.pages).toEqual([
      { pageId: MAIN, contextId: 'trace.trace', viewport: { width: 1280, height: 720 } },
      { pageId: POPUP, openerPageId: MAIN, closedAt: 1954, contextId: 'trace.trace', viewport: { width: 1280, height: 720 } },
    ])
    expect(trace.pageUrls).toEqual([
      { pageId: MAIN, url: 'about:blank', timestamp: 338 },
      { pageId: MAIN, url: 'http://127.0.0.1:4000/main', timestamp: 358 },
      { pageId: POPUP, url: 'http://localhost:4000/popup', timestamp: 1220 },
    ])
    trace.frameReader.dispose()
  })

  it('tells pages of different contexts apart by their trace file', async () => {
    const file = path.join(dir, 'c.zip')
    const line = (pageId: string) => JSON.stringify({ type: 'event', time: 1, class: 'BrowserContext', method: 'page', params: { pageId } })
    fs.writeFileSync(file, zipSync({ '0-trace.trace': strToU8(line(MAIN)), '1-trace.trace': strToU8(line(POPUP)) }))
    const trace = await parseTrace(file)
    expect(trace.pages!.map((p) => [p.pageId, p.contextId])).toEqual([[MAIN, '0-trace.trace'], [POPUP, '1-trace.trace']])
    trace.frameReader.dispose()
  })

  it('falls back to goto() targets without snapshots', async () => {
    const trace = await parseTrace(writeTrace('b.zip', [
      { type: 'before', callId: 'c1', title: 'Navigate', class: 'Frame', method: 'goto', params: { url: 'https://a.example/' }, startTime: 10, pageId: MAIN },
      { type: 'after', callId: 'c1', endTime: 80 },
    ]))
    expect(trace.pageUrls).toEqual([{ pageId: MAIN, url: 'https://a.example/', timestamp: 80 }])
    trace.frameReader.dispose()
  })

  it('knows a page created before tracing started by its frames and calls', async () => {
    const trace = await parseTrace(writeTrace('early.zip', [
      { type: 'context-options', browserName: 'chromium', options: { viewport: { width: 800, height: 600 } } },
      { type: 'screencast-frame', pageId: MAIN, sha1: 'f', width: 800, height: 600, timestamp: 500 },
      { type: 'before', callId: 'c1', title: 'Click', class: 'Frame', method: 'click', params: {}, startTime: 600, pageId: MAIN },
      { type: 'after', callId: 'c1', endTime: 650 },
      // closed during tracing: its close must count although it had no page event
      { type: 'event', time: 900, class: 'BrowserContext', method: 'pageClosed', params: { pageId: MAIN } },
    ]))
    expect(trace.pages).toEqual([{ pageId: MAIN, contextId: 'trace.trace', viewport: { width: 800, height: 600 }, closedAt: 900 }])
    trace.frameReader.dispose()
  })

  it('resolves relative goto() targets against the baseURL', async () => {
    const trace = await parseTrace(writeTrace('base.zip', [
      { type: 'context-options', browserName: 'chromium', options: { baseURL: 'https://app.example.com/' } },
      { type: 'event', time: 1, class: 'BrowserContext', method: 'page', params: { pageId: MAIN } },
      { type: 'before', callId: 'c1', title: 'Navigate', class: 'Frame', method: 'goto', params: { url: '/login' }, startTime: 10, pageId: MAIN },
      { type: 'after', callId: 'c1', endTime: 80 },
    ]))
    expect(trace.pageUrls).toEqual([{ pageId: MAIN, url: 'https://app.example.com/login', timestamp: 80 }])
    trace.frameReader.dispose()
  })
})

describe('parseTrace: Playwright 1.63 traces', () => {
  it("takes an action's page from its snapshots, 'before' having none", async () => {
    const trace = await parseTrace(writeTrace('pw163-actions.zip', [
      { type: 'context-options', browserName: 'chromium', options: { viewport: { width: 640, height: 360 } } },
      { type: 'before', callId: 'call@1', startTime: 100, class: 'Frame', method: 'click', params: {} },
      { type: 'frame-snapshot', snapshot: { callId: 'call@1', pageId: POPUP, frameUrl: 'http://x.test/', isMainFrame: true, timestamp: 101 } },
      { type: 'after', callId: 'call@1', endTime: 120 },
      { type: 'before', callId: 'call@2', startTime: 200, class: 'Frame', method: 'click', params: {}, pageId: MAIN },
      { type: 'frame-snapshot', snapshot: { callId: 'call@2', pageId: POPUP, frameUrl: 'http://x.test/', isMainFrame: true, timestamp: 201 } },
      { type: 'after', callId: 'call@2', endTime: 220 },
    ]))
    expect(trace.actions.map((a) => a.pageId)).toEqual([POPUP, MAIN])
    trace.frameReader.dispose()
  })

  it("reads a screencast frame's image from its file", async () => {
    const file = path.join(dir, 'pw163-frames.zip')
    const image = strToU8('jpeg bytes')
    fs.writeFileSync(file, zipSync({
      'trace.trace': strToU8(JSON.stringify({ type: 'screencast-frame', pageId: MAIN, file: `screencast/${MAIN}-1.jpeg`, width: 640, height: 360, timestamp: 100 })),
      [`screencast/${MAIN}-1.jpeg`]: image,
    }))
    const trace = await parseTrace(file)
    expect([...await trace.frameReader.readFrame(trace.frames[0]!.sha1)]).toEqual([...image])
    trace.frameReader.dispose()
  })
})
