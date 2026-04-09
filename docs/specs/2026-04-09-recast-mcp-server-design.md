# Recast Studio MCP Server — AI-Agent-Driven Demo Video Creation

**Date:** 2026-04-09
**Status:** Draft
**Scope:** playwright-recast library (`/Users/thepatriczek/Work/playwright-recast/`)

## Problem

Creating demo videos with playwright-recast today requires:
1. Writing Gherkin `.feature` files with voiceover doc strings
2. Writing TypeScript step definitions (`narrate()`, `pace()`, `highlight()`)
3. Running CLI commands (`bun run demo`, `bun run recast`)
4. Managing environment setup (Bun, ffmpeg, API keys, .env)

This workflow is developer-only. Non-technical internal users cannot create demo videos without developer assistance.

## Solution

An MCP (Model Context Protocol) server that wraps playwright-recast's capabilities as tools. Any MCP-compatible AI agent (Claude, ChatGPT, etc.) becomes the interface — the user talks naturally, the agent orchestrates recording, voiceover writing, and rendering.

**Key insight:** The AI agent IS the voiceover writer. No template engine, no LLM enhancer module — the agent's conversation with the user naturally produces and iterates on voiceover text.

### User Flow

```
User: "I want to create a demo video of the Codexis chat feature."

Agent: I'll open a browser for you. Navigate through the feature you want to demo,
       then close the Inspector when you're done.
       [calls record_session tool]

       ...user records...

Agent: Recording complete! 12 actions in 38 seconds. I detected 5 steps:
       1. [HIDDEN] Login and setup
       2. Open the chat interface
       3. Select the Codexis skill
       4. Ask a legal question
       5. View the AI response

       Here's my voiceover suggestion:
       Step 2: "Need a quick answer to a legal question? Just open the chat."
       Step 3: "Select the Codexis skill — it connects AI to the full Czech legal database."
       Step 4: "Ask your specific question about the Civil Code."
       Step 5: "In seconds, you get the exact wording from the source. No searching, no doubts."

       Want me to adjust anything?

User: "Step 5 should mention codexis.ai at the end"

Agent: Updated:
       Step 5: "In seconds, you get the exact wording from the source.
                No searching, no doubts. Try it at codexis.ai."

       Ready to render?

User: "Yes"

Agent: [calls render_video tool]
       Done! Video saved to ./recast-output/demo.mp4 (4K, 42s, 12.3 MB)
```

## Architecture

### MCP Server Location

New directory: `src/mcp/` in playwright-recast repo. Exported as `playwright-recast/mcp`.

### MCP Tools

#### `record_session`

Opens a browser at the given URL. User interacts with the app. When they close the Inspector (click "Resume"), the recording stops and the tool returns trace metadata.

```typescript
// Input
{
  url: string                           // URL to open
  outputDir?: string                    // Default: .recast-studio/
  viewport?: { width: number; height: number }  // Default: 1920x1080
  ignoreHttpsErrors?: boolean           // Default: false
  loadStorage?: string                  // Pre-load auth state file
}

// Output
{
  traceDir: string                      // Absolute path to output directory
  tracePath: string                     // Path to trace.zip
  videoPath: string                     // Path to recorded .webm
  actionCount: number                   // Number of detected actions
  durationMs: number                    // Total recording duration
}
```

Implementation: Thin wrapper around existing `src/studio/recorder.ts`. No changes needed to recorder.

#### `analyze_trace`

Parses a trace and returns structured steps with action descriptions, timing, and thumbnail references. The agent uses this data to understand what happened and write voiceover.

```typescript
// Input
{
  traceDir: string                      // Directory containing trace.zip
}

// Output
{
  metadata: {
    actionCount: number
    durationMs: number
    viewport: { width: number; height: number }
    url: string                         // Initial URL from trace
  }
  steps: Array<{
    id: string                          // Unique step ID
    label: string                       // Human-readable: "Click on Download button"
    hidden: boolean                     // Auto-detected: login, cookie consent, etc.
    actions: Array<{                    // Raw actions in this step
      method: string                    // click, fill, goto, etc.
      selector?: string                 // CSS selector (sanitized — no test IDs)
      value?: string                    // Fill value (passwords masked)
      url?: string                      // For goto actions
      text?: string                     // Button/link text if available
    }>
    startTimeMs: number                 // Trace-relative
    endTimeMs: number                   // Trace-relative
    thumbnailPath: string               // Path to extracted JPEG thumbnail
    durationMs: number                  // Step duration
  }>
}
```

Implementation: New `src/mcp/analyzer.ts` module. Uses existing `parseTrace()` from `src/parse/trace-parser.ts`. Step grouping logic (see below). Extracts thumbnail JPEGs from trace zip to disk.

#### `get_step_thumbnail`

Returns a screenshot image for a specific step. The agent can show this to the user for context.

```typescript
// Input
{
  traceDir: string
  stepId: string
}

// Output: image content (JPEG)
```

Implementation: Reads from thumbnail files extracted by `analyze_trace`.

#### `render_video`

