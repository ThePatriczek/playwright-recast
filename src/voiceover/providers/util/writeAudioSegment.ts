import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import type { AudioSegment } from '../../../types/voiceover.js'

export interface WriteAudioSegmentOptions {
  dir: string
  prefix: string
  sampleRate: number
  /** Codec recorded in the returned AudioSegment.format. Default: 'mp3'. */
  codec?: string
  /** File extension. Default: same as codec. */
  ext?: string
  /** Channel count recorded in the returned AudioSegment.format. Default: 1. */
  channels?: number
}

/** Write `buf` to `<dir>/<prefix>-<uuid>.<ext>` and build the AudioSegment. */
export async function writeAudioSegment(
  buf: Buffer,
  opts: WriteAudioSegmentOptions,
): Promise<AudioSegment> {
  const codec = opts.codec ?? 'mp3'
  const ext = opts.ext ?? codec
  const channels = opts.channels ?? 1
  const filePath = path.join(opts.dir, `${opts.prefix}-${crypto.randomUUID()}.${ext}`)
  await fs.promises.writeFile(filePath, buf)
  return {
    path: filePath,
    durationMs: 0,
    format: { sampleRate: opts.sampleRate, channels, codec },
  }
}
