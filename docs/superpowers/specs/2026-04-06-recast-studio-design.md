# recast-studio — Non-Dev Demo Video Tool

**Date:** 2026-04-06 (revised 2026-04-07)
**Status:** Approved
**Scope:** New `recast-studio` CLI + Claude Code skill within the playwright-recast package

## Problem

playwright-recast requires developer skills (TypeScript, Playwright tests, CLI). Product managers, marketers, and support staff at AGRP need to create product demo videos without writing code.

## Solution

Two pieces working together:

1. **`recast-studio` CLI** — opens a browser, lets the user click around, captures a Playwright trace. That's all it does.
2. **Claude Code skill** (`studio-workflow`) — the agent (already running on the user's machine) reads the trace, generates voiceover scripts + SRT, runs the recast pipeline. No API keys in code, no SDK dependency.

## User Flow

```
# Step 1: Record (CLI)
$ npx recast-studio https://app.codexis.cz
🎬  Browser opened. Navigate and interact. Close when done.
✅  Trace saved to .recast-studio/trace.zip (38s, 9 actions)

# Step 2: Analyze + Render (Claude Code skill)
> /studio-workflow .recast-studio/
🤖  Reading trace... 9 actions found.
    Generating voiceover script...
    → 4 visible steps, 2 hidden (login setup)
🎥  Running recast pipeline...
✅  demo.mp4 (8.2 MB)
```

## Architecture

### Part 1: `recast-studio` CLI (`src/studio/`)

Minimal recording tool. Opens Chromium via Playwright API (no codegen panel), captures trace + video.

```typescript
const browser = await chromium.launch({ headless: false })
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  recordVideo: { dir: outputDir, size: { width: 1920, height: 1080 } },
})
await context.tracing.start({ screenshots: true, snapshots: true })
const page = await context.newPage()
await page.goto(url)

// User interacts... closes browser:
await context.tracing.stop({ path: 'trace.zip' })
```

**Output:** directory with `trace.zip` + `*.webm` video.

**CLI interface:**
```
recast-studio [options] <url>

Arguments:
  url                         URL to open in the browser

Options:
  -o, --output <dir>          Output directory (default: .recast-studio/)
  --viewport <WxH>            Browser viewport (default: 1920x1080)
  --load-storage <path>       Pre-load auth state (cookies/localStorage)
  --ignore-https-errors       Ignore certificate errors
  -h, --help                  Show help
```

### Part 2: Claude Code Skill (`.claude/playwright-recast/skills/studio-workflow/`)

The agent itself does the AI work — no external API calls needed. The skill:

1. **Reads trace** — uses `parseTrace()` to extract actions
2. **Analyzes actions** — the agent (Claude) groups actions into steps, identifies setup/noise, writes voiceover text
3. **Generates SRT** — maps steps to trace timestamps
4. **Runs recast pipeline** — standard pipeline with generated SRT, auto-zoom, click effects, voiceover

The skill prompt instructs the agent to:
- Classify actions (hidden setup vs. visible demo steps)
- Write marketing voiceover per visible step
- Generate SRT file
- Compose and execute the recast pipeline

## Files to Create

| File | Purpose |
|------|---------|
| `src/studio/cli.ts` | CLI entry point — parseArgs, launch recorder |
| `src/studio/recorder.ts` | `record(url, options)` — Playwright browser session → trace.zip |
| `src/studio/types.ts` | `RecordOptions`, `RecordingResult` interfaces |
| `.claude/playwright-recast/skills/studio-workflow/SKILL.md` | Claude Code skill for trace analysis + recast |

## Files to Modify

| File | Change |
|------|--------|
| `package.json` | Add `"recast-studio": "./dist/studio/cli.js"` to `bin` |

## Dependencies

- **No new dependencies.** The recorder uses `playwright` (already a peer dep). The AI analysis runs inside Claude Code — no SDK needed.
- **Environment variables for rendering:** `ELEVENLABS_API_KEY` (only when skill runs voiceover)

## Edge Cases

1. **User closes browser immediately** — detect 0 actions, show error
2. **No trace.zip after close** — `tracing.stop()` may fail if browser crashed; check file exists
3. **load-storage for auth** — workflow: `npx playwright codegen --save-storage=auth.json`, then `npx recast-studio --load-storage=auth.json <url>`
4. **Skill invoked without trace** — skill checks directory has trace.zip, gives clear error

## Test Strategy

**Unit tests:**
- `recorder.test.ts` — mock Playwright browser/context API, verify tracing start/stop calls
- CLI argument parsing

**Manual testing:**
- Record real session on a test site
- Invoke skill, verify SRT + video output