Takes the final step configuration (with voiceover text) and renders the video.

```typescript
// Input
{
  traceDir: string                      // Directory with trace.zip
  steps: Array<{
    id: string                          // Step ID from analyze_trace
    hidden: boolean                     // Whether to hide this step
    voiceover?: string                  // Voiceover text (visible steps only)
  }>
  settings?: {
    ttsProvider?: 'openai' | 'elevenlabs' | 'none'   // Default: 'openai'
    voice?: string                      // Default: provider-dependent
    speed?: {
      idle?: number                     // Default: 3.0
      action?: number                   // Default: 1.0
      network?: number                  // Default: 2.0
    }
    format?: 'mp4' | 'webm'            // Default: 'mp4'
    resolution?: '720p' | '1080p' | '1440p' | '4k'  // Default: '1080p'
    burnSubtitles?: boolean             // Default: true
    cursorOverlay?: boolean             // Default: true
    clickEffect?: boolean               // Default: true
    autoZoom?: boolean                  // Default: true
    outputPath?: string                 // Default: <traceDir>/demo.mp4
  }
}

// Output
{
  videoPath: string                     // Absolute path to rendered video
  srtPath: string                       // Path to subtitle file
  durationMs: number                    // Final video duration
  fileSizeBytes: number                 // Video file size
}
```

Implementation: New `src/mcp/pipeline-builder.ts`. Generates SRT from steps+voiceover, builds Pipeline using existing fluent API, executes with `toFile()`.

#### `list_recordings`

Lists available recordings in a directory.

```typescript
// Input
{
  dir?: string                          // Default: current working directory
}

// Output
{
  recordings: Array<{
    traceDir: string
    hasTrace: boolean
    hasVideo: boolean
    hasSrt: boolean
    modifiedAt: string                  // ISO date
  }>
}
```

Implementation: Scan directory for subdirs containing `trace.zip`.

### MCP Resources (optional, Phase 2)

- `recording://{traceDir}/project` — Full analysis result as JSON
- `recording://{traceDir}/thumbnail/{stepId}` — Step screenshot

## Step Grouping Algorithm (analyzer.ts)

The analyzer groups raw trace actions into logical user-facing steps:

### Hidden Step Detection

Mark as hidden (auto-detected, agent can override):
- **Initial navigation:** First `goto` action
- **Login sequences:** `fill` on selectors containing `password`, `email`, `login`, `username` followed by a click on a submit-like element
- **Cookie consent:** Actions on selectors matching `cookie`, `consent`, `accept`, `gdpr`
- **Setup/config:** Actions annotated with `voiceover-hidden` (from BDD tests)

### Visible Step Grouping

Group remaining actions into logical steps:
1. **Navigation step:** Non-initial `goto` = new step ("Navigate to X")
2. **Form interaction:** `click` + `fill` on same/related element = one step ("Enter X in field Y")
3. **Button click:** `click` on a button/link = one step ("Click X")
4. **Select interaction:** `selectOption` = one step ("Select X")
5. **Time gap:** Actions separated by >5s gap = separate steps

### Label Generation

Each step gets a human-readable label derived from its actions:
- `goto /dashboard` → "Navigate to dashboard"
- `click button "Download"` → "Click Download button"
- `fill input[name=search] "report"` → "Type 'report' in search field"
- `selectOption select.language "Czech"` → "Select Czech from language dropdown"

Labels are descriptive (what happened), not marketing (that's the agent's job for voiceover).

### Thumbnail Extraction

For each step, find the screencast frame closest to `startTime + 500ms` (slightly after the action starts, so the UI state is visible). Extract JPEG from trace zip to `<traceDir>/thumbnails/<stepId>.jpg`.

## Module Breakdown

### New Files

```
src/mcp/
  server.ts             — MCP server entry point (stdio transport)
  tools/
    record-session.ts   — record_session tool handler
    analyze-trace.ts    — analyze_trace tool handler + step grouping
    render-video.ts     — render_video tool handler + pipeline building
    get-thumbnail.ts    — get_step_thumbnail tool handler
    list-recordings.ts  — list_recordings tool handler
  analyzer.ts           — Step grouping algorithm + label generation
  srt-builder.ts        — Generate SRT from steps with voiceover text
```

### Modified Files

```
package.json            — Add MCP SDK dependency, bin entry, export map entry
tsconfig.json           — Include src/mcp/ in build
```

### Unchanged (reused as-is)

```
src/studio/recorder.ts      — Recording (called by record_session tool)
src/parse/trace-parser.ts   — Trace parsing (called by analyzer)
src/pipeline/pipeline.ts    — Fluent pipeline API (called by render tool)
src/voiceover/providers/*   — TTS providers (used in render pipeline)
src/subtitles/srt-writer.ts — SRT generation utilities
```

## Dependencies

### New Production Dependency

- `@modelcontextprotocol/sdk` — MCP server SDK (stdio transport)

### Existing (unchanged)

- `fflate` — Trace zip handling

## Package.json Changes

