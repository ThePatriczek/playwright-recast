import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { WavWriter, wavData, wavHeader, wavSampleCount } from '../../../src/voiceover/wav'

let dir: string
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recast-wav-')) })
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const probe = (file: string) => execFileSync('ffprobe', [
  '-v', 'error', '-show_entries', 'stream=sample_rate,channels,duration_ts', '-of', 'csv=p=0', file,
]).toString().trim()

describe('WavWriter', () => {
  it('writes silence and appended WAV data sample-exact, readable by ffmpeg', () => {
    const tone = path.join(dir, 'tone.wav')
    // ffmpeg writes a LIST chunk before data: append() must skip it
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000:duration=0.5', '-c:a', 'pcm_s16le', tone])
    const out = path.join(dir, 'track.wav')
    const track = new WavWriter(out, 24_000, 1)
    track.silence(1201)
    expect(track.append(tone)).toBe(12_000)
    track.silence(3)
    track.close()

    expect(track.samples).toBe(13_204)
    expect(wavSampleCount(out)).toBe(13_204)
    expect(probe(out)).toBe('24000,1,13204')
    const { offset } = wavData(out)
    const pcm = fs.readFileSync(out)
    expect(pcm.readInt16LE(offset + 1200 * 2)).toBe(0)
    expect(pcm.subarray(offset + 1201 * 2, offset + 13_201 * 2).some((b) => b !== 0)).toBe(true)
  })

  it('refuses a WAV in another format', () => {
    const stereo = path.join(dir, 'stereo.wav')
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=stereo', '-t', '0.1', '-c:a', 'pcm_s16le', stereo])
    const track = new WavWriter(path.join(dir, 'mono.wav'), 24_000, 1)
    expect(() => track.append(stereo)).toThrow(/format differs/)
    track.close()
  })
})

describe('wavData()', () => {
  it('reads the data size of an RF64 file from its ds64 chunk', () => {
    // Header of a file past 4 GiB, with its sizes in ds64
    const header = Buffer.alloc(80)
    header.write('RF64', 0); header.writeUInt32LE(0xffffffff, 4); header.write('WAVE', 8)
    header.write('ds64', 12); header.writeUInt32LE(28, 16)
    header.writeBigUInt64LE(5_000_000_072n, 20); header.writeBigUInt64LE(5_000_000_000n, 28); header.writeBigUInt64LE(2_500_000_000n, 36)
    header.write('fmt ', 48); header.writeUInt32LE(16, 52); header.writeUInt16LE(1, 56); header.writeUInt16LE(1, 58)
    header.writeUInt32LE(48_000, 60); header.writeUInt32LE(96_000, 64); header.writeUInt16LE(2, 68); header.writeUInt16LE(16, 70)
    header.write('data', 72); header.writeUInt32LE(0xffffffff, 76)
    const file = path.join(dir, 'rf64.wav')
    fs.writeFileSync(file, header)
    expect(wavData(file)).toMatchObject({ offset: 80, bytes: 5_000_000_000, blockAlign: 2 })
  })
})

describe('wavHeader()', () => {
  it('switches to RF64 past 4 GiB, and wavData() reads it back', () => {
    const file = path.join(dir, 'big-header.wav')
    fs.writeFileSync(file, wavHeader(6_000_000_000, 48_000, 2))
    expect(fs.readFileSync(file).toString('ascii', 0, 4)).toBe('RF64')
    expect(wavData(file)).toEqual({ offset: 80, bytes: 6_000_000_000, blockAlign: 4, formatTag: 1, sampleRate: 48_000, bitsPerSample: 16 })
  })

  it('stays RIFF below 4 GiB', () => {
    const header = wavHeader(1000, 24_000, 1)
    expect(header.toString('ascii', 0, 4)).toBe('RIFF')
    expect(header.readUInt32LE(4)).toBe(1072)
    expect(header.readUInt32LE(76)).toBe(1000)
  })
})

describe('WavWriter.append() input checks', () => {
  const tone = (name: string, rate: number, codec = 'pcm_s16le', channels = 'mono') => {
    const file = path.join(dir, name)
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${rate}:duration=0.1`, '-ac', channels === 'mono' ? '1' : '2', '-c:a', codec, file])
    return file
  }

  it('refuses another sample rate or sample format with the same frame size', () => {
    const track = new WavWriter(path.join(dir, 'checks.wav'), 24_000, 1)
    expect(() => track.append(tone('rate.wav', 48_000))).toThrow(/format differs/)
    // f32 mono and s16 stereo have the same 4-byte frames as each other
    const stereo = new WavWriter(path.join(dir, 'checks2.wav'), 24_000, 2)
    expect(() => stereo.append(tone('f32.wav', 24_000, 'pcm_f32le'))).toThrow(/format differs/)
    track.close()
    stereo.close()
  })

  it('takes whole frames of a data chunk with a stray byte', () => {
    const odd = path.join(dir, 'odd.wav')
    const pcm = Buffer.from([1, 0, 2, 0, 3])
    const header = wavHeader(4, 24_000, 1)
    header.writeUInt32LE(5, 76)
    fs.writeFileSync(odd, Buffer.concat([header, pcm, Buffer.alloc(1)]))
    const out = path.join(dir, 'odd-track.wav')
    const track = new WavWriter(out, 24_000, 1)
    expect(track.append(odd)).toBe(2)
    track.silence(1)
    track.close()
    expect(wavSampleCount(out)).toBe(3)
    expect(probe(out)).toBe('24000,1,3')
  })

  it('abort() removes a partly written file', () => {
    const out = path.join(dir, 'aborted.wav')
    const track = new WavWriter(out, 24_000, 1)
    track.silence(10)
    expect(() => track.append(path.join(dir, 'missing.wav'))).toThrow()
    track.abort()
    expect(fs.existsSync(out)).toBe(false)
  })
})

describe('WavWriter cleanup', () => {
  it('abort() removes the file and is safe after close()', () => {
    const out = path.join(dir, 'aborted.wav')
    const track = new WavWriter(out, 24_000, 1)
    track.silence(10)
    track.close()
    expect(() => track.abort()).not.toThrow()
    expect(fs.existsSync(out)).toBe(false)
  })
})
