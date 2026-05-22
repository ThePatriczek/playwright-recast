import * as fs from 'node:fs'
import * as os from 'node:os'

/** Resolve options.workDir → existing directory. Call once per synthesize(). */
export function resolveWorkDir(workDir: string | undefined): string {
  const dir = workDir ?? os.tmpdir()
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
