import { z } from 'zod'
import * as path from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RecastMcpConfig } from '../config.js'
import { record } from '../../studio/recorder.js'

export function registerRecordSession(server: McpServer, config: RecastMcpConfig): void {
  server.registerTool(
    'record_session',
    {
      title: 'Record Browser Session',
      description:
        'Opens a browser at the given URL for interactive recording. User navigates the app, clicks Resume in Inspector when done. Returns trace metadata.',
      inputSchema: z.object({
        url: z.string().url().describe('URL to open in the browser'),
        outputDir: z.string().optional().describe('Output directory. Default: .recast-studio/'),
        viewportWidth: z.number().int().positive().optional().describe('Viewport width. Default: 1920'),
        viewportHeight: z.number().int().positive().optional().describe('Viewport height. Default: 1080'),
        ignoreHttpsErrors: z.boolean().optional().describe('Ignore HTTPS errors. Default: false'),
        loadStorage: z.string().optional().describe('Path to Playwright storage state JSON'),
      }),
    },
    async ({ url, outputDir, viewportWidth, viewportHeight, ignoreHttpsErrors, loadStorage }) => {
      const outDir = path.resolve(outputDir ?? path.join(config.workDir, '.recast-studio'))
      try {
        const result = await record(url, outDir, {
          viewport: {
            width: viewportWidth ?? config.viewport.width,
            height: viewportHeight ?? config.viewport.height,
          },
          ignoreHttpsErrors: ignoreHttpsErrors ?? false,
          loadStorage,
        })
        if (result.actionCount === 0) {
          return {
            content: [{ type: 'text' as const, text: 'Recording completed but no interactions detected.' }],
            isError: true,
          }
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  traceDir: result.outputDir,
                  tracePath: result.tracePath,
                  videoPath: result.videoPath,
                  actionCount: result.actionCount,
                  durationMs: result.durationMs,
                },
                null,
                2,
              ),
            },
          ],
        }
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Recording failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    },
  )
}
