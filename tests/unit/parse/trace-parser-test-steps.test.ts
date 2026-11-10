import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { parseTrace } from '../../../src/parse/trace-parser'

let dir: string
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recast-trace-steps-')) })
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const lines = (events: object[]) => strToU8(events.map((e) => JSON.stringify(e)).join('\n'))
// Playwright Test writes each API call twice under one callId: the library's
// event (class Page, real params) and the runner's step (class Test, pw:api).
const library = lines([
  { type: 'before', callId: 'c@1', startTime: 1000.2, class: 'Page', method: 'mouseMove', params: { x: 10, y: 20, steps: 30 } },
  { type: 'input', callId: 'c@1', point: { x: 10, y: 20 } },
  { type: 'after', callId: 'c@1', endTime: 3000 },
])
const runner = lines([
  { type: 'before', callId: 'c@1', startTime: 1000, class: 'Test', method: 'pw:api', title: 'Mouse move', params: { x: '10', y: '20' } },
  { type: 'after', callId: 'c@1', endTime: 3000.5 },
])

describe('parseTrace(): API calls recorded by library and runner', () => {
  for (const [name, files] of [
    ['runner last', { '0-trace.trace': library, 'test.trace': runner }],
    ['runner first', { 'test.trace': runner, '0-trace.trace': library }],
  ] as const) {
    it(`keeps the library's method and params, and the runner's title (${name})`, async () => {
      const file = path.join(dir, `${name.replace(' ', '-')}.zip`)
      fs.writeFileSync(file, zipSync(files))
      const trace = await parseTrace(file)
      trace.frameReader.dispose()
      expect(trace.actions).toHaveLength(1)
      expect(trace.actions[0]).toMatchObject({
        class: 'Page', method: 'mouseMove', params: { steps: 30 }, title: 'Mouse move', startTime: 1000.2, endTime: 3000,
      })
    })
  }
})
