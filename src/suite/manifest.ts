import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import type { RunManifest, SuiteSummary, SuiteTest } from '../types/suite.js'

/** Default location the reporter writes to and the renderer reads from. */
export const DEFAULT_MANIFEST_PATH = '.recast/run.json'

const suiteTestSchema = z.object({
  id: z.string(),
  title: z.string(),
  titlePath: z.array(z.string()),
  project: z.string().optional(),
  order: z.number().int().nonnegative(),
  tags: z.array(z.string()),
  status: z.enum(['passed', 'failed', 'timedOut', 'skipped', 'interrupted']),
  retry: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  tracePath: z.string().optional(),
  videoPath: z.string().optional(),
  errorMessage: z.string().optional(),
})

const runManifestSchema = z.object({
  version: z.literal(1),
  createdAt: z.string(),
  tests: z.array(suiteTestSchema),
  summary: z.object({
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    flaky: z.number().int().nonnegative(),
  }),
  exitCode: z.number().int(),
})

/**
 * Validate an untrusted object as a run manifest.
 * Throws with the offending field path so a hand-edited manifest is debuggable.
 */
export function parseManifest(data: unknown): RunManifest {
  const result = runManifestSchema.safeParse(data)
  if (!result.success) {
    const details = result.error.issues
      .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new Error(`Invalid recast run manifest — ${details}`)
  }
  return result.data
}

/** Read and validate a manifest from disk. */
export function readManifest(manifestPath: string): RunManifest {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Run manifest not found: ${manifestPath}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (err) {
    throw new Error(`Run manifest is not valid JSON: ${manifestPath} (${(err as Error).message})`)
  }
  return parseManifest(raw)
}

/** Write a manifest to disk, creating parent directories as needed. */
export function writeManifest(manifestPath: string, manifest: RunManifest): void {
  fs.mkdirSync(path.dirname(path.resolve(manifestPath)), { recursive: true })
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
}

/**
 * Order tests the way they appear in the source files.
 * Result order (the order Playwright finished them) is never used — parallel
 * workers and retries make it meaningless for a narrative video.
 */
export function sortByDeclarationOrder(tests: readonly SuiteTest[]): SuiteTest[] {
  return [...tests].sort((a, b) => a.order - b.order)
}

/** Tally outcomes across the recorded attempts. */
export function computeSummary(tests: readonly SuiteTest[]): SuiteSummary {
  const summary: SuiteSummary = { passed: 0, failed: 0, skipped: 0, flaky: 0 }
  for (const test of tests) {
    if (test.status === 'passed') {
      summary.passed++
      // Passing only after a retry is the definition of flaky.
      if (test.retry > 0) summary.flaky++
    } else if (test.status === 'skipped') {
      summary.skipped++
    } else {
      summary.failed++
    }
  }
  return summary
}

export interface TestFilter {
  /** Matched against the title and against each tag */
  grep?: RegExp
  /** Playwright project name */
  project?: string
}

/** Select the tests that belong in the suite video, in declaration order. */
export function filterTests(
  tests: readonly SuiteTest[],
  filter: TestFilter,
): SuiteTest[] {
  const matched = tests.filter(test => {
    if (filter.project !== undefined && test.project !== filter.project) return false
    if (filter.grep) {
      // A fresh lastIndex each time — a /g regex would otherwise skip matches.
      const grep = new RegExp(filter.grep.source, filter.grep.flags.replace('g', ''))
      const haystack = [test.title, ...test.tags]
      if (!haystack.some(value => grep.test(value))) return false
    }
    return true
  })
  return sortByDeclarationOrder(matched)
}
