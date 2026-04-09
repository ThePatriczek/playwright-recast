import { describe, it, expect, beforeAll } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { execSync } from 'node:child_process'
import * as path from 'node:path'

const ROOT = path.resolve(__dirname, '../../..')
const SERVER_PATH = path.resolve(ROOT, 'dist/mcp/server.js')

describe('MCP server integration', () => {
  beforeAll(() => {
    execSync('npm run build', { cwd: ROOT, stdio: 'pipe' })
  })

  it('lists all 4 tools via MCP protocol', async () => {
    const transport = new StdioClientTransport({
      command: 'node',
      args: [SERVER_PATH],
      env: { RECAST_TTS_PROVIDER: 'none' },
      stderr: 'pipe',
    })

    const client = new Client({ name: 'test-client', version: '1.0.0' })
    await client.connect(transport)

    const { tools } = await client.listTools()
    const toolNames = tools.map((t) => t.name).sort()

    expect(toolNames).toEqual([
      'analyze_trace',
      'list_recordings',
      'record_session',
      'render_video',
    ])

    await client.close()
  }, 15000)
})
