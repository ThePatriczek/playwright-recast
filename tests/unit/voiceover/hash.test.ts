import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { hashValues, hashFile } from '../../../src/voiceover/providers/util/hash.js'

const TMP = path.join(os.tmpdir(), `hash-test-${process.pid}`)
beforeAll(() => fs.mkdirSync(TMP, { recursive: true }))
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }))

describe('hashValues', () => {
  it('is deterministic', () => {
    expect(hashValues(['a', 'b', 'c'])).toBe(hashValues(['a', 'b', 'c']))
  })

  it('returns a 64-char sha256 hex string', () => {
    expect(hashValues(['a'])).toMatch(/^[a-f0-9]{64}$/)
  })

  it('changes when any value changes', () => {
    const base = hashValues(['a', 'b', 'c'])
    expect(hashValues(['x', 'b', 'c'])).not.toBe(base)
    expect(hashValues(['a', 'x', 'c'])).not.toBe(base)
    expect(hashValues(['a', 'b', 'x'])).not.toBe(base)
  })

  it('changes when order changes', () => {
    expect(hashValues(['a', 'b'])).not.toBe(hashValues(['b', 'a']))
  })

  it('does not collide across boundary positions (NUL separator)', () => {
    expect(hashValues(['a', 'bc'])).not.toBe(hashValues(['ab', 'c']))
  })

  it('accepts numbers and booleans', () => {
    expect(hashValues([1, 2, true])).toMatch(/^[a-f0-9]{64}$/)
    expect(hashValues([1, 2, true])).not.toBe(hashValues([1, 2, false]))
  })
})

describe('hashFile', () => {
  it('returns sha256 hex of the file contents', () => {
    const filePath = path.join(TMP, 'sample.bin')
    fs.writeFileSync(filePath, Buffer.from('hello world'))
    // sha256("hello world")
    expect(hashFile(filePath)).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9')
  })

  it('changes when file contents change', () => {
    const a = path.join(TMP, 'a.bin')
    const b = path.join(TMP, 'b.bin')
    fs.writeFileSync(a, 'foo')
    fs.writeFileSync(b, 'bar')
    expect(hashFile(a)).not.toBe(hashFile(b))
  })
})
