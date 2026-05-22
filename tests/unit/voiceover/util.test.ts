import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveWorkDir } from '../../../src/voiceover/providers/util/resolveWorkDir'
import { writeAudioSegment } from '../../../src/voiceover/providers/util/writeAudioSegment'

const TMP_ROOT = path.join(os.tmpdir(), `recast-util-test-${process.pid}`)

beforeAll(() => fs.mkdirSync(TMP_ROOT, { recursive: true }))
afterAll(() => fs.rmSync(TMP_ROOT, { recursive: true, force: true }))

describe('resolveWorkDir', () => {
  it('returns os.tmpdir() when workDir is undefined', () => {
    const dir = resolveWorkDir(undefined)
    expect(dir).toBe(os.tmpdir())
    expect(fs.existsSync(dir)).toBe(true)
  })

  it('returns the given workDir and creates it if missing', () => {
    const target = path.join(TMP_ROOT, 'new-nested', 'workdir')
    expect(fs.existsSync(target)).toBe(false)

    const dir = resolveWorkDir(target)

    expect(dir).toBe(target)
    expect(fs.existsSync(target)).toBe(true)
    expect(fs.statSync(target).isDirectory()).toBe(true)
  })

  it('is idempotent — calling twice on an existing dir does not throw', () => {
    const target = path.join(TMP_ROOT, 'idempotent')
    expect(() => {
      resolveWorkDir(target)
      resolveWorkDir(target)
    }).not.toThrow()
  })
})

describe('writeAudioSegment', () => {
  it('writes the buffer to <dir>/<prefix>-<uuid>.<ext> with mp3 defaults', async () => {
    const buf = Buffer.from('FAKE_MP3_BYTES')
    const seg = await writeAudioSegment(buf, {
      dir: TMP_ROOT,
      prefix: 'testprov',
      sampleRate: 24000,
    })

    expect(seg.path).toMatch(
      new RegExp(`${path.basename(TMP_ROOT)}/testprov-[0-9a-f-]+\\.mp3$`),
    )
    expect(fs.readFileSync(seg.path)).toEqual(buf)
    expect(seg.durationMs).toBe(0)
    expect(seg.format).toEqual({ sampleRate: 24000, channels: 1, codec: 'mp3' })
  })

  it('honors custom codec, ext, and channels', async () => {
    const buf = Buffer.from('FAKE_WAV')
    const seg = await writeAudioSegment(buf, {
      dir: TMP_ROOT,
      prefix: 'wavprov',
      sampleRate: 48000,
      codec: 'pcm_s16le',
      ext: 'wav',
      channels: 2,
    })

    expect(seg.path.endsWith('.wav')).toBe(true)
    expect(seg.format).toEqual({ sampleRate: 48000, channels: 2, codec: 'pcm_s16le' })
  })

  it('uses codec as the file extension by default', async () => {
    const buf = Buffer.from('OGG')
    const seg = await writeAudioSegment(buf, {
      dir: TMP_ROOT,
      prefix: 'ogg',
      sampleRate: 48000,
      codec: 'opus',
    })

    expect(seg.path.endsWith('.opus')).toBe(true)
    expect(seg.format.codec).toBe('opus')
  })

  it('generates unique paths across successive calls', async () => {
    const buf = Buffer.from('X')
    const a = await writeAudioSegment(buf, { dir: TMP_ROOT, prefix: 'uniq', sampleRate: 24000 })
    const b = await writeAudioSegment(buf, { dir: TMP_ROOT, prefix: 'uniq', sampleRate: 24000 })

    expect(a.path).not.toBe(b.path)
    expect(fs.existsSync(a.path)).toBe(true)
    expect(fs.existsSync(b.path)).toBe(true)
  })
})
