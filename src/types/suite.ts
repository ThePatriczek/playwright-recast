/** Playwright test outcome as recorded in the run manifest. */
export type SuiteTestStatus =
  | 'passed'
  | 'failed'
  | 'timedOut'
  | 'skipped'
  | 'interrupted'

/** One test in the run manifest, in declaration order. */
export interface SuiteTest {
  /** Playwright's stable test id */
  id: string
  /** Human-readable title (title path joined, project stripped) */
  title: string
  /** Full title path as Playwright reports it */
  titlePath: string[]
  /** Playwright project name, if the run used projects */
  project?: string
  /** Declaration index — the order tests appear in the source files */
  order: number
  /** Tags declared on the test (`@video`), without duplicates */
  tags: string[]
  /** Outcome of the recorded attempt */
  status: SuiteTestStatus
  /** Retry index of the recorded attempt (0 = first run) */
  retry: number
  /** Duration of the recorded attempt in milliseconds */
  durationMs: number
  /** Absolute path to the trace zip of the recorded attempt */
  tracePath?: string
  /** Absolute path to the Playwright video of the recorded attempt */
  videoPath?: string
  /** First error message, when the attempt failed */
  errorMessage?: string
}

/** Aggregate counts across the run. */
export interface SuiteSummary {
  passed: number
  failed: number
  skipped: number
  flaky: number
}

/** Everything the suite renderer needs from a Playwright run. */
export interface RunManifest {
  version: 1
  createdAt: string
  tests: SuiteTest[]
  summary: SuiteSummary
  /** Exit code Playwright would return for this run */
  exitCode: number
}

/** How a non-passing or unrenderable test is represented in the video. */
export type FailurePolicy = 'card' | 'clip' | 'clip+card' | 'omit'
export type SkippedPolicy = 'card' | 'omit'
export type MissingTracePolicy = 'card' | 'omit'

export interface SuiteResultPolicy {
  /** Failed and timed-out tests (default: 'card') */
  failures?: FailurePolicy
  /** Skipped tests (default: 'card') */
  skipped?: SkippedPolicy
  /** Tests with no usable trace (default: 'card') */
  missingTrace?: MissingTracePolicy
  /** Append a closing summary card (default: true) */
  summary?: boolean
}

export interface ResolvedSuiteResultPolicy {
  failures: FailurePolicy
  skipped: SkippedPolicy
  missingTrace: MissingTracePolicy
  summary: boolean
}

/** What the video does between two test clips. */
export type SuiteTransition = 'cut' | 'fade'

export interface SuiteCardConfig {
  /** Milliseconds a card stays on screen (default: 2500) */
  durationMs?: number
  /** Background color of the built-in template (default: '#0f1115') */
  background?: string
  /** Primary text color of the built-in template (default: '#f5f7fa') */
  color?: string
  /** Accent color used for failure markers (default: '#ff5f56') */
  accent?: string
  /**
   * Replace the built-in template. Receives the card content and must return a
   * full HTML document rendered at the target resolution.
   */
  template?: (card: CardContent) => string
}

export interface ResolvedSuiteCardConfig {
  durationMs: number
  background: string
  color: string
  accent: string
  template?: (card: CardContent) => string
}

/** The data a card template renders. */
export interface CardContent {
  kind: 'failed' | 'skipped' | 'missing' | 'summary'
  /** Headline — the test title, or the suite name on the summary card */
  title: string
  /** Supporting line — an error message, a reason, or the result tally */
  subtitle?: string
}
