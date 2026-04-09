import { z } from 'zod'
import * as path from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RecastMcpConfig } from '../config.js'
import { analyzeTrace } from '../analyzer.js'

export function registerAnalyzeTrace(server: McpServer, _config: RecastMcpConfig): void {
  server.registerTool(
    'analyze_trace',
    {
      title: 'Analyze Recording',
      description: 'Parses a Playwright trace and returns structured steps with action descriptions and timing. Auto-detects hidden steps (login, setup, cookie consent). Use the returned steps to write voiceover text, then pass to render_video.',
      inputSchema: z.object({
        traceDir: z.string().describe('Directory containing trace.zip (returned by record_session)'),
      }),
    },
    async ({ traceDir }) => {
      const resolvedDir = path.resolve(traceDir)
      try {
        const { metadata, steps, dispose } = await analyzeTrace(resolvedDir)
        dispose()
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ metadata, steps }, null, 2) }],
        }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Analysis failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        }
      }
    },
  )
}
