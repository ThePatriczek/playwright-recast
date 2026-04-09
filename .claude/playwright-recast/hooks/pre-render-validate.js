#!/usr/bin/env node
// Crossplatform pre-render validation hook (Linux, Mac, Windows)
// Validates that all visible steps have voiceover text before rendering.

const input = process.env.TOOL_INPUT
if (!input) {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }))
  process.exit(0)
}

try {
  const data = JSON.parse(input)
  const steps = data.steps || []
  const missing = steps
    .filter(s => !s.hidden && (!s.voiceover || !s.voiceover.trim()))
    .map(s => s.id)

  if (missing.length > 0) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Missing voiceover text for visible steps: ${missing.join(', ')}. Please write voiceover for all visible steps before rendering.`,
      },
    }))
  } else {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }))
  }
} catch {
  // Parse error — allow and let MCP server handle validation
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }))
}
