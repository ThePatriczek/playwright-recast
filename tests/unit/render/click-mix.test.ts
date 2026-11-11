import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { generateClickSoundTrack } from '../../../src/click-effect/sound-track'
import { ffmpeg, mixClickIntoVoiceover } from '../../../src/render/renderer'

const VOICE_SEC = 4
const CLICK_SEC = 0.5
const CLICK_AT_SEC = 0.3
const CLICK_END = CLICK_AT_SEC + CLICK_SEC
const TAIL_START = 2

let dir: string

/** Overall RMS level in dB of `[from, to)` seconds of an audio file. */
function rmsDb(file: string, from: number, to: number): number {
  const proc = spawnSync('ffmpeg', [
    '-hide_banner', '-nostats', '-ss', String(from), '-t', String(to - from), '-i', file,
    '-af', 'astats', '-f', 'null', '-',
  ], { encoding: 'utf8' })
  const overall = proc.stderr.split('Overall')[1] ?? ''
  const m = overall.match(/RMS level dB:\s*(-?[\d.]+|-inf)/)
  return m ? parseFloat(m[1]!) : -Infinity
}

describe('mixClickIntoVoiceover', () => {
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recast-click-mix-'))
    ffmpeg([
      '-y', '-f', 'lavfi', '-i', `sine=f=440:d=${VOICE_SEC}:r=24000`,
      '-af', 'aformat=channel_layouts=stereo', '-c:a', 'pcm_s16le', path.join(dir, 'voice.wav'),
    ])
    // The click track as the pipeline makes it: a stereo source through the real generator
    ffmpeg([
      '-y', '-f', 'lavfi', '-i', `sine=f=1000:d=${CLICK_SEC}:r=48000`,
      '-af', 'aformat=channel_layouts=stereo', path.join(dir, 'click-source.wav'),
    ])
    generateClickSoundTrack({
      clicks: [{ videoTimeMs: CLICK_AT_SEC * 1000 }],
      soundPath: path.join(dir, 'click-source.wav'),
      outputPath: path.join(dir, 'click.mp3'),
      volume: 1,
    })
  })
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('keeps the voiceover intact after a shorter stereo click track ends', () => {
    const out = path.join(dir, 'mixed.wav')
    mixClickIntoVoiceover(path.join(dir, 'voice.wav'), path.join(dir, 'click.mp3'), out)

    // Right after the click ends, where the bug cut the voice, and the late tail
    for (const [from, to] of [[CLICK_END + 0.1, TAIL_START], [TAIL_START, VOICE_SEC - 0.2]] as const) {
      const expectedDb = rmsDb(path.join(dir, 'voice.wav'), from, to)
      const mixedDb = rmsDb(out, from, to)
      expect(mixedDb, `${from}-${to} s`).toBeGreaterThan(expectedDb - 1)
      expect(mixedDb, `${from}-${to} s`).toBeLessThan(expectedDb + 1)
    }
  })

  it('output length follows the voiceover', () => {
    const out = path.join(dir, 'mixed-len.wav')
    mixClickIntoVoiceover(path.join(dir, 'voice.wav'), path.join(dir, 'click.mp3'), out)
    const dur = parseFloat(execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out,
    ], { encoding: 'utf8' }))
    expect(dur).toBeGreaterThan(VOICE_SEC - 0.1)
    expect(dur).toBeLessThan(VOICE_SEC + 0.1)
  })
})
