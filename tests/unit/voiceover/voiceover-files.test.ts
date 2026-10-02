import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { generateVoiceover } from '../../../src/voiceover/voiceover-processor'
import { WavWriter, wavSampleCount } from '../../../src/voiceover/wav'
import type { TtsProvider } from '../../../src/types/voiceover'
import type { SubtitledTrace } from '../../../src/types/subtitle'

// The processor's handling of the files a provider hands back, and of failures.
let root: string
let fixtures: string

const cues = (n: number) => ({
  subtitles: Array.from({ length: n }, (_, k) => ({ index: k + 1, startMs: 500 + k * 2000, endMs: 500 + k * 2000 + 1500, text: 'same line' })),
}) as unknown as SubtitledTrace

/** A provider returning `file` for every text, as a cache does for repeated lines. */
const sameFile = (file: string): TtsProvider => ({
  name: 'same-file',
  async synthesize(texts) { return texts.map(() => ({ path: file, durationMs: 500, format: { sampleRate: 24_000, channels: 1, codec: 'mp3' } })) },
  async isAvailable() { return true },
  async dispose() {},
})

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'recast-vo-files-'))
  fixtures = path.join(root, 'fixtures')
  fs.mkdirSync(fixtures)
})
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }) })

describe('generateVoiceover() and provider files', () => {
  it.each([false, true])('keeps a file shared by several cues and outside tmpDir (normalize: %s)', async (normalize) => {
    const shared = path.join(fixtures, `shared-${normalize}.mp3`)
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000:duration=0.5', '-c:a', 'libmp3lame', shared])
    const tmpDir = path.join(root, `shared-${normalize}`)
    const { voiceover } = await generateVoiceover(cues(3), sameFile(shared), tmpDir, { normalize }, [], 25)
    expect(fs.existsSync(shared)).toBe(true)
    expect(voiceover.entries).toHaveLength(3)
    expect(wavSampleCount(voiceover.audioTrackPath)).toBeGreaterThan(0)
  })

  it('times a streamed WAV by its samples, not its header sizes', async () => {
    // Streaming TTS APIs and `-f wav pipe:` write 0xFFFFFFFF as RIFF and data size
    const streamed = path.join(fixtures, 'streamed.wav')
    fs.writeFileSync(streamed, execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000:duration=0.5', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:']))
    expect(fs.readFileSync(streamed).readUInt32LE(4)).toBe(0xffffffff)
    const { voiceover } = await generateVoiceover(cues(2), sameFile(streamed), path.join(root, 'streamed'), undefined, [], 25)
    for (const e of voiceover.entries) expect(e.spokenEndMs! - e.outputStartMs).toBeCloseTo(500, -1)
  })

  it('removes the files the provider wrote to its workDir, also when it fails', async () => {
    const tmpDir = path.join(root, 'cleanup')
    const written = (dir: string) => {
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, 'voiceover.wav')
      execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000:duration=0.3', file])
      return file
    }
    const writing: TtsProvider = { ...sameFile(''), async synthesize(texts, options) { return sameFile(written(options!.workDir!)).synthesize(texts) } }
    const { voiceover } = await generateVoiceover(cues(3), writing, tmpDir, undefined, [], 25)
    expect(wavSampleCount(voiceover.audioTrackPath)).toBeGreaterThan(0)
    expect(fs.readdirSync(tmpDir)).toEqual(['voiceover.wav'])

    const failing: TtsProvider = { ...sameFile(''), async synthesize(_texts, options) { written(options!.workDir!); throw new Error('quota') } }
    await expect(generateVoiceover(cues(3), failing, tmpDir, undefined, [], 25)).rejects.toThrow('quota')
    expect(fs.readdirSync(tmpDir)).toEqual(['voiceover.wav'])
  })

  it('pads a cue to its window end, also by a few ms', async () => {
    const short = path.join(fixtures, 'short.wav')
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000:duration=1.47', short])
    const { voiceover } = await generateVoiceover(cues(1), sameFile(short), path.join(root, 'pad'), undefined, [], 25)
    expect(voiceover.totalDurationMs).toBe(2000)
  })

  it('keys segment files by position, so repeated SRT indexes do not collide', async () => {
    const lines = cues(2)
    lines.subtitles[1]!.index = 1
    const tone = (hz: number) => {
      const f = path.join(fixtures, `tone-${hz}.mp3`)
      execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${hz}:sample_rate=24000:duration=${hz === 440 ? 0.3 : 0.9}`, '-c:a', 'libmp3lame', f])
      return f
    }
    const files = [tone(440), tone(880)]
    const provider: TtsProvider = { ...sameFile(''), async synthesize(texts) { return texts.map((_, i) => ({ path: files[i]!, durationMs: 0, format: { sampleRate: 24_000, channels: 1, codec: 'mp3' } })) } }
    const { voiceover } = await generateVoiceover(lines, provider, path.join(root, 'dup-index'), undefined, [], 25)
    const lengths = voiceover.entries.map((e) => e.spokenEndMs! - e.outputStartMs)
    expect(lengths[0]).toBeLessThan(500)
    expect(lengths[1]).toBeGreaterThan(800)
  })
})

describe('generateVoiceover() failures', () => {
  it('reports ffmpeg diagnostics when a segment cannot be decoded', async () => {
    const garbage = path.join(fixtures, 'garbage.mp3')
    fs.writeFileSync(garbage, 'not audio')
    await expect(generateVoiceover(cues(1), sameFile(garbage), path.join(root, 'garbage'), undefined, [], 25))
      .rejects.toThrow(/ffmpeg failed \(exit \d+\)/)
  })

  const tone = (name: string) => {
    const file = path.join(fixtures, name)
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000:duration=0.3', '-c:a', 'libmp3lame', file])
    return file
  }

  it('leaves no segment files behind after a run', async () => {
    const tmpDir = path.join(root, 'no-segs')
    await generateVoiceover(cues(3), sameFile(tone('segs.mp3')), tmpDir, undefined, [], 25)
    expect(fs.readdirSync(tmpDir)).toEqual(['voiceover.wav'])
  })

  it('rethrows a failure while writing the track and leaves no track or segment files', async () => {
    const tmpDir = path.join(root, 'append-fails')
    const real = WavWriter.prototype.append
    let calls = 0
    const spy = vi.spyOn(WavWriter.prototype, 'append').mockImplementation(function (this: WavWriter, file: string) {
      if (++calls === 2) throw new Error('disk full')
      return real.call(this, file)
    })
    try {
      await expect(generateVoiceover(cues(3), sameFile(tone('fails.mp3')), tmpDir, undefined, [], 25)).rejects.toThrow('disk full')
    } finally {
      spy.mockRestore()
    }
    expect(fs.readdirSync(tmpDir)).toEqual([])
  })
})
