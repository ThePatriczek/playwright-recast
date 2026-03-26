import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ZipReader } from '../../../src/parse/zip-reader'

const TRACE_PATH = path.resolve(__dirname, '../../fixtures/demo-trace.zip')
const hasFixture = fs.existsSync(TRACE_PATH)

describe.skipIf(!hasFixture)('ZipReader', () => {
  it('opens a trace zip and lists entry names', async () => {
    const reader = await ZipReader.open(TRACE_PATH)
    try {
      const names = reader.entryNames()
      expect(names.length).toBeGreaterThan(0)
      // Playwright traces contain trace.trace and trace.network files
      expect(names.some((n) => n.includes('trace'))).toBe(true)
    } finally {
      reader.dispose()
    }
  })

  it('reads text content from a trace entry', async () => {
    const reader = await ZipReader.open(TRACE_PATH)
    try {
      const names = reader.entryNames()
      const traceFile = names.find((n) => n.endsWith('.trace'))
      expect(traceFile).toBeDefined()

      const content = reader.readText(traceFile!)
      expect(content.length).toBeGreaterThan(0)
      // First line should be valid JSON
      const firstLine = content.split('\n')[0]!
      expect(() => JSON.parse(firstLine)).not.toThrow()
    } finally {
      reader.dispose()
    }
  })

  it('reads binary content (resource/frame data)', async () => {
    const reader = await ZipReader.open(TRACE_PATH)
    try {
      const names = reader.entryNames()
      const resourceFile = names.find((n) => n.startsWith('resources/'))
      if (resourceFile) {
        const data = reader.readBinary(resourceFile)
        expect(data.length).toBeGreaterThan(0)
      }
    } finally {
      reader.dispose()
    }
  })

  it('lists resources directory entries', async () => {
    const reader = await ZipReader.open(TRACE_PATH)
    try {
      const names = reader.entryNames()
      const resources = names.filter((n) => n.startsWith('resources/'))
      // Traces with screenshots should have resource entries
      expect(resources.length).toBeGreaterThan(0)
    } finally {
      reader.dispose()
    }
  })
})
