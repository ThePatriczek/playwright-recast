import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
process.chdir(root)
if (existsSync('.env')) process.loadEnvFile('.env')

const { values } = parseArgs({
  options: {
    mock: { type: 'boolean', default: false },
    headed: { type: 'boolean', default: true },
    headless: { type: 'boolean', default: false },
    channel: { type: 'string' },
    'no-render': { type: 'boolean', default: false },
    url: { type: 'string' },
    scenario: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
})

function command(binary, args, env = process.env, stdio = 'inherit') {
  return new Promise((resolveResult, reject) => {
    const child = spawn(binary, args, { cwd: root, env, stdio })
    child.once('error', reject)
    child.once('exit', code => resolveResult(code ?? 1))
  })
}

async function main() {
  if (values.help) {
    console.log('npm run poc:jev -- [--mock] [--headless] [--channel chrome] [--no-render] [--url URL --scenario FILE]')
    console.log('Set TYPESAFE_EKY or TYPESAFE_API_KEY in .env. Default: local Atlas demo, live Jev decisions.')
    return
  }
  if (!values.mock && !process.env.TYPESAFE_EKY && !process.env.TYPESAFE_API_KEY) {
    throw new Error('Missing key. Add TYPESAFE_EKY=your-key to .env, or run npm run poc:jev -- --mock')
  }
  if (values.url && !values.scenario) throw new Error('--url requires --scenario with an explicit goal and completion check')
  if (values.mock && (values.url || values.scenario)) throw new Error('--mock runs only the bundled scenario')
  if (values.channel && !['chrome', 'chromium'].includes(values.channel)) throw new Error('--channel must be chrome or chromium')
  if (values.url && !['http:', 'https:'].includes(new URL(values.url).protocol)) throw new Error('--url must use HTTP or HTTPS')
  if (!values['no-render']) {
    for (const binary of ['ffmpeg', 'ffprobe']) {
      if (await command(binary, ['-version'], process.env, 'ignore') !== 0) throw new Error(`${binary} is required for rendering`)
    }
  }
  if (await command(process.execPath, ['node_modules/typescript/bin/tsc']) !== 0) throw new Error('Recast build failed')
  const output = join(root, 'test-results', 'jev', `${new Date().toISOString().replace(/[:.]/g, '-')}-${values.mock ? 'mock' : 'live'}`)
  await mkdir(output, { recursive: true })
  console.log(`Artifacts: ${output}`)
  console.log(`Decision mode: ${values.mock ? 'SCRIPTED SIMULATION (no model calls)' : 'LIVE JEV'}`)
  let server
  try {
    let url = values.url
    if (!url) {
      const html = await readFile(join(root, 'demo/jev/demo.html'))
      server = createServer((request, response) => {
        if (request.url !== '/') { response.writeHead(404); response.end(); return }
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(html)
      })
      await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Local demo failed to bind a TCP port')
      url = `http://127.0.0.1:${address.port}`
    }
    const status = await command(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config', 'demo/jev/playwright.config.ts'], {
      ...process.env,
      JEV_OUTPUT: output,
      JEV_URL: url,
      JEV_SCENARIO: resolve(values.scenario || 'demo/jev/scenario.json'),
      JEV_MOCK: values.mock ? '1' : '0',
      JEV_HEADED: values.headless ? '0' : '1',
      JEV_CHANNEL: values.channel || '',
    })
    const resultPath = join(output, 'run.json')
    if (!existsSync(resultPath)) throw new Error(`Recording did not start. Check Playwright output. Artifacts: ${output}`)
    const result = JSON.parse(await readFile(resultPath, 'utf8'))
    if (!values['no-render']) {
      const { Pipeline } = await import('../../dist/pipeline/pipeline.js')
      const { stdout: filters } = await promisify(execFile)('ffmpeg', ['-hide_banner', '-filters'])
      const burnSubtitles = /\bass\s+V->V/.test(filters)
      if (!burnSubtitles) console.log('FFmpeg has no ass filter; captions will be embedded as a selectable subtitle track.')
      const videoPath = join(output, result.success ? 'demo.mp4' : 'failed.mp4')
      await Pipeline.from(result.recordingDirectory)
        .parse()
        .hideSteps(action => action.title === 'Jev decision')
        .speedUp({ duringIdle: 1, duringUserAction: 1, duringNetworkWait: 2, duringNavigation: 2, exactBoundaries: true })
        .subtitlesFromTrace()
        .cursorOverlay({ approachMs: 450, moveDurationMs: 350, hideAfterMs: 800 })
        .clickEffect({ color: '#818cf8', sound: true, soundVolume: 0.2 })
        .textHighlight()
        .render({ resolution: '720p', fps: 30, burnSubtitles, embedSubtitles: true, subtitleStyle: { fontSize: 26, marginVertical: 22 } })
        .toFile(videoPath)
      console.log(`Video: ${videoPath}`)
      result.video = videoPath
      await writeFile(resultPath, JSON.stringify(result, null, 2))
    }
    console.log(`Result: ${result.success ? 'goal verified' : 'FAILED'}; ${result.steps} actions; ${result.apiCalls} API calls; ${result.apiElapsedMs} ms in API calls`)
    console.log(`Decision log: ${join(output, 'decisions.jsonl')}`)
    process.exitCode = status || (result.success ? 0 : 1)
  } finally {
    if (server) await new Promise(resolveClose => server.close(resolveClose))
  }
}

await main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
