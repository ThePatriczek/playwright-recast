/**
 * One branch of a piecewise ffmpeg expression. Branches must be in time order:
 * once t reaches a branch it has reached every earlier one too.
 */
export interface Branch {
  /** True while t has not reached this branch. Unused for the first one. */
  before: string
  expr: string
}

/**
 * Nest time-ordered branches as a binary search that picks the last branch t
 * has reached, one if() per level. ffmpeg's expression parser allows ~100
 * nesting levels (libavutil/eval.c), which a chain of one if() per branch
 * exceeds on long videos. `sep` is the argument separator, escaped as the
 * surrounding filter string needs it.
 */
export function searchBranches(branches: Branch[], sep = ','): string {
  if (branches.length === 0) throw new Error('searchBranches needs at least one branch')
  const build = (lo: number, hi: number): string => {
    if (lo === hi) return branches[lo]!.expr
    // Right half keeps `mid`, so coincident starts resolve to the later branch.
    const mid = Math.ceil((lo + hi) / 2)
    return `if(${branches[mid]!.before}${sep}${build(lo, mid - 1)}${sep}${build(mid, hi)})`
  }
  return build(0, branches.length - 1)
}
