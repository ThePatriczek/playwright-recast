import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { jpegSize } from '../../../src/parse/jpeg'

describe('jpegSize', () => {
  it('reads the size from the start-of-frame header', () => {
    const data = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=797x448', '-frames:v', '1', '-c:v', 'mjpeg', '-pix_fmt', 'yuvj444p', '-f', 'image2', 'pipe:'])
    expect(jpegSize(data)).toEqual({ width: 797, height: 448 })
  })

  it('is undefined for data that is no JPEG', () => {
    expect(jpegSize(Buffer.from('not a jpeg'))).toBeUndefined()
  })

  // SOF0 with height h and width w
  const sof = (h: number, w: number) => Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0])

  it('skips fill bytes and markers without a length (T.81)', () => {
    const data = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xff, 0xff, 0xd0, 0xff, 0x01]), sof(448, 797)])
    expect(jpegSize(data)).toEqual({ width: 797, height: 448 })
  })

  it('rejects a zero size (height defined later by DNL)', () => {
    expect(jpegSize(Buffer.concat([Buffer.from([0xff, 0xd8]), sof(0, 797)]))).toBeUndefined()
  })

  it('stops at the scan or the end: entropy data after SOS is no header', () => {
    // SOS, then bytes that would read as a SOF0
    const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0])
    expect(jpegSize(Buffer.concat([Buffer.from([0xff, 0xd8]), sos, sof(448, 797)]))).toBeUndefined()
    expect(jpegSize(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xd9]), sof(448, 797)]))).toBeUndefined()
  })
})
