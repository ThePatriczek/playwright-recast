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
