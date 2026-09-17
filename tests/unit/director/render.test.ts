import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { directVideo } from '../../../src/director/renderer.js'
import { VideoObserver } from '../../../src/director/observers/video.js'
import { parseSrt } from '../../../src/subtitles/srt-parser.js'
import type { DirectorProvider, VisualObserver } from '../../../src/types/director.js'

describe('directed media', () => {
  it('retimes pixels, audio and captions together, including a result hold', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'recast-director-'))
    try {
      const source = join(directory, 'source.mp4')
      const output = join(directory, 'directed.mp4')
      const captions = join(directory, 'source.srt')
      writeFileSync(captions, '1\n00:00:00,000 --> 00:00:03,000\nWaiting\n\n2\n00:00:03,000 --> 00:00:06,000\nResult\n')
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', "color=red:s=320x180:r=30:d=6,drawbox=x=0:y=0:w=iw:h=ih:color=blue:t=fill:enable='gte(t,3)'", '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6', '-i', captions, '-map', '0:v', '-map', '1:a', '-map', '2:s', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-c:s', 'mov_text', source])
      const observer: VisualObserver = { name: 'measured-test-fixture', async observe() {
        return [0, 1000, 2000, 3000, 4000, 5000].map(atMs => ({ atMs, changeFraction: atMs === 3000 ? 0.5 : 0, regions: atMs < 3000 ? [] : [{ id: 'result', x: 0.3, y: 0.3, width: 0.4, height: 0.2, text: 'Report completed', kind: 'text' as const, changed: atMs === 3000 }] }))
      } }
      const provider: DirectorProvider = { name: 'deterministic-test', async decide(request) {
        const timing = request.state.timing as { sourceStartMs: number }
        return { model: 'test', elapsedMs: 0, answers: Object.fromEntries(Object.entries(request.questions).map(([name, question]) => {
          const choice = name === 'camera' ? 'stay' : timing.sourceStartMs === 0 ? 'fast' : 'hold'
          return [name, { choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === choice ? 1 : 0])) }]
        })) }
      } }
      const report = await directVideo(source, output, provider, { goal: 'Skip waiting and show the result', observer, decisionIntervalMs: 3000 }, { fps: 30, embedSubtitles: true }, join(directory, 'work'))
      expect(report.outputDurationMs).toBe(5000)
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,duration', '-of', 'json', output]).toString())
      expect(Number(probe.format.duration)).toBeCloseTo(5, 1)
      const frame = execFileSync('ffmpeg', ['-v', 'error', '-ss', '1.2', '-i', output, '-frames:v', '1', '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'])
      expect(frame[2]).toBeGreaterThan(200)
      expect(frame[0]).toBeLessThan(30)
      const srt = execFileSync('ffmpeg', ['-v', 'error', '-i', output, '-map', '0:s:0', '-f', 'srt', 'pipe:1']).toString()
      expect(parseSrt(srt).map(({ startMs, endMs, text }) => ({ startMs, endMs, text }))).toEqual([{ startMs: 0, endMs: 1000, text: 'Waiting' }, { startMs: 1000, endMs: 5000, text: 'Result' }])
      const sound = execFileSync('ffmpeg', ['-v', 'error', '-ss', '4.3', '-t', '0.3', '-i', output, '-map', '0:a', '-ac', '1', '-f', 's16le', 'pipe:1'])
      let energy = 0
      for (let i = 0; i < sound.length; i += 2) energy += Math.abs(sound.readInt16LE(i))
      expect(energy / (sound.length / 2)).toBeLessThan(5)
      expect(JSON.parse(readFileSync(join(directory, 'directed.director.json'), 'utf8')).decisions).toHaveLength(2)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }, 30000)

  it('observes changes from video pixels without supplied scene coordinates', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'recast-observer-'))
    try {
      const source = join(directory, 'source.mp4')
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', "color=black:s=320x180:r=30:d=2,drawbox=x=200:y=40:w=100:h=100:color=white:t=fill:enable='gte(t,1)'", '-c:v', 'libx264', source])
      const observations = await VideoObserver({ ocr: false }).observe({ videoPath: source, workDir: directory, width: 320, height: 180, durationMs: 2000, sampleIntervalMs: 500, maxFrames: 10 })
      const change = observations.find(observation => observation.changeFraction > 0.1)
      expect(change).toBeDefined()
      expect(change!.atMs).toBe(1000)
      expect(change!.regions[0].x).toBeGreaterThan(0.5)
      expect(change!.regions[0].kind).toBe('change')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }, 30000)
})
