import { z } from 'zod'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RecastMcpConfig } from '../config.js'

export function registerGetThumbnail(server: McpServer, _config: RecastMcpConfig): void {
  server.registerTool(
    'get_step_thumbnail',
    {
      title: 'Get Step Screenshot',
      description: 'Returns a screenshot for a specific step. Use after analyze_trace.',
      inputSchema: z.object({
        traceDir: z.string().describe('Directory containing trace.zip'),
        stepId: z.string().describe('Step ID from analyze_trace (e.g. "step-1")'),
      }),
    },
    async ({ traceDir, stepId }) => {
      const thumbPath = path.join(path.resolve(traceDir), 'thumbnails', `${stepId}.jpg`)
      if (!fs.existsSync(thumbPath)) {
        return {
          content: [{ type: 'text' as const, text: `No thumbnail for ${stepId}. Run analyze_trace first.` }],
          isError: true,
        }
      }
      const data = fs.readFileSync(thumbPath)
      return {
        content: [{ type: 'image' as const, data: data.toString('base64'), mimeType: 'image/jpeg' }],
      }
    },
  )
}
