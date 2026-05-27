# `click()` / `markClick()` — explicit click markers with a polished cursor approach

**Status:** design
**Date:** 2026-05-27

## Problem

`clickEffect()` auto-detects every `click` action in the trace and renders a ripple + cursor approach for each. The cursor's approach is timed off the click action's `endTime` (when Playwright deemed the element actionable). For clicks that wait on a page load, two problems follow:

1. The screencast video lags Playwright's "actionable" moment by ~150ms, so the frame at the click is often still a loading screen.
2. The cursor's fixed pre-click approach (0.5s) then glides over that loading screen, before the target is visible — "the mouse moves before there's anything to click on."

A post-render fix is not reliably possible: the trace records when the DOM was actionable, not when the pixels painted. Freezing at the click holds a pre-paint frame, and freezing shifts the click and its on-screen result together, so the ordering is unchanged. (Verified empirically.)

## Goal

Let the test author explicitly mark a click in the trace. A tiny real-time *settle* guarantees the recorder captures a painted frame of the target; the renderer then synthesises the full cursor approach in post (a hold/freeze) over that painted frame. The author opts in per click, tracing stays close to real-time, and the polished approach costs nothing at trace time beyond the settle.

## Non-goals

- Automatic detection of when a target paints (frame-difference analysis). Out of scope; the marker + settle sidesteps it.
- Changing behaviour for plain `locator.click()` (unmarked) clicks — they render exactly as today.
- Per-call timing overrides — timing is configured globally (see Config).

## Test-side API (`src/helpers.ts`)

Two new helpers, same family as `narrate` / `zoom` / `highlight`:

```ts
// Low-level: write a click marker only. No real click, no wait.
await markClick(locator)

// Convenience: settle → mark → real click. options pass through to Playwright.
await click(locator, options?)
```