```jsonc
{
  "bin": {
    "playwright-recast": "./dist/cli.js",
    "recast-studio": "./dist/studio/cli.js",
    "recast-mcp": "./dist/mcp/server.js"        // NEW
  },
  "exports": {
    // ... existing exports ...
    "./mcp": {                                    // NEW
      "types": "./dist/mcp/server.d.ts",
      "default": "./dist/mcp/server.js"
    }
  },
  "dependencies": {
    "fflate": "^0.8.2",
    "@modelcontextprotocol/sdk": "^1.29.0"       // NEW
  }
}
```

## MCP Server Configuration

Users configure the MCP server in their AI agent's settings:

### Claude Code (`~/.claude.json` or project `.mcp.json`)

```json
{
  "mcpServers": {
    "recast": {
      "command": "npx",
      "args": ["recast-mcp"],
      "env": {
        "OPENAI_API_KEY": "sk-...",
        "ELEVENLABS_API_KEY": "..."
      }
    }
  }
}
```

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "recast": {
      "command": "npx",
      "args": ["recast-mcp"],
      "env": {
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

## Server Implementation (server.ts)

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const server = new McpServer({
  name: 'playwright-recast',
  version: '0.12.0',
})

// Register tools
server.tool('record_session', schema, handler)
server.tool('analyze_trace', schema, handler)
server.tool('get_step_thumbnail', schema, handler)
server.tool('render_video', schema, handler)
server.tool('list_recordings', schema, handler)

// Start
const transport = new StdioServerTransport()
await server.connect(transport)
```

## SRT Builder (srt-builder.ts)

Generates SRT file from steps with voiceover text:

```typescript
function buildSrt(
  steps: Array<{ startTimeMs: number; endTimeMs: number; voiceover: string }>,
): string
```

- Each visible step with voiceover becomes one SRT entry
- Timing uses trace-relative milliseconds
- Last entry extends 5000ms beyond start for natural ending
- Written to `<traceDir>/voiceover.srt`

## Pipeline Builder (render-video.ts)

Translates MCP render_video input into Pipeline execution:

1. Write SRT from steps voiceover text
2. Build Pipeline:
   ```
   Recast.from(traceDir)
     .parse()
     .hideSteps(hiddenPredicate)
     .speedUp(speedConfig)
     .subtitlesFromSrt(srtPath)
     .textProcessing({ builtins: true })
     .autoZoom({ inputLevel: 1.2 })     // if enabled
     .cursorOverlay()                     // if enabled
     .clickEffect({ sound: true })        // if enabled
     .voiceover(ttsProvider)              // if provider != 'none'
     .render(renderConfig)
     .toFile(outputPath)
   ```
3. Return result metadata

## How It Differs from the Claude Code Plugin

The existing Claude Code plugin (`playwright-recast` skills) works similarly but:
- Is Claude Code-specific (skills are Claude Code concepts)
- Requires the developer to invoke `/studio-workflow`
- Hardcodes pipeline configuration in the skill

The MCP server:
- Works with ANY MCP-compatible agent (Claude Desktop, Claude Code, ChatGPT, custom agents)
- Exposes tools that any agent can discover and use
- Keeps configuration flexible (agent decides based on conversation)
- The `studio-workflow` and `script-writer` skills become optional convenience wrappers on top

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| `record_session` blocks for minutes | MCP protocol handles long-running tools; agent can communicate "interact with the browser now" |
| Browser not opening on remote/headless machine | Tool returns error with clear message; recording requires a display |
| Large trace thumbnails bloat MCP responses | Extract to disk, return file paths; `get_step_thumbnail` serves individually |
| TTS API key not configured | Graceful fallback: render without voiceover, warn in output |
| Agent writes poor voiceover | User iterates conversationally; the whole point is collaborative editing |
| Pipeline blocks during render (ffmpeg) | MCP tool just waits; render times are typically 30-120s |

## Implementation Sequence

### Phase 1: Core MCP Server

1. `src/mcp/server.ts` — MCP server with stdio transport
2. `src/mcp/analyzer.ts` — Step grouping + label generation + thumbnail extraction
3. `src/mcp/srt-builder.ts` — SRT generation from steps
4. `src/mcp/tools/record-session.ts` — Wrapper around existing recorder
5. `src/mcp/tools/analyze-trace.ts` — Trace analysis tool
6. `src/mcp/tools/render-video.ts` — Pipeline builder + renderer
7. `src/mcp/tools/get-thumbnail.ts` — Thumbnail serving
8. `src/mcp/tools/list-recordings.ts` — Recording listing
9. `package.json` — Add MCP SDK, bin entry, export

### Phase 2: Polish

- MCP resources for recordings and thumbnails
- Progress notifications during render (MCP notifications)
- Intro/outro support in render settings
- Background music configuration
- Zoom override configuration per step

## Verification Plan

1. **Unit tests:** Step grouping algorithm with mock trace data
2. **Integration test:** Record a session on a test page, analyze, render with voiceover
3. **MCP protocol test:** Connect via stdio, call each tool, verify responses
4. **End-to-end:** Configure in Claude Code `.mcp.json`, have agent create a full demo video
