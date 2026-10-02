import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { findPageVideos, findSourceVideo, testVideoPages } from '../../../src/pages/page-videos'
import { PAGES_TITLE_PREFIX } from '../../../src/helpers'

let dir: string
const touch = (...parts: string[]): string => {
  const file = path.join(dir, ...parts)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '')
  return file
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recast-videos-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('findSourceVideo', () => {
  it('prefers video.webm over video-1.webm, which sorts first', () => {
    touch('video-1.webm')
    const main = touch('video.webm')
    expect(findSourceVideo(dir)).toBe(main)
  })

  it('orders numbered videos numerically', () => {
    touch('video-10.webm')
    const second = touch('video-2.webm')
    expect(findSourceVideo(dir)).toBe(second)
  })

  it('prefers a plain video over page@ files', () => {
    touch('page@0a.webm')
    const plain = touch('recording.webm')
    expect(findSourceVideo(dir)).toBe(plain)
  })

  it('searches subdirectories, skipping dot-directories', () => {
    touch('.recast-tmp', 'video.webm')
    const nested = touch('test-1', 'video.webm')
    expect(findSourceVideo(dir)).toBe(nested)
  })
})

describe('findPageVideos', () => {
  it('maps page@ videos to their pageId, also in subdirectories', () => {
    const a = touch('page@66f72018fa700308f63e12c45e770d04.webm')
    const b = touch('videos', 'page@501657f4dd14a34c1d6eb2ef30287acf.webm')
    touch('video.webm')
    expect(findPageVideos(dir)).toEqual(new Map([
      ['page@66f72018fa700308f63e12c45e770d04', a],
      ['page@501657f4dd14a34c1d6eb2ef30287acf', b],
    ]))
  })
})

describe('Playwright Test videos', () => {
  it('maps video.webm and video-N.webm in the trace folder to the listed pages; page@ files win', () => {
    const main = touch('video.webm')
    touch('video-1.webm')
    const tab = touch('page@bb.webm')
    touch('video-2.webm')
    touch('sub', 'video-3.webm')
    expect(findPageVideos(dir, ['page@aa', 'page@bb', null, 'page@dd'])).toEqual(new Map([['page@bb', tab], ['page@aa', main]]))
  })

  it('reads the last recastPageVideos step', () => {
    const step = (ids: unknown) => ({ title: `${PAGES_TITLE_PREFIX}${JSON.stringify(ids)}` })
    expect(testVideoPages([step(['page@aa']), { title: 'Click' }, step(['page@bb', 7])])).toEqual(['page@bb', null])
    expect(testVideoPages([{ title: `${PAGES_TITLE_PREFIX}{` }])).toBeUndefined()
    expect(testVideoPages([{ title: 'Click' }])).toBeUndefined()
  })
})