- **`markClick(locator)`** — reads the element centre via `locator.boundingBox()`, writes a `__recast_click__: {"x":<vx>,"y":<vy>}` marker step into the trace (JSON payload in the step title, exactly like `highlight()` / `zoom()`). Coordinates are viewport pixels. No real click, no delay. If `boundingBox()` returns null (element not visible), it no-ops (no marker).
- **`click(locator, options?)`** — order matters: `await locator.waitFor({ state: 'visible' })` (so the target is on screen before we settle/mark — the real click comes last, so we can't lean on its auto-wait), wait the **settle**, `markClick(locator)`, then `await locator.click(options)`. `options` is Playwright's `LocatorClickOptions`, forwarded unchanged.
- New export `CLICK_TITLE_PREFIX = '__recast_click__: '`.
- No `testInfo` annotations are pushed (the legacy report.json flat-index contract is unaffected — that contract is `narrate`-only).

### Settle (test-side timing)

- Module constant `CLICK_SETTLE_MS = 150`. A fixed `page.waitForTimeout`-style wait (not network-idle — predictable, no dependency on network behaviour).
- Global override via an optional second argument to setup:

```ts
setupRecast(test, { clickSettleMs: 200 }) // optional; defaults to 150
```

  `setupRecast`'s current signature is `setupRecast(testInstance)`. Add an optional `options?: { clickSettleMs?: number }`. Stored in a module-level variable read by `click()`.
- `markClick()` does **not** settle. Standalone callers own their timing.
- The settle is the only real-time cost added to the trace.

## Marker format

`__recast_click__: ` + `JSON.stringify({ x, y })`, where `x`/`y` are viewport-pixel coordinates of the element centre. No timing data in the payload — the marker's position in the trace (its step `startTime`) supplies the time; durations are global config. Mirrors the `HIGHLIGHT_TITLE_PREFIX` / `ZOOM_TITLE_PREFIX` convention.

## Pipeline: reconciliation (executor)

A shared helper reconciles `__recast_click__` markers with auto-detected click actions, used by both the `clickEffect` and `cursorOverlay` stages so ripples and cursor agree.

Inputs per marker: `{ x, y, startTime }` (parsed from the marker step). Inputs per auto-detected click: existing `click`/`selectOption` actions with `point` + `startTime`/`endTime`.

Rules (markers **augment / override**):
1. A marker **matches** an auto-detected click when their positions are within a small tolerance (e.g. ≤ 8 viewport px on each axis) **and** the marker's `startTime` is within a window of the click action (e.g. within `[startTime − 1000ms, endTime + 250ms]`). The convenience `click()` emits the marker immediately before `locator.click()`, so a match is the normal case.
2. A matched auto-detected click is **suppressed** — the marker drives that click instead (no duplicate ripple/cursor).
3. An **unmatched marker** (e.g. standalone `markClick`) still produces a click.
4. An **unmatched auto-detected click** (plain `locator.click()`) is produced exactly as today.
5. Marker-driven clicks are **flagged** (`approach: true`) on the resulting `ClickEvent` and `CursorKeyframe`; auto-only ones are not.

When two markers could match the same auto-click, the nearest in time wins; each auto-click is matched at most once.

The unified list feeds:
- `clickEffect`: `ClickEvent[]` — marker-driven entries use the marker's coords + time and carry `approach: true`.
- `cursorOverlay`: `CursorKeyframe[]` — marker-driven entries use the marker's coords + time, carry `approach: true`, and set `autoWaitSec: 0` (the hold supplies the approach time, so the cursor uses its full glide rather than the auto-wait-shortened one).

Marker times go through the same speed-remap and blank-lead-in offset as auto-detected clicks/keyframes, so they live in the same video timeline.

## Renderer: postprocessed approach hold

For each marker-driven (`approach: true`) click, the renderer:
1. Inserts a **hold (freeze)** at the click's (pre-shift) video time for `approachMs`, appended to the freeze list and applied by the existing `applyVoiceoverFreezes` + `shiftForFreezes` path (the same mechanism voiceover freezes use). Both the ripple and the cursor keyframe shift by the hold (and any earlier freezes), so they stay aligned with the held frame and with the click's on-screen result (which also shifts).
2. The cursor uses its **full glide** over the held frame (because `autoWaitSec` is 0 for these keyframes, the existing approach-trim logic does not shorten it).
3. The ripple fires at the end of the hold; the video then resumes into the click's result.

This works where the auto-freeze failed because the marker sits on a *painted* frame — the settle guaranteed the recorder captured the target before the marker — so the held frame is the real target, not a loading screen.

`approachMs` must be ≥ the cursor's pre-click span (`APPEAR_BEFORE`, 0.5s) so the glide fits within the hold. Default `approachMs = 500`.

### Interaction with existing freezes

Approach holds are combined with voiceover freezes into one list before `applyVoiceoverFreezes`. `shiftForFreezes` already sums all freezes before a given time, so clicks/cursor/subtitles shift correctly across both freeze kinds. Approach holds are placed at the marker's video time (blank-lead-in adjusted, in the same timeline as clicks) so they hold the correct frame.

## Config

- **`cursorOverlay({ approachMs?: number })`** — render-side hold duration for marker-driven clicks. Default 500. Resolved in `cursor-overlay/defaults.ts`.
- **`setupRecast(test, { clickSettleMs?: number })`** — test-side settle. Default 150.
- No per-call overrides (global only, per design decision).

## Files touched

- `src/helpers.ts` — add `markClick`, `click`, `CLICK_TITLE_PREFIX`; extend `setupRecast` with optional `clickSettleMs`; module state for the settle.
- `src/index.ts` — re-export `markClick`, `click`.
- `src/types/click-effect.ts` — add `approach?: boolean` to `ClickEvent`.
- `src/types/cursor-overlay.ts` — add `approachMs?: number` to `CursorOverlayConfig`; `approach?: boolean` to `CursorKeyframe`.
- `src/cursor-overlay/defaults.ts` — resolve `approachMs` (default 500).
- `src/pipeline/click-markers.ts` (new) — shared marker-parse + reconciliation helper returning the unified click list.
- `src/pipeline/executor.ts` — `clickEffect` and `cursorOverlay` stages call the shared helper; mark-driven entries get coords/time/flags.
- `src/render/renderer.ts` — generate approach holds from `approach`-flagged clicks; merge into the freeze list; full glide for those cursor keyframes.

## Testing

- `tests/unit/helpers/click.test.ts` — `markClick` writes one `__recast_click__` marker with JSON coords and no annotations; `click` settles then marks then clicks (assert order via a fake test/locator), and forwards click options; `markClick` no-ops when `boundingBox()` is null.
- `tests/unit/pipeline/click-markers.test.ts` — reconciliation helper: marker matched to a nearby same-position auto-click suppresses it and flags `approach`; unmatched marker produces a click; unmatched auto-click unchanged; nearest-in-time wins when two markers contend; position-tolerance and time-window boundaries.
- Renderer approach-hold behaviour (freeze inserted at the marker, full glide) is verified manually with the demo trace; no fixture-based ffmpeg test (consistent with existing renderer testing).

## Out of scope

- Frame-difference / visual-settle detection.
- Per-call timing overrides.
- A `dblclick` / `hover` family of markers (could follow the same pattern later).
