# Suite-level video orchestration

Renders an ordered Playwright Test suite into one result-aware MP4.
Resolves issue #21.

## Goal

One Playwright run produces one video: each test becomes a clip, clips are
concatenated in declaration order, and the suite result is reflected in the
output (failure cards, skipped cards, a closing summary card).

## Non-goals

- A new test or scene DSL. Existing marker helpers (`narrate`, `click`, ...) are the authoring API.
- HTML reporting, an interactive editor, AI-written narration.
- Touching the existing single-trace pipeline. The orchestrator is a consumer of the public fluent API, nothing more.
- Parallel clip rendering. Clips render sequentially in v1.
- Clip caching across runs. TTS cost on re-render is a known v2 concern.

## Architecture

Four new units plus one enabling refactor.

| Module | Purpose |
| --- | --- |
| `src/suite/reporter.ts` | Playwright `Reporter` that writes the run manifest |
| `src/suite/manifest.ts` | `RunManifest` schema (zod), read/write, ordering |
| `src/suite/cards.ts` | HTML template -> PNG -> video clip |
| `src/suite/orchestrator.ts` | manifest -> clips -> one MP4 |
| `src/suite/config.ts` | `defineSuite`, config file loading |

**Enabling refactor.** `probeFps`, `probeHasAudio`, `normalizeVideo`,
`ensureAudioStream` and `crossfadeVideos` are private in
`src/render/intro-outro.ts`. They move to `src/render/video-ops.ts` and
`intro-outro.ts` imports them. Behavior is unchanged; suite concat would
otherwise duplicate all five.

The pipeline (`src/pipeline/`) and renderer (`src/render/renderer.ts`) are not
modified.

## Data flow

```text
playwright test  --(reporter)-->  .recast/run.json
                                       |
                      render-suite     v
  recast.config.ts --> clip(test) -> Pipeline.toFile() -> clip-N.mp4
                                       |
                                  cards.ts (failed / skipped / missing / summary)
                                       |
                               video-ops.concatVideos()
                                       v
                              videos/walkthrough.mp4
```

## The manifest

Written by the reporter to `.recast/run.json` (configurable).

```ts
interface RunManifest {
  version: 1
  createdAt: string
  tests: SuiteTest[]      // declaration order
  summary: { passed: number; failed: number; skipped: number; flaky: number }
  exitCode: number
}

interface SuiteTest {
  id: string              // Playwright's testId
  title: string           // full title, project prefix stripped
  titlePath: string[]
  project: string | undefined
  order: number           // declaration index
  tags: string[]
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted'
  retry: number           // retry index of the recorded attempt
  durationMs: number
  tracePath: string | undefined
  videoPath: string | undefined
  errorMessage: string | undefined
}
```

Declaration order comes from `onBegin(config, suite)`, which hands the full
suite tree before execution. Result order is never used for ordering.

Attempt selection: `onTestEnd` overwrites the entry for a test on every
attempt, so the last write wins and the manifest holds the final attempt.

## Configuration

`recast.config.ts` exports a builder, not a declarative render schema. The
project's API surface is the fluent pipeline; duplicating a subset of it into
config keys would be a second, weaker API.

```ts
import { defineSuite, Recast, OpenAIProvider } from 'playwright-recast'

export default defineSuite({
  name: 'Product walkthrough',
  output: 'videos/walkthrough.mp4',
  grep: /@video/,

  clip: (test) => Recast
    .from(test.tracePath)
    .parse()
    .speedUp({ duringIdle: 3 })
    .subtitlesFromTrace()
    .voiceover(OpenAIProvider({ voice: 'nova' }))
    .render({ resolution: '1080p' }),
})
```

`clip` returns a `Pipeline`; the orchestrator calls `toFile()` itself. Returning
`null` skips the test. `clip` is only called for tests that have a trace.

Result policy defaults, overridable:

```ts
results: {
  failures: 'card',      // 'card' | 'clip' | 'clip+card' | 'omit'
  skipped: 'card',       // 'card' | 'omit'
  missingTrace: 'card',  // 'card' | 'omit'
  summary: true,
}
```

## Cards

A card is an HTML string rendered by headless Chromium at the target
resolution, screenshotted to PNG, then turned into a still clip by ffmpeg.
Playwright is already a peer dependency, and HTML keeps cards themeable and
user-overridable via `cards: { template }`.

The browser launches once per suite render and only if at least one card is
needed.

## Concatenation

Clips are normalized to a common resolution/fps (the first clip's), given a
silent audio track when missing, then concatenated with the ffmpeg concat
demuxer. No crossfade between test clips by default — a hard cut reads as
"next test". `transition: 'fade'` opts into `crossfadeVideos`.

## CLI

```bash
# render from an existing manifest
playwright-recast render-suite --manifest .recast/run.json -o videos/out.mp4

# run playwright, then render; preserves playwright's exit code
playwright-recast test -- --project=chromium --grep=@video
```

`test` spawns `npx playwright test` with the reporter appended via
`--reporter`, renders on completion regardless of test outcome, then exits with
Playwright's original code. Rendering never masks a red suite.

The existing flag-only invocation (`playwright-recast -i trace.zip`) keeps
working: a first positional argument is treated as a subcommand only when it
matches a known one.

## Error handling

- Missing/unreadable manifest: fail fast with the path.
- Manifest schema mismatch: fail fast, name the offending field (zod).
- Missing trace for a test: card (default) or omit, never a hard failure.
- A clip render that throws: the failure is logged, the test falls back to a card, and the suite video is still written. One bad trace does not lose the whole run.
- No renderable clips at all: fail with a clear message rather than writing a zero-length file.

## Testing

Unit tests cover the pure logic, matching the existing suite's style: manifest
schema round-trip, declaration ordering, final-attempt selection, grep/tag
filtering, result-policy resolution, card HTML generation, concat argument
construction, CLI subcommand dispatch and exit-code propagation. ffmpeg and
Chromium invocations are not exercised in unit tests.
