import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ffmpeg } from '../../../src/render/renderer'

/** Linux caps one argv entry at 128KB, so a big filter graph cannot be inlined. */
const ARGV_LIMIT = 128 * 1024

/** A valid but very long expression: a sum of gated constants. */
function longExpression(bytes: number): string {
  const terms: string[] = []
  let size = 0
  for (let i = 0; terms.length === 0 || size < bytes; i++) {
    const term = `if(between(t\\,${i}.0000\\,${i + 1}.0000)\\,${i % 17}\\,0)`
    terms.push(term)
    size += term.length + 1
  }
  return terms.join('+')
}

const tinySource = ['-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=5:d=0.4']
const filterDirs = () => fs.readdirSync(os.tmpdir()).filter(e => e.startsWith('recast-filter-'))

describe('oversized filter graphs', () => {
  // Linux caps one argv entry (MAX_ARG_STRLEN); macOS bounds the block as a
  // whole, so the inline call can succeed there. The wrapper tests below hold
  // everywhere — this one only documents the limit being worked around.
  it.skipIf(process.platform !== 'linux')('cannot be passed inline — the argv entry exceeds the kernel limit', () => {
    const filter = `[0:v]drawbox=x='${longExpression(ARGV_LIMIT)}':y=0:w=4:h=4:color=white[out]`
    expect(Buffer.byteLength(filter)).toBeGreaterThan(ARGV_LIMIT)

    expect(() => execFileSync('ffmpeg', [
      '-y', ...tinySource, '-filter_complex', filter, '-map', '[out]', '-f', 'null', '-',
    ], { stdio: 'pipe' })).toThrow(/E2BIG/)
  })

  it('renders with a filter_complex larger than the argv limit', () => {
    const before = filterDirs()
    const filter = `[0:v]drawbox=x='${longExpression(ARGV_LIMIT)}':y=0:w=4:h=4:color=white[out]`
    const out = path.join(os.tmpdir(), `recast-large-filter-${process.pid}.mp4`)

    ffmpeg([
      '-y', ...tinySource, '-filter_complex', filter, '-map', '[out]',
      '-c:v', 'libx264', '-preset', 'ultrafast', out,
    ])

    expect(fs.statSync(out).size).toBeGreaterThan(0)
    fs.unlinkSync(out)
    // The spilled filter file is cleaned up after a successful run.
    expect(filterDirs()).toEqual(before)
  })

  it('renders with a -vf filter larger than the argv limit', () => {
    const out = path.join(os.tmpdir(), `recast-large-vf-${process.pid}.mp4`)

    ffmpeg([
      '-y', ...tinySource,
      '-vf', `drawbox=x='${longExpression(ARGV_LIMIT)}':y=0:w=4:h=4:color=white`,
      '-c:v', 'libx264', '-preset', 'ultrafast', out,
    ])

    expect(fs.statSync(out).size).toBeGreaterThan(0)
    fs.unlinkSync(out)
  })

  it('keeps the spilled filter file and names it when ffmpeg fails', () => {
    const filter = `[0:v]drawbox=x='${longExpression(ARGV_LIMIT)}':y=0:w=4:h=4:color=nosuchcolor[out]`
    let message = ''
    try {
      ffmpeg(['-y', ...tinySource, '-filter_complex', filter, '-map', '[out]', '-f', 'null', '-'])
      throw new Error('expected ffmpeg() to throw')
    } catch (error) {
      message = (error as Error).message
    }

    // Read the whole note rather than scanning for a path: a temp dir with a
    // space in it would truncate anything whitespace-delimited.
    const note = message.split('\n').find((line) => line.startsWith('Filter graph'))
    expect(note).toBeDefined()
    const kept = note!.slice(note!.indexOf(': ') + 2).split(', ')
    expect(kept).toHaveLength(1)
    expect(fs.readFileSync(kept[0]!, 'utf8')).toBe(filter)
    fs.rmSync(path.dirname(kept[0]!), { recursive: true, force: true })
  })
})
