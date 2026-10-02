import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { parseTrace } from '../../../src/parse/trace-parser'

let dir: string
const traceWith = (name: string, contextOptions: Record<string, unknown>) => {
  const file = path.join(dir, `${name}.zip`)
  fs.writeFileSync(file, zipSync({
    '0-trace.trace': strToU8([
      { type: 'context-options', browserName: 'chromium', platform: 'linux', ...contextOptions },
      { type: 'screencast-frame', pageId: 'page@1', sha1: 'f', width: 1280, height: 720, timestamp: 51_000 },
    ].map((e) => JSON.stringify(e)).join('\n')),
  }))
  return file
}

beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recast-trace-clock-')) })
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('parseTrace(): wall clock', () => {
  it("keeps the context's wall/monotonic pair", async () => {
    const trace = await parseTrace(traceWith('pair', { wallTime: 1_700_000_000_000, monotonicTime: 50_000 }))
    trace.frameReader.dispose()
    expect(trace.metadata).toMatchObject({ wallTime: 1_700_000_000_000, wallMonotonicTime: 50_000 })
  })

  it('leaves wallMonotonicTime unset when the trace has none', async () => {
    const trace = await parseTrace(traceWith('none', { wallTime: 1_700_000_000_000 }))
    trace.frameReader.dispose()
    expect(trace.metadata.wallMonotonicTime).toBeUndefined()
  })
})
