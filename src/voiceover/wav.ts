import * as fs from 'node:fs'

const CHUNK = 1 << 20
/** Shared, never written to: silence for every writer. */
let zeros: Buffer | undefined

const FORMAT_PCM = 1
const FORMAT_EXTENSIBLE = 0xfffe
const HEADER_BYTES = 80

/** Where a WAV file's PCM data sits, and its format. */
export interface WavData {
  offset: number
  bytes: number
  blockAlign: number
  formatTag: number
  sampleRate: number
  bitsPerSample: number
}

/**
 * Locate the `data` chunk of a PCM WAV file. Handles extra chunks (LIST,
 * JUNK) and RF64, whose sizes live in the `ds64` chunk.
 */
export function wavData(filePath: string): WavData {
  const fd = fs.openSync(filePath, 'r')
  try {
    const head = Buffer.alloc(12)
    fs.readSync(fd, head, 0, 12, 0)
    const riff = head.toString('ascii', 0, 4)
    if ((riff !== 'RIFF' && riff !== 'RF64') || head.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error(`Not a WAV file: ${filePath}`)
    }
    let pos = 12
    let fmt: Buffer | undefined
    let ds64Data: number | undefined
    const chunk = Buffer.alloc(8)
    while (fs.readSync(fd, chunk, 0, 8, pos) === 8) {
      const id = chunk.toString('ascii', 0, 4)
      const size = chunk.readUInt32LE(4)
      if (id === 'ds64') {
        const body = Buffer.alloc(16)
        fs.readSync(fd, body, 0, 16, pos + 8)
        ds64Data = Number(body.readBigUInt64LE(8))
      } else if (id === 'fmt ') {
        fmt = Buffer.alloc(16)
        fs.readSync(fd, fmt, 0, 16, pos + 8)
      } else if (id === 'data') {
        if (!fmt) break
        // 0xffffffff without ds64: a streamed WAV whose data runs to the end
        const bytes = size !== 0xffffffff ? size : ds64Data ?? fs.fstatSync(fd).size - (pos + 8)
        return {
          offset: pos + 8,
          bytes,
          formatTag: fmt.readUInt16LE(0),
          sampleRate: fmt.readUInt32LE(4),
          blockAlign: fmt.readUInt16LE(12),
          bitsPerSample: fmt.readUInt16LE(14),
        }
      }
      pos += 8 + size + (size % 2)
    }
    throw new Error(`No PCM data chunk in WAV file: ${filePath}`)
  } finally {
    fs.closeSync(fd)
  }
}

/** Whole sample frames in a PCM WAV file. */
export function wavSampleCount(filePath: string): number {
  const { bytes, blockAlign } = wavData(filePath)
  return Math.floor(bytes / blockAlign)
}

/**
 * The 80-byte header of a 16-bit PCM WAV with `dataBytes` of data: RIFF, a
 * JUNK chunk an RF64 ds64 chunk takes over past 4 GiB, fmt, data.
 */
export function wavHeader(dataBytes: number, sampleRate: number, channels: number): Buffer {
  const blockAlign = channels * 2
  const header = Buffer.alloc(HEADER_BYTES)
  const rf64 = dataBytes + HEADER_BYTES - 8 > 0xffffffff
  header.write(rf64 ? 'RF64' : 'RIFF', 0)
  header.writeUInt32LE(rf64 ? 0xffffffff : dataBytes + HEADER_BYTES - 8, 4)
  header.write('WAVE', 8)
  header.write(rf64 ? 'ds64' : 'JUNK', 12)
  header.writeUInt32LE(28, 16)
  if (rf64) {
    header.writeBigUInt64LE(BigInt(dataBytes + HEADER_BYTES - 8), 20)
    header.writeBigUInt64LE(BigInt(dataBytes), 28)
    header.writeBigUInt64LE(BigInt(dataBytes / blockAlign), 36)
  }
  header.write('fmt ', 48)
  header.writeUInt32LE(16, 52)
  header.writeUInt16LE(FORMAT_PCM, 56)
  header.writeUInt16LE(channels, 58)
  header.writeUInt32LE(sampleRate, 60)
  header.writeUInt32LE(sampleRate * blockAlign, 64)
  header.writeUInt16LE(blockAlign, 68)
  header.writeUInt16LE(16, 70)
  header.write('data', 72)
  header.writeUInt32LE(rf64 ? 0xffffffff : dataBytes, 76)
  return header
}

/**
 * Streams 16-bit PCM into a WAV file: silence as zeros, other WAV files'
 * data as is. Writes RF64 when the data outgrows a 32-bit size.
 */
export class WavWriter {
  private readonly fd: number
  private readonly blockAlign: number
  private dataBytes = 0
  private copyBuffer: Buffer | undefined
  private closed = false

  constructor(private readonly filePath: string, private readonly sampleRate: number, private readonly channels: number) {
    this.blockAlign = channels * 2
    this.fd = fs.openSync(filePath, 'w')
    try {
      fs.writeSync(this.fd, wavHeader(0, sampleRate, channels))
    } catch (error) {
      fs.closeSync(this.fd)
      throw error
    }
  }

  /** Sample frames written so far. */
  get samples(): number {
    return this.dataBytes / this.blockAlign
  }

  silence(samples: number): void {
    zeros ??= Buffer.alloc(CHUNK)
    for (let left = samples * this.blockAlign; left > 0;) {
      const n = Math.min(left, zeros.length)
      fs.writeSync(this.fd, zeros, 0, n)
      left -= n
    }
    this.dataBytes += samples * this.blockAlign
  }

  /** Append a 16-bit PCM WAV file in this writer's format. Returns its whole sample frames. */
  append(wavPath: string): number {
    const data = wavData(wavPath)
    const pcm16 = (data.formatTag === FORMAT_PCM || data.formatTag === FORMAT_EXTENSIBLE) && data.bitsPerSample === 16
    if (!pcm16 || data.sampleRate !== this.sampleRate || data.blockAlign !== this.blockAlign) {
      throw new Error(`WAV format differs from the track: ${wavPath}`)
    }
    // A truncated source would shift every later sample by a byte
    const bytes = data.bytes - (data.bytes % this.blockAlign)
    const src = fs.openSync(wavPath, 'r')
    try {
      const buf = (this.copyBuffer ??= Buffer.alloc(CHUNK))
      for (let done = 0; done < bytes;) {
        const n = fs.readSync(src, buf, 0, Math.min(buf.length, bytes - done), data.offset + done)
        if (n === 0) throw new Error(`WAV file ends early: ${wavPath}`)
        fs.writeSync(this.fd, buf, 0, n)
        done += n
      }
    } finally {
      fs.closeSync(src)
    }
    this.dataBytes += bytes
    return bytes / this.blockAlign
  }

  close(): void {
    try {
      fs.writeSync(this.fd, wavHeader(this.dataBytes, this.sampleRate, this.channels), 0, HEADER_BYTES, 0)
    } finally {
      this.release()
    }
  }

  /** Close and delete the file, after a failure part way. Never throws: the failure is the error worth seeing. */
  abort(): void {
    this.release()
    try { fs.rmSync(this.filePath, { force: true }) } catch { /* best effort */ }
  }

  /** Close the fd once: a second close could hit a number the OS has reused. */
  private release(): void {
    if (this.closed) return
    this.closed = true
    try { fs.closeSync(this.fd) } catch { /* nothing left to release */ }
  }
}
