import * as fs from 'node:fs'
import { unzipSync, strFromU8 } from 'fflate'

/**
 * Reads entries from a Playwright trace ZIP file.
 * Uses fflate (pure JS) for zero-dependency ZIP extraction.
 */
export class ZipReader {
  private entries: Record<string, Uint8Array>

  private constructor(entries: Record<string, Uint8Array>) {
    this.entries = entries
  }

  /** Open a zip file and extract all entries into memory */
  static open(zipPath: string): ZipReader {
    const data = fs.readFileSync(zipPath)
    const entries = unzipSync(new Uint8Array(data))
    return new ZipReader(entries)
  }

  /** Get all entry names in the zip */
  entryNames(): string[] {
    return Object.keys(this.entries)
  }

  /** Read an entry as UTF-8 text */
  readText(name: string): string {
    const entry = this.entries[name]
    if (!entry) throw new Error(`Entry not found in zip: ${name}`)
    return strFromU8(entry)
  }

  /** Read an entry as raw binary buffer */
  readBinary(name: string): Buffer {
    const entry = this.entries[name]
    if (!entry) throw new Error(`Entry not found in zip: ${name}`)
    return Buffer.from(entry)
  }

  /** Check if an entry exists */
  has(name: string): boolean {
    return name in this.entries
  }

  /** Release memory */
  dispose(): void {
    this.entries = {}
  }
}
