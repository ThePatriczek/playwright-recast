import type { TraceAction } from '../types/trace.js'
import type { SpeedConfig } from '../types/speed.js'
import type { SubtitleOptions } from '../types/subtitle.js'
import type { TtsProvider, VoiceoverOptions } from '../types/voiceover.js'
import type { RenderConfig } from '../types/render.js'
import type { TextProcessingConfig } from '../types/text-processing.js'
import type { ClickEffectConfig } from '../types/click-effect.js'
import type { CursorOverlayConfig } from '../types/cursor-overlay.js'
import type { InterpolateConfig } from '../types/interpolate.js'
import type { TextHighlightConfig } from '../types/text-highlight.js'
import type { IntroConfig, OutroConfig } from '../types/intro-outro.js'
import type { BackgroundMusicConfig } from '../types/background-music.js'
import type { StageDescriptor, AutoZoomConfig } from './stages.js'
import { PipelineExecutor } from './executor.js'

/**
 * Immutable, fluent pipeline builder.
 *
 * Each method returns a new Pipeline with the stage appended.
 * Nothing executes until a terminal operation (.toFile(), .toBuffer()) is called.
 *
 * @example
 * ```typescript
 * await Recast
 *   .from('./test-results/')
 *   .parse()
 *   .hideSteps(s => s.keyword === 'Given')
 *   .speedUp({ duringIdle: 4.0 })
 *   .subtitles(s => s.docString ?? s.text)
 *   .voiceover(OpenAIProvider({ voice: 'nova' }))
 *   .render({ format: 'mp4' })
 *   .toFile('demo.mp4')
 * ```
 */
export class Pipeline {
  private constructor(
    private readonly source: string,
    private readonly stages: readonly StageDescriptor[],
  ) {}

  /** Create a new pipeline from a trace directory or zip file path */
  static from(source: string): Pipeline {
    return new Pipeline(source, [])
  }

  /** Parse the Playwright trace into structured data */
  parse(): Pipeline {
    return this.addStage({ type: 'parse' })
  }

  /**
   * Inject synthetic actions into the parsed trace.
   * Use after parse() to add DOM-tracked actions from recordings that don't produce
   * real trace actions (e.g. page.pause() sessions). The injected actions participate
   * in hideSteps, clickEffect, cursorOverlay, autoZoom, and speedUp.
   */
  injectActions(actions: TraceAction[]): Pipeline {
    return this.addStage({ type: 'injectActions', actions })
  }

  /** Filter out steps matching the predicate (they won't appear in the output video) */
  hideSteps(predicate: (action: TraceAction) => boolean): Pipeline {
    return this.addStage({ type: 'hideSteps', predicate })
  }

  /** Adjust video speed based on trace activity (network, user actions, idle) */
  speedUp(config: SpeedConfig): Pipeline {
    return this.addStage({ type: 'speedUp', config })
  }

  /** Generate subtitles from step text. The textFn extracts display text from each action. */
  subtitles(
    textFn: (action: TraceAction) => string | undefined,
    options?: SubtitleOptions,
  ): Pipeline {
    return this.addStage({ type: 'subtitles', textFn, options })
  }

  /** Use an existing SRT file as subtitle source (bypasses trace-based subtitle generation) */
  subtitlesFromSrt(srtPath: string): Pipeline {
    return this.addStage({ type: 'subtitlesFromSrt', srtPath })
  }

  /**
   * Generate subtitles directly from trace data (BDD step titles).
   * Extracts step text from parsed trace actions without requiring an external SRT file.
   * Uses action titles, BDD `text` fields, or falls back to the action `title` property.
   */
  subtitlesFromTrace(options?: SubtitleOptions): Pipeline {
    return this.addStage({ type: 'subtitlesFromTrace', options })
  }

  /**
   * Process subtitle text before voiceover synthesis.
   * Applies sanitization rules to clean subtitle text for TTS.
   * Requires subtitles(), subtitlesFromSrt(), or subtitlesFromTrace() first.
   */
  textProcessing(config: TextProcessingConfig): Pipeline {
    return this.addStage({ type: 'textProcessing', config })
  }

