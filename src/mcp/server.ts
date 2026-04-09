#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig } from './config.js'
import { registerRecordSession } from './tools/record-session.js'
import { registerAnalyzeTrace } from './tools/analyze-trace.js'
import { registerGetThumbnail } from './tools/get-thumbnail.js'
import { registerRenderVideo } from './tools/render-video.js'
import { registerListRecordings } from './tools/list-recordings.js'

const config = loadConfig()

const server = new McpServer(
  { name: 'playwright-recast', version: '0.12.0' },
  {
    instructions: [
      'This server creates demo videos from browser recordings.',
      'Typical workflow: record_session → analyze_trace → (user edits voiceover) → render_video.',
      '',
      'Configuration (via env vars):',
      `  TTS provider: ${config.ttsProvider}${config.ttsProvider === 'none' ? ' (no API key found — set OPENAI_API_KEY or ELEVENLABS_API_KEY)' : ''}`,
      `  Resolution: ${config.resolution}`,
      `  Work dir: ${config.workDir}`,
    ].join('\n'),
  },
)

registerRecordSession(server, config)
registerAnalyzeTrace(server, config)
registerGetThumbnail(server, config)
registerRenderVideo(server, config)
registerListRecordings(server, config)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('playwright-recast MCP server running on stdio')
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
