import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { PipelineExecutor } from '../../../src/pipeline/executor'
import { Recast } from '../../../src/index'
import { NARRATE_TITLE_PREFIX, WAIT_FOR_NARRATION_TITLE_PREFIX, ZOOM_TITLE_PREFIX } from '../../../src/helpers'
import type { SubtitleEntry } from '../../../src/types/subtitle'

// Steps and markers as Playwright Test writes them to test.trace: nested
// test.step entries linked by parentId, the zoom inside a helper step.
let dir: string
const step = (callId: string, title: string, startTime: number, parentId?: string) => {
  return [
    { type: 'before', callId, class: 'Test', method: 'test.step', title, params: {}, startTime, ...(parentId ? { parentId } : {}) },
    { type: 'after', callId, endTime: startTime + 1 },
  ]
}
const zoom = `${ZOOM_TITLE_PREFIX}{"x":0.8,"y":0.5,"level":1.3}`

async function subtitlesOf(name: string, events: object[]): Promise<SubtitleEntry[]> {
  const out = path.join(dir, name)
  fs.mkdirSync(out)
  fs.writeFileSync(path.join(out, 'video.webm'), '')
  fs.writeFileSync(path.join(out, 'trace.zip'), zipSync({
    'test.trace': strToU8(events.map((e) => JSON.stringify(e)).join('\n')),
    '0-trace.trace': strToU8(JSON.stringify({ type: 'screencast-frame', pageId: 'page@1', sha1: 'f', width: 1280, height: 720, timestamp: 0 })),
  }))
  const stages = Recast.from(out).parse().subtitlesFromTrace().getStages()
  const state = await new PipelineExecutor(out, stages).runStages()
  state.parsed?.frameReader.dispose()
  return state.subtitled!.subtitles
}

beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recast-zoom-steps-')) })
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('subtitlesFromTrace(): zoom stays in its scene', () => {
  it('drops a zoom whose step has no narration left, instead of giving it to the next step', async () => {
    const subs = await subtitlesOf('drop', [
      ...step('test.step@1', '5. publish', 900),
      ...step('test.step@2', `${NARRATE_TITLE_PREFIX}We publish it.`, 1000, 'test.step@1'),
      ...step('test.step@3', WAIT_FOR_NARRATION_TITLE_PREFIX, 1500, 'test.step@1'),
      ...step('test.step@4', 'zoomDialog', 2000, 'test.step@1'),
      ...step('test.step@5', zoom, 2001, 'test.step@4'),
      ...step('test.step@6', '6. connect', 3000),
      ...step('test.step@7', `${NARRATE_TITLE_PREFIX}Now we connect.`, 3001, 'test.step@6'),
    ])
    expect(subs.map((s) => [s.text, s.zoom?.level])).toEqual([['We publish it.', undefined], ['Now we connect.', undefined]])
  })

  it('gives a zoom set before its narrate() to that narration, past a cue of the previous step that is still open', async () => {
    const subs = await subtitlesOf('mirror', [
      ...step('test.step@1', '5. publish', 900),
      ...step('test.step@2', `${NARRATE_TITLE_PREFIX}We publish it.`, 1000, 'test.step@1'),
      ...step('test.step@3', '6. connect', 2900),
      ...step('test.step@4', zoom, 2950, 'test.step@3'),
      ...step('test.step@5', `${NARRATE_TITLE_PREFIX}Now we connect.`, 3000, 'test.step@3'),
    ])
    expect(subs.map((s) => [s.text, s.zoom?.level])).toEqual([['We publish it.', undefined], ['Now we connect.', 1.3]])
    expect(subs[1]!.zoom?.sceneId).toBe('test.step@3')
  })

  it('keeps a zoom in a helper step with a narration in the test body', async () => {
    // Page-object methods wrapped in test.step, narration in the body: no scenes.
    const subs = await subtitlesOf('helper', [
      ...step('test.step@1', `${NARRATE_TITLE_PREFIX}We open the dialog.`, 1000),
      ...step('test.step@2', 'open dialog', 1500),
      ...step('test.step@3', zoom, 1600, 'test.step@2'),
      ...step('test.step@4', `${NARRATE_TITLE_PREFIX}And close it.`, 3000),
    ])
    expect(subs.map((s) => [s.text, s.zoom?.level])).toEqual([['We open the dialog.', 1.3], ['And close it.', undefined]])
  })

  it('keeps a zoom in a helper step with narrations in say() wrapper steps', async () => {
    const subs = await subtitlesOf('say', [
      ...step('test.step@1', 'say', 1000),
      ...step('test.step@2', `${NARRATE_TITLE_PREFIX}We open the dialog.`, 1001, 'test.step@1'),
      ...step('test.step@3', 'open dialog', 1500),
      ...step('test.step@4', zoom, 1600, 'test.step@3'),
      ...step('test.step@5', 'say', 3000),
      ...step('test.step@6', `${NARRATE_TITLE_PREFIX}And close it.`, 3001, 'test.step@5'),
    ])
    expect(subs.map((s) => [s.text, s.zoom?.level])).toEqual([['We open the dialog.', 1.3], ['And close it.', undefined]])
  })

  it('gives a zoom in a helper step between two scenes to the next scene', async () => {
    // By design: a zoom outside any scene matches any narration, which keeps
    // scene-less layouts and say() wrappers working
    const subs = await subtitlesOf('between', [
      ...step('test.step@1', '5. publish', 900),
      ...step('test.step@2', `${NARRATE_TITLE_PREFIX}We publish it.`, 1000, 'test.step@1'),
      ...step('test.step@3', WAIT_FOR_NARRATION_TITLE_PREFIX, 1500, 'test.step@1'),
      ...step('test.step@4', 'zoomDialog', 2000),
      ...step('test.step@5', zoom, 2001, 'test.step@4'),
      ...step('test.step@6', '6. connect', 3000),
      ...step('test.step@7', `${NARRATE_TITLE_PREFIX}Now we connect.`, 3001, 'test.step@6'),
    ])
    expect(subs.map((s) => [s.text, s.zoom?.level])).toEqual([['We publish it.', undefined], ['Now we connect.', 1.3]])
    expect(subs[1]!.zoom?.sceneId).toBeUndefined()
  })
})