  /**
   * Auto-zoom based on trace action coordinates.
   * Zooms into click/fill targets during user actions, zooms out during idle.
   * No step-level code needed — works purely from trace metadata.
   */
  autoZoom(config: AutoZoomConfig = {}): Pipeline {
    return this.addStage({ type: 'autoZoom', config })
  }

  /**
   * Enrich subtitles with zoom data from a demo report (locator-based zoom from steps).
   * Each report step may have a `zoom: { x, y, level }` from the `zoom()` helper.
   */
  enrichZoomFromReport(
    steps: Array<{ zoom?: { x: number; y: number; level: number } | null }>,
  ): Pipeline {
    return this.addStage({ type: 'enrichZoomFromReport', steps })
  }

  /**
   * Add a smooth cursor overlay that animates between action positions.
   * Renders a visible cursor dot that follows the trace's action coordinates.
   * Requires parse() first (needs trace actions with cursor positions).
   */
  cursorOverlay(config: CursorOverlayConfig = {}): Pipeline {
    return this.addStage({ type: 'cursorOverlay', config })
  }

  /**
   * Add click highlighting effects to the video.
   * Renders animated ripple at each click position with optional sound.
   * Requires parse() first (needs trace actions with cursor positions).
   */
  clickEffect(config: ClickEffectConfig = {}): Pipeline {
    return this.addStage({ type: 'clickEffect', config })
  }

  /**
   * Add text highlight overlays to the video.
   * Renders animated marker (swipe reveal + fade out) at positions
   * captured by the highlight() helper in test steps.
   */
  textHighlight(config: TextHighlightConfig = {}): Pipeline {
    return this.addStage({ type: 'textHighlight', config })
  }

  /** Prepend an intro video with a crossfade transition into the main content */
  intro(config: IntroConfig): Pipeline {
    return this.addStage({ type: 'intro', config })
  }

  /** Append an outro video with a crossfade transition from the main content */
  outro(config: OutroConfig): Pipeline {
    return this.addStage({ type: 'outro', config })
  }

  /**
   * Apply frame interpolation to generate smooth intermediate frames.
   * Uses ffmpeg's minterpolate filter. Applied after all visual effects, before final encode.
   * Opt-in — not applied unless explicitly called.
   */
  interpolate(config: InterpolateConfig = {}): Pipeline {
    return this.addStage({ type: 'interpolate', config })
  }

  /** Add background music that auto-ducks during voiceover */
  backgroundMusic(config: BackgroundMusicConfig): Pipeline {
    return this.addStage({ type: 'backgroundMusic', config })
  }

  /**
   * Generate voiceover audio from subtitles using a TTS provider.
   *
   * @param provider  TTS provider (OpenAIProvider, ElevenLabsProvider, PollyProvider, ...).
   * @param options   Optional post-synthesis processing. `normalize: true` runs
   *                  each synthesized segment through EBU R128 two-pass loudnorm
   *                  (default -16 LUFS / -1 dBFS TP / 11 LU) before concat, which
   *                  fixes per-segment loudness drift common in ElevenLabs + czech.
   */
  voiceover(provider: TtsProvider, options?: VoiceoverOptions): Pipeline {
    return this.addStage({ type: 'voiceover', provider, options })
  }

  /** Configure video rendering options */
  render(config: RenderConfig = {}): Pipeline {
    return this.addStage({ type: 'render', config })
  }

  /** Terminal: execute the pipeline and write the result to a file */
  async toFile(outputPath: string): Promise<void> {
    const executor = new PipelineExecutor(this.source, this.stages)
    await executor.execute(outputPath)
  }

  /** Terminal: execute the pipeline and return the result as a buffer */
  async toBuffer(): Promise<Buffer> {
    const executor = new PipelineExecutor(this.source, this.stages)
    return executor.executeToBuffer()
  }

  /** Get the list of stages (for testing/debugging) */
  getStages(): readonly StageDescriptor[] {
    return this.stages
  }

  /** Get the trace source path */
  getSource(): string {
    return this.source
  }

  private addStage(stage: StageDescriptor): Pipeline {
    return new Pipeline(this.source, [...this.stages, stage])
  }
}
