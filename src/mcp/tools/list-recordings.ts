import { z } from 'zod'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RecastMcpConfig } from '../config.js'

export function registerListRecordings(server: McpServer, config: RecastMcpConfig): void {
  server.registerTool(
    'list_recordings',
    {
      title: 'List Recordings',
      description: 'Lists available trace recordings in a directory.',
      inputSchema: z.object({
        dir: z.string().optional().describe('Directory to scan. Default: working directory'),
      }),
    },
    async ({ dir }) => {
      const scanDir = path.resolve(dir ?? config.workDir)
      if (!fs.existsSync(scanDir)) {
        return {
          content: [{ type: 'text' as const, text: `Directory not found: ${scanDir}` }],
          isError: true,
        }
      }
      const recordings: Array<{
        traceDir: string
        hasVideo: boolean
        hasSrt: boolean
        hasRendered: boolean
        modifiedAt: string
      }> = []

      // Check subdirectories
      for (const entry of fs.readdirSync(scanDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const subdir = path.join(scanDir, entry.name)
        const files = fs.readdirSync(subdir)
        if (!files.includes('trace.zip')) continue
        recordings.push({
          traceDir: subdir,
          hasVideo: files.some((f) => f.endsWith('.webm')),
          hasSrt: files.includes('subtitles.srt') || files.includes('voiceover.srt'),
          hasRendered: files.some((f) => f.startsWith('demo.') || f.startsWith('recast-final.')),
          modifiedAt: fs.statSync(path.join(subdir, 'trace.zip')).mtime.toISOString(),
        })
      }

      // Check scanDir itself
      if (fs.readdirSync(scanDir).includes('trace.zip')) {
        const files = fs.readdirSync(scanDir)
        recordings.unshift({
          traceDir: scanDir,
          hasVideo: files.some((f) => f.endsWith('.webm')),
          hasSrt: files.some((f) => f === 'subtitles.srt' || f === 'voiceover.srt'),
          hasRendered: files.some((f) => f.startsWith('demo.') || f.startsWith('recast-final.')),
          modifiedAt: fs.statSync(path.join(scanDir, 'trace.zip')).mtime.toISOString(),
        })
      }

      recordings.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime())

      if (recordings.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No recordings found in ${scanDir}. Use record_session first.` }],
        }
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify({ recordings }, null, 2) }] }
    },
  )
}
