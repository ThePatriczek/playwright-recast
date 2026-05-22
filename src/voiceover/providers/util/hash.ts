import * as crypto from 'node:crypto'
import * as fs from 'node:fs'

/** SHA-256 over the values, joined with NUL so `['a', 'bc']` ≠ `['ab', 'c']`. */
export function hashValues(values: ReadonlyArray<string | number | boolean>): string {
  return crypto.createHash('sha256').update(values.join('\0')).digest('hex')
}

/** SHA-256 of the file's contents. */
export function hashFile(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}
