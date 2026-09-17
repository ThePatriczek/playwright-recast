import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { renderVideo, type RenderableTrace } from '../../../src/render/renderer.js'
import { toMonotonic } from '../../../src/types/trace.js'

it('removes a hidden interval from the actual video when retained scenes all play at 1x', () => {
  const directory = mkdtempSync(join(tmpdir(), 'recast-realtime-cuts-'))
  try {
    const source = join(directory, 'source.mp4')
    const output = join(directory, 'output.mp4')
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', "color=c=red:s=320x180:r=25:d=3,drawbox=x=0:y=0:w=320:h=180:color=green:t=fill:enable='between(t,1,2)',drawbox=x=0:y=0:w=320:h=180:color=blue:t=fill:enable='gte(t,2)'", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source])
    const trace: RenderableTrace = {
      metadata: { browserName: 'chromium', platform: 'test', viewport: { width: 320, height: 180 }, startTime: toMonotonic(0), endTime: toMonotonic(3000), wallTime: 0 },
      frames: [{ sha1: 'unused', timestamp: toMonotonic(0), pageId: 'page', width: 320, height: 180 }],
      actions: [], resources: [], events: [], cursorPositions: [],
      frameReader: { readFrame: async () => { throw new Error('No frame read expected') }, dispose: () => {} },
      sourceVideoPath: source,
      speedSegments: [
        { originalStart: toMonotonic(0), originalEnd: toMonotonic(1000), outputStart: 0, outputEnd: 1000, speed: 1 },
        { originalStart: toMonotonic(2000), originalEnd: toMonotonic(3000), outputStart: 1000, outputEnd: 2000, speed: 1 },
      ],
    }
    renderVideo(trace, { resolution: { width: 320, height: 180 }, fps: 25 }, output, directory)
    const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', output]).toString())
    expect(duration).toBeCloseTo(2, 1)
    const frame = execFileSync('ffmpeg', ['-v', 'error', '-ss', '1.5', '-i', output, '-frames:v', '1', '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'])
    expect(frame[2]).toBeGreaterThan(200)
    expect(frame[0]).toBeLessThan(30)
    expect(frame[1]).toBeLessThan(30)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 30_000)
