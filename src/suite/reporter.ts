import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter'
import type { RunManifest, SuiteTest } from '../types/suite.js'
import { computeSummary, sortByDeclarationOrder, writeManifest, DEFAULT_MANIFEST_PATH } from './manifest.js'
import { buildSuiteTest, shouldReplaceEntry } from './reporter-mapping.js'

export interface RecastReporterOptions {
  /** Where to write the run manifest (default: `.recast/run.json`) */
  outputFile?: string
  /** Suppress the one-line summary printed at the end of the run */
  quiet?: boolean
}

/**
 * Playwright reporter that records what the suite renderer needs: which tests
 * exist, in what order they are declared, how each one ended, and where its
 * trace landed.
 *
 * Register it alongside your usual reporters — it prints almost nothing and
 * produces no HTML:
 *
 * ```ts
 * // playwright.config.ts
 * export default defineConfig({
 *   reporter: [['list'], ['playwright-recast/reporter', { outputFile: '.recast/run.json' }]],
 *   use: { trace: 'on' },
 * })
 * ```
 *
 * `trace: 'on'` matters — with `retain-on-failure` the passing tests that make
 * up most of a demo have no trace to render.
 */
export default class RecastReporter implements Reporter {
  private readonly outputFile: string
  private readonly quiet: boolean

  /** testId -> declaration index, captured before the run starts */
  private declarationOrder = new Map<string, number>()
  /** testId -> the best attempt recorded so far */
  private entries = new Map<string, SuiteTest>()

  constructor(options: RecastReporterOptions = {}) {
    this.outputFile = options.outputFile ?? DEFAULT_MANIFEST_PATH
    this.quiet = options.quiet ?? false
  }

  /** Reporters that write a file must not race the run's other output. */
  printsToStdio(): boolean {
    return !this.quiet
  }

  onBegin(_config: FullConfig, suite: Suite): void {
    // `allTests()` walks the suite tree, which is built from the source files —
    // this is the only place declaration order is available. Result order is
    // meaningless once workers and retries are in play.
    suite.allTests().forEach((testCase, index) => {
      this.declarationOrder.set(testCase.id, index)
    })
  }

  onTestEnd(testCase: TestCase, result: TestResult): void {
    const existing = this.entries.get(testCase.id)
    if (!shouldReplaceEntry(existing, result)) return

    const order = this.declarationOrder.get(testCase.id)
      // A test that appeared after onBegin (a dynamically added one) sorts last
      // rather than jumping to the front.
      ?? this.declarationOrder.size + this.entries.size

    const project = projectNameOf(testCase)
    this.entries.set(testCase.id, buildSuiteTest(testCase, result, order, project))
  }

  async onEnd(result: FullResult): Promise<void> {
    const tests = sortByDeclarationOrder([...this.entries.values()])
    const manifest: RunManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      tests,
      summary: computeSummary(tests),
      exitCode: result.status === 'passed' ? 0 : 1,
    }

    writeManifest(this.outputFile, manifest)

    if (!this.quiet) {
      const { passed, failed, skipped } = manifest.summary
      const withTrace = tests.filter(t => t.tracePath).length
      console.log(
        `\nrecast: wrote ${this.outputFile} — ${tests.length} tests ` +
        `(${passed} passed, ${failed} failed, ${skipped} skipped), ${withTrace} with traces`,
      )
      if (withTrace === 0 && tests.length > 0) {
        console.log("recast: no traces recorded — set `use: { trace: 'on' }` in playwright.config.ts")
      }
    }
  }
}

/** Read the project name off a test case, tolerating older Playwright versions. */
function projectNameOf(testCase: TestCase): string | undefined {
  const name = testCase.parent?.project?.()?.name
  return name === undefined || name === '' ? undefined : name
}
