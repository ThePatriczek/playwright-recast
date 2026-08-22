import type { SuiteTest, SuiteTestStatus } from '../types/suite.js'

/**
 * Pure mapping between Playwright's reporter objects and the run manifest.
 *
 * Kept free of `@playwright/test` imports and of any I/O so the shapes can be
 * exercised with plain objects — the reporter itself is a thin shell over
 * these functions.
 */

/** The parts of Playwright's `TestCase` the manifest needs. */
export interface TestCaseLike {
  id?: string
  title: string
  tags?: readonly string[]
  titlePath?: () => string[]
}

/** The parts of Playwright's `TestResult` the manifest needs. */
export interface TestResultLike {
  status: string
  retry: number
  duration?: number
  attachments?: readonly AttachmentLike[]
  errors?: readonly { message?: string }[]
}

export interface AttachmentLike {
  name: string
  path?: string
  contentType?: string
}

const KNOWN_STATUSES: readonly SuiteTestStatus[] = [
  'passed', 'failed', 'timedOut', 'skipped', 'interrupted',
]

/**
 * Map a Playwright status onto a manifest status.
 * An unrecognised status is treated as a failure — a video that wrongly claims
 * success is worse than one that wrongly claims failure.
 */
export function resolveStatus(status: string): SuiteTestStatus {
  return KNOWN_STATUSES.includes(status as SuiteTestStatus)
    ? status as SuiteTestStatus
    : 'failed'
}

// A tag is an @word at a word boundary — `user@example.com` must not match.
const TITLE_TAG_PATTERN = /(?:^|\s)(@[\w-]+)/g

/**
 * Collect a test's tags. Playwright exposes `tags` from 1.42 on; older
 * versions only carry them inside the title, so both sources are merged.
 */
export function extractTags(testCase: TestCaseLike): string[] {
  const fromProperty = testCase.tags ?? []
  const fromTitle = [...testCase.title.matchAll(TITLE_TAG_PATTERN)].map(m => m[1]!)
  return [...new Set([...fromProperty, ...fromTitle])]
}

/** Find the on-disk path of a named attachment, if it was written to disk. */
export function findAttachmentPath(
  attachments: readonly AttachmentLike[],
  name: string,
): string | undefined {
  return attachments.find(a => a.name === name && a.path)?.path
}

const ANSI_PATTERN = /\[[0-9;]*m/g

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

/**
 * Build a manifest entry for one recorded attempt.
 *
 * `titlePath()` returns `['', <project>, <file>, ...describes, <title>]`. The
 * leading empty entry and the project are dropped — the project is a separate
 * field, and repeating it in every title makes for noisy cards.
 */
export function buildSuiteTest(
  testCase: TestCaseLike,
  result: TestResultLike,
  order: number,
  project: string | undefined,
): SuiteTest {
  const rawPath = testCase.titlePath?.() ?? [testCase.title]
  const titlePath = rawPath.filter((segment, i) => {
    if (segment === '') return false
    // Only the project segment is dropped, and only where Playwright puts it.
    return !(i === 1 && project !== undefined && segment === project)
  })

  const attachments = result.attachments ?? []
  const tracePath = findAttachmentPath(attachments, 'trace')
  const videoPath = findAttachmentPath(attachments, 'video')
  const firstError = result.errors?.find(e => e.message)?.message

  return {
    id: testCase.id ?? titlePath.join(' > '),
    // Drop the file segment from the display title; the file is rarely the
    // interesting part of a narrated clip.
    title: titlePath.slice(1).join(' > ') || testCase.title,
    titlePath,
    ...(project !== undefined ? { project } : {}),
    order,
    tags: extractTags(testCase),
    status: resolveStatus(result.status),
    retry: result.retry,
    durationMs: result.duration ?? 0,
    ...(tracePath !== undefined ? { tracePath } : {}),
    ...(videoPath !== undefined ? { videoPath } : {}),
    ...(firstError !== undefined ? { errorMessage: stripAnsi(firstError).trim() } : {}),
  }
}

/**
 * Decide whether an incoming attempt replaces the one already recorded.
 *
 * Attempts normally arrive in retry order, so the last write wins and the
 * manifest ends up holding the final attempt. The guard exists for the
 * out-of-order case: an earlier retry must never overwrite a later one.
 */
export function shouldReplaceEntry(
  existing: { retry: number } | undefined,
  incoming: { retry: number },
): boolean {
  if (!existing) return true
  return incoming.retry >= existing.retry
}
