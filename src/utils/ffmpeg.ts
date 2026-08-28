import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * Assert that both `ffmpeg` and `ffprobe` are available on the system PATH.
 * Throws a descriptive error if either binary is missing, so the user gets
 * a clear message instead of a cryptic ENOENT later in the pipeline.
 */
export function assertFfmpegAvailable(): void {
  for (const bin of ['ffmpeg', 'ffprobe'] as const) {
    try {
      execFileSync(bin, ['-version'], { stdio: 'pipe' })
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        throw new Error(
          `"${bin}" is not installed or not on PATH. ` +
            `Install ffmpeg (https://ffmpeg.org/download.html) and ensure both ffmpeg and ffprobe are accessible.`,
        )
      }
      // If the binary exists but returned a non-zero exit code, that's fine —
      // it means the binary is present. Some ffmpeg builds exit(1) for -version
      // on certain platforms, which is acceptable.
    }
  }
}

/** ffmpeg repeats long filter expressions in its diagnostics, so allow room. */
const MAX_FFMPEG_OUTPUT = 64 * 1024 * 1024
/** Lines kept from each end of ffmpeg's output, and their max width. */
const HEAD_LINES = 8
const TAIL_LINES = 20
const MAX_LINE_LENGTH = 240

/**
 * Run ffmpeg, raising an error that carries ffmpeg's own diagnostics.
 *
 * `execFileSync` defaults to a 1MB output buffer, and a filter parse error
 * echoes the whole graph on every nesting level, so a big screencast failed
 * with a bare `spawnSync ffmpeg ENOBUFS` and nothing else.
 */
export function runFfmpeg(args: string[]): void {
  const spilled = spillLargeFilters(args)
  try {
    execFileSync('ffmpeg', spilled.args, { stdio: 'pipe', maxBuffer: MAX_FFMPEG_OUTPUT })
  } catch (error: unknown) {
    // Keep the spilled graphs — they are the failing input worth inspecting.
    throw new Error(describeFfmpegFailure(error) + spilled.note(), { cause: error })
  }
  spilled.discard()
}

/** Filter options and the file-based equivalent ffmpeg reads them from. */
const FILTER_SCRIPT_OPTIONS: Record<string, string> = {
  '-filter_complex': '-filter_complex_script',
  '-lavfi': '-filter_complex_script',
  '-vf': '-filter_script:v',
  '-filter:v': '-filter_script:v',
  '-af': '-filter_script:a',
  '-filter:a': '-filter_script:a',
}

/**
 * Linux caps one argv entry at 128KB (MAX_ARG_STRLEN) and filter graphs grow
 * with the screencast — the cursor overlay alone spends ~380 bytes per
 * keyframe. Anything larger goes to a file ffmpeg reads instead.
 */
const MAX_INLINE_FILTER = 60 * 1024

interface SpilledFilters {
  args: string[]
  /** Remove the temp files. Best effort, and only once ffmpeg succeeded. */
  discard: () => void
  /** Where the graphs went, for a failure message. */
  note: () => string
}

function spillLargeFilters(args: string[]): SpilledFilters {
  let dir: string | undefined
  const files: string[] = []
  const spilledArgs = [...args]

  for (let i = 0; i + 1 < spilledArgs.length; i++) {
    const scriptOption = FILTER_SCRIPT_OPTIONS[spilledArgs[i]!]
    const graph = spilledArgs[i + 1]!
    if (scriptOption === undefined || Buffer.byteLength(graph) <= MAX_INLINE_FILTER) continue

    dir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'recast-filter-'))
    const file = path.join(dir, `filter-${files.length}.txt`)
    // No trailing newline: ffmpeg reads the file as the whole graph.
    fs.writeFileSync(file, graph)
    files.push(file)
    spilledArgs[i] = scriptOption
    spilledArgs[i + 1] = file
    i++
  }

  return {
    args: spilledArgs,
    discard: () => {
      if (dir === undefined) return
      // A render that worked must not fail over leftover temp files.
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    },
    note: () => files.length === 0
      ? ''
      : `\nFilter graph${files.length === 1 ? '' : 's'} passed as file(s): ${files.join(', ')}`,
  }
}

function describeFfmpegFailure(error: unknown): string {
  const err = error as NodeJS.ErrnoException & { status?: number | null; stderr?: Buffer | string }
  if (err.code === 'ENOENT') {
    return '"ffmpeg" is not installed or not on PATH.'
  }

  const status = err.status ?? null
  const header = `ffmpeg failed${status === null ? '' : ` (exit ${status})`}${err.code ? ` [${err.code}]` : ''}`
  const output = err.stderr?.toString() ?? ''
  if (output.trim() === '') return `${header}: no output captured.`

  const lines = output.split('\n').filter(line => line.trim() !== '')
    .map(line => (line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line))

  // Parse errors report at the top, encoding errors at the bottom — keep both.
  const kept = lines.length <= HEAD_LINES + TAIL_LINES
    ? lines
    : [
      ...lines.slice(0, HEAD_LINES),
      `… ${lines.length - HEAD_LINES - TAIL_LINES} line(s) omitted …`,
      ...lines.slice(-TAIL_LINES),
    ]

  return `${header}:\n${kept.join('\n')}`
}
