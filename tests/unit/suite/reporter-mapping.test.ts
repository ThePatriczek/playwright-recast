import { describe, it, expect } from 'vitest'
import {
  resolveStatus,
  extractTags,
  findAttachmentPath,
  buildSuiteTest,
  shouldReplaceEntry,
} from '../../../src/suite/reporter-mapping'

describe('resolveStatus', () => {
  it('maps playwright statuses straight through', () => {
    expect(resolveStatus('passed')).toBe('passed')
    expect(resolveStatus('failed')).toBe('failed')
    expect(resolveStatus('timedOut')).toBe('timedOut')
    expect(resolveStatus('skipped')).toBe('skipped')
    expect(resolveStatus('interrupted')).toBe('interrupted')
  })

  it('falls back to failed for an unrecognised status', () => {
    expect(resolveStatus('something-new')).toBe('failed')
  })
})

describe('extractTags', () => {
  it('reads the tags property when playwright provides it', () => {
    expect(extractTags({ tags: ['@video', '@slow'], title: 'x' })).toEqual(['@video', '@slow'])
  })

  it('falls back to parsing tags out of the title', () => {
    expect(extractTags({ title: 'creates a project @video @slow' })).toEqual(['@video', '@slow'])
  })

  it('deduplicates tags', () => {
    expect(extractTags({ tags: ['@video', '@video'], title: 'x @video' })).toEqual(['@video'])
  })

  it('returns an empty array when there are no tags', () => {
    expect(extractTags({ title: 'creates a project' })).toEqual([])
  })

  it('does not treat an email-like word as a tag', () => {
    expect(extractTags({ title: 'invites user@example.com' })).toEqual([])
  })
})

describe('findAttachmentPath', () => {
  const attachments = [
    { name: 'screenshot', path: '/runs/shot.png', contentType: 'image/png' },
    { name: 'trace', path: '/runs/trace.zip', contentType: 'application/zip' },
    { name: 'video', path: '/runs/video.webm', contentType: 'video/webm' },
  ]

  it('finds the trace attachment', () => {
    expect(findAttachmentPath(attachments, 'trace')).toBe('/runs/trace.zip')
  })

  it('finds the video attachment', () => {
    expect(findAttachmentPath(attachments, 'video')).toBe('/runs/video.webm')
  })

  it('returns undefined when the attachment is absent', () => {
    expect(findAttachmentPath([], 'trace')).toBeUndefined()
  })

  it('ignores an attachment recorded without a path', () => {
    expect(findAttachmentPath([{ name: 'trace', contentType: 'application/zip' }], 'trace'))
      .toBeUndefined()
  })
})

describe('buildSuiteTest', () => {
  const testCase = {
    id: 'test-1',
    title: 'creates a project',
    tags: ['@video'],
    titlePath: () => ['', 'chromium', 'project.spec.ts', 'Projects', 'creates a project'],
  }

  const result = {
    status: 'passed' as const,
    retry: 0,
    duration: 1234,
    attachments: [{ name: 'trace', path: '/runs/trace.zip', contentType: 'application/zip' }],
    errors: [],
  }

  it('maps a passing test', () => {
    const suiteTest = buildSuiteTest(testCase, result, 3, 'chromium')
    expect(suiteTest).toMatchObject({
      id: 'test-1',
      title: 'Projects > creates a project',
      order: 3,
      project: 'chromium',
      tags: ['@video'],
      status: 'passed',
      retry: 0,
      durationMs: 1234,
      tracePath: '/runs/trace.zip',
    })
  })

  it('drops the leading empty entry and the project from the title path', () => {
    const suiteTest = buildSuiteTest(testCase, result, 0, 'chromium')
    expect(suiteTest.titlePath).toEqual(['project.spec.ts', 'Projects', 'creates a project'])
  })

  it('records the first error message for a failed test', () => {
    const suiteTest = buildSuiteTest(testCase, {
      ...result,
      status: 'failed',
      errors: [{ message: 'Expected 1 to be 2' }, { message: 'second' }],
    }, 0, undefined)
    expect(suiteTest.status).toBe('failed')
    expect(suiteTest.errorMessage).toBe('Expected 1 to be 2')
  })

  it('strips ansi escape codes from the error message', () => {
    const suiteTest = buildSuiteTest(testCase, {
      ...result,
      status: 'failed',
      errors: [{ message: '[31mExpected[39m 1' }],
    }, 0, undefined)
    expect(suiteTest.errorMessage).toBe('Expected 1')
  })

  it('omits the project when the run has no named projects', () => {
    expect(buildSuiteTest(testCase, result, 0, undefined).project).toBeUndefined()
  })

  it('leaves tracePath undefined when no trace was recorded', () => {
    const suiteTest = buildSuiteTest(testCase, { ...result, attachments: [] }, 0, undefined)
    expect(suiteTest.tracePath).toBeUndefined()
  })
})

describe('shouldReplaceEntry', () => {
  const base = { retry: 0, status: 'failed' as const }

  it('accepts the first attempt', () => {
    expect(shouldReplaceEntry(undefined, { retry: 0 })).toBe(true)
  })

  it('accepts a later retry over an earlier one', () => {
    expect(shouldReplaceEntry(base, { retry: 1 })).toBe(true)
  })

  it('rejects an out-of-order earlier retry', () => {
    expect(shouldReplaceEntry({ ...base, retry: 2 }, { retry: 1 })).toBe(false)
  })

  it('accepts a repeat of the same retry index', () => {
    expect(shouldReplaceEntry({ ...base, retry: 1 }, { retry: 1 })).toBe(true)
  })
})
