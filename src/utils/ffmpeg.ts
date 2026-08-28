import { execFileSync } from 'node:child_process'

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
  try {
    execFileSync('ffmpeg', args, { stdio: 'pipe', maxBuffer: MAX_FFMPEG_OUTPUT })
  } catch (error: unknown) {
    throw new Error(describeFfmpegFailure(error), { cause: error })
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
