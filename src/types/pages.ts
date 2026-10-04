/** Configuration for the `.pages()` pipeline stage: how pages other than the primary one show. */
export interface PagesConfig {
  /**
   * A page smaller than the frame (a window.open popup):
   * - `'overlay'`: centered on top of the page that was on screen, which stays visible, darkened
   * - `'replace'`: centered on a plain background
   * Default: `'overlay'`
   */
  popup?: 'overlay' | 'replace'
  /**
   * A page that fills the frame (a new tab):
   * - `'replace'`: takes the whole frame, a hard switch
   * - `'overlay'`: shrunk to `tabScale` on top of the darkened page behind it
   * Default: `'replace'`
   */
  tab?: 'replace' | 'overlay'
  /** Size of an overlaid tab relative to the frame. Default: 0.85 */
  tabScale?: number
  backdrop?: {
    /** How much the page behind an overlay is darkened, 0-1. Default: 0.6 */
    dim?: number
    /** Background behind a replacing popup, hex `#RRGGBB`. Default: `'#000000'` */
    color?: string
  }
}
