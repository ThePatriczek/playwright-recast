import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { probeAudioFormat, planAudioConcat, type AudioFormat } from '../../../src/voiceover/audio-format'

let tmpDir: string
let monoLow: string
let monoHigh: string
let stereoHigh: string
let notAudio: string

/** Generate a short sine wave file forced to the given sample rate/channels. */
function makeSine(outPath: string, sampleRate: number, channels: number): void {
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', 'sine=frequency=440:duration=0.3',
    '-ar', String(sampleRate),
    '-ac', String(channels),
    outPath,
  ])
}

describe('probeAudioFormat (real files)', () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recast-audio-format-probe-'))

    monoLow = path.join(tmpDir, 'mono-low.wav')
    monoHigh = path.join(tmpDir, 'mono-high.wav')
    stereoHigh = path.join(tmpDir, 'stereo-high.wav')
    notAudio = path.join(tmpDir, 'not-audio.txt')

    makeSine(monoLow, 24000, 1)
    makeSine(monoHigh, 44100, 1)
    makeSine(stereoHigh, 44100, 2)
    fs.writeFileSync(notAudio, 'this is not an audio file')
  })

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reads the exact format of a 24000Hz mono file', async () => {
    expect(await probeAudioFormat(monoLow)).toEqual({ sampleRate: 24000, channels: 1 })
  })

  it('reads the exact format of a 44100Hz mono file', async () => {
    expect(await probeAudioFormat(monoHigh)).toEqual({ sampleRate: 44100, channels: 1 })
  })

  it('reads the exact format of a 44100Hz stereo file', async () => {
    expect(await probeAudioFormat(stereoHigh)).toEqual({ sampleRate: 44100, channels: 2 })
  })

  it('returns null, not a throw, for a file with no audio stream', async () => {
    expect(await probeAudioFormat(notAudio)).toBeNull()
  })

  it('returns null, not a throw, for a path that does not exist', async () => {
    expect(await probeAudioFormat(path.join(tmpDir, 'does-not-exist.wav'))).toBeNull()
  })

  it('planAudioConcat reports a mismatch for three genuinely different real probed formats', async () => {
    const formats: Array<AudioFormat | null> = [
      await probeAudioFormat(monoLow),
      await probeAudioFormat(monoHigh),
      await probeAudioFormat(stereoHigh),
    ]
    const plan = planAudioConcat(formats)
    expect(plan.mismatch).toBe(true)
  })

  it('planAudioConcat keeps the format of three copies of the same real probed format', async () => {
    const format = await probeAudioFormat(monoLow)
    const plan = planAudioConcat([format, format, format])
    expect(plan).toEqual({ ...format, mismatch: false })
  })
})
