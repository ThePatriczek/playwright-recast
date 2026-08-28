import { describe, it, expect } from 'vitest'
import { ffmpeg } from '../../../src/render/renderer'

/** ffmpeg echoes the offending expression on every parse error, so a big
 *  filter produces megabytes of stderr — past Node's default 1MB maxBuffer. */
function hugeBogusExpression(levels: number): string {
  let expr = '0'
  for (let i = 0; i < levels; i++) {
    expr = `if(between(t\\,${i}.0000\\,${i + 5}.0000)\\,st(0\\,(t-${i}.0000)/0.2500)\;` +
      `${1000 + i}+(50)*(3*ld(0)*ld(0)-2*ld(0)*ld(0)*ld(0))\\,${expr})`
  }
  return expr
}

describe('ffmpeg()', () => {
  it('reports ffmpeg\'s own diagnostics when it floods stderr', () => {
    let message = ''
    try {
      ffmpeg([
        '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=5:d=1',
        '-vf', `drawbox=x='${hugeBogusExpression(200)}':y=0:w=10:h=10:color=red`,
        '-f', 'null', '-',
      ])
      throw new Error('expected ffmpeg() to throw')
    } catch (error) {
      message = (error as Error).message
    }

    expect(message).not.toContain('ENOBUFS')
    expect(message).toContain("Missing ')' or too many args")

    const lines = message.split('\n')
    // Exit status, both ends of the output, and a marker for what was dropped.
    expect(lines[0]).toMatch(/^ffmpeg failed \(exit \d+\)/)
    expect(message).toContain('ffmpeg version')
    expect(message).toContain('Conversion failed')
    expect(message).toMatch(/… \d+ line\(s\) omitted …/)
    // Every kept line is capped, so one echoed 40KB expression cannot bury it.
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(241)
    expect(lines.length).toBeLessThanOrEqual(30)
  })

  it('reports the exit status and the tail of ffmpeg output for ordinary failures', () => {
    expect(() => ffmpeg(['-y', '-i', '/nonexistent/input.mp4', '-f', 'null', '-']))
      .toThrow(/No such file or directory/)
  })
})
