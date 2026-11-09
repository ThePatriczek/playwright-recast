import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { PipelineExecutor } from '../../../src/pipeline/executor'
import { Recast } from '../../../src/index'
import { NARRATE_TITLE_PREFIX } from '../../../src/helpers'
import type { TtsProvider } from '../../../src/types/voiceover'

let dir: string
const step = (callId: string, title: string, startTime: number) => [
  { type: 'before', callId, class: 'Test', method: 'test.step', title, params: {}, startTime },
  { type: 'after', callId, endTime: startTime + 1 },
]

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recast-speech-early-'))
  fs.writeFileSync(path.join(dir, 'video.webm'), '')
  fs.writeFileSync(path.join(dir, 'trace.zip'), zipSync({
    'test.trace': strToU8([...step('s@1', `${NARRATE_TITLE_PREFIX}one`, 1000), ...step('s@2', `${NARRATE_TITLE_PREFIX}two`, 2000)].map((e) => JSON.stringify(e)).join('\n')),
    '0-trace.trace': strToU8(JSON.stringify({ type: 'screencast-frame', pageId: 'page@1', sha1: 'f', width: 1280, height: 720, timestamp: 0 })),
  }))
})
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('voiceover() synthesis runs beside the other stages', () => {
  it('prewarms at the start, synthesizes the final texts before later stages, and stops both when a stage fails', async () => {
    const events: string[] = []
    let signal: AbortSignal | undefined
    const provider: TtsProvider = {
      name: 'recording',
      prewarm() {
        events.push('prewarm')
        return () => { events.push('release') }
      },
      async synthesize(texts, options) {
        events.push(`synthesize ${texts.join(',')}`)
        signal = options?.signal
        // Runs until aborted, like a long synthesis
        return new Promise((_, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
      },
      async isAvailable() { return true },
      async dispose() {},
    }
    const stages = Recast.from(dir).parse()
      .subtitlesFromTrace()
      .textProcessing({ transform: (t) => t.toUpperCase() })
      // Fails after synthesis started, before voiceover() awaits it
      .intro({ path: path.join(dir, 'missing.mp4') })
      .voiceover(provider)
      .getStages()

    await expect(new PipelineExecutor(dir, stages).runStages()).rejects.toThrow(/Intro video not found/)
    expect(events).toEqual(['prewarm', 'synthesize ONE,TWO', 'release'])
    expect(signal?.aborted).toBe(true)
    expect(fs.readdirSync(path.join(dir, '.recast-vo-tmp'))).toEqual([])
  })
})
