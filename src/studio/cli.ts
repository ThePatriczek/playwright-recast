#!/usr/bin/env node
import * as path from 'node:path'
import { parseArgs } from 'node:util'
import { record } from './recorder.js'

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: 'string', short: 'o', default: '.recast-studio' },
    viewport: { type: 'string', default: '1920x1080' },
    'load-storage': { type: 'string' },
    'ignore-https-errors': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
})

if (args.help || positionals.length === 0) {
  console.log(`
Usage: recast-studio [options] <url>

Record a browser session as a Playwright trace for demo video generation.

Arguments:
  url                         URL to open in the browser

Options:
  -o, --output <dir>          Output directory (default: .recast-studio/)
  --viewport <WxH>            Browser viewport (default: 1920x1080)
  --load-storage <path>       Pre-load auth state (from playwright codegen --save-storage)
  --ignore-https-errors       Ignore certificate errors
  -h, --help                  Show this help

After recording, use the studio-workflow Claude Code skill to generate the video:
  > /studio-workflow .recast-studio/
`)
  process.exit(positionals.length === 0 && !args.help ? 1 : 0)
}

const url = positionals[0]!
const [vw, vh] = (args.viewport ?? '1920x1080').split('x').map(Number)
const outputDir = path.resolve(args.output ?? '.recast-studio')

async function main() {
  console.log(`\n🎬  Opening browser at ${url}`)
  console.log('    Navigate and interact. Close the browser when done.\n')

  const result = await record(url, outputDir, {
    viewport: { width: vw ?? 1920, height: vh ?? 1080 },
    loadStorage: args['load-storage'],
    ignoreHttpsErrors: args['ignore-https-errors'] ?? false,
  })

  if (result.actionCount === 0) {
    console.error('❌  No interactions recorded. Try again and click around before closing.')
    process.exit(1)
  }

  console.log(`✅  Trace saved to ${result.outputDir}/ (${(result.durationMs / 1000).toFixed(0)}s, ${result.actionCount} actions)`)
  console.log(`\n    Next: use the studio-workflow skill to generate the video:`)
  console.log(`    > /studio-workflow ${result.outputDir}/\n`)
}

main().catch((err) => {
  console.error('❌  Error:', err.message ?? err)
  process.exit(1)
})
