import type { TraceAction } from '../types/trace.js'
import type { SpeedConfig } from '../types/speed.js'
import type { SubtitleOptions } from '../types/subtitle.js'
import type { TtsProvider } from '../types/voiceover.js'
import type { RenderConfig } from '../types/render.js'
import type { TextProcessingConfig } from '../types/text-processing.js'
import type { ClickEffectConfig } from '../types/click-effect.js'
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
   * Add click highlighting effects to the video.
   * Renders animated ripple at each click position with optional sound.
   * Requires parse() first (needs trace actions with cursor positions).
   */
  clickEffect(config: ClickEffectConfig = {}): Pipeline {
    return this.addStage({ type: 'clickEffect', config })
  }

  /** Generate voiceover audio from subtitles using a TTS provider */
  voiceover(provider: TtsProvider): Pipeline {
    return this.addStage({ type: 'voiceover', provider })
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
