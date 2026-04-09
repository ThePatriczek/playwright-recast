export interface RecastMcpConfig {
  /** Working directory for recordings. Default: cwd */
  workDir: string
  /** Default TTS provider */
  ttsProvider: 'openai' | 'elevenlabs' | 'none'
  /** Default voice ID (provider-specific) */
  ttsVoice: string
  /** Default TTS model */
  ttsModel: string
  /** OpenAI API key */
  openaiApiKey: string
  /** ElevenLabs API key */
  elevenlabsApiKey: string
  /** Default output resolution */
  resolution: '720p' | '1080p' | '1440p' | '4k'
  /** Default output FPS */
  fps: number
  /** Default viewport for recording */
  viewport: { width: number; height: number }
  /** Default intro video path (empty = none) */
  introPath: string
  /** Default outro video path (empty = none) */
  outroPath: string
  /** Enable click sound effects. Default: true */
  clickSound: boolean
  /** Default background music path (empty = none) */
  backgroundMusicPath: string
  /** Background music volume 0.0-1.0. Default: 0.15 */
  backgroundMusicVolume: number
}

export function loadConfig(): RecastMcpConfig {
  const ttsProvider = resolveProvider()

  return {
    workDir: env('RECAST_WORK_DIR', process.cwd()),
    ttsProvider,
    ttsVoice: env('RECAST_TTS_VOICE', ttsProvider === 'elevenlabs' ? '3HdFueVb2f3yUQzeEpyz' : 'nova'),
    ttsModel: env('RECAST_TTS_MODEL', ttsProvider === 'elevenlabs' ? 'eleven_multilingual_v2' : 'gpt-4o-mini-tts'),
    openaiApiKey: env('OPENAI_API_KEY', ''),
    elevenlabsApiKey: env('ELEVENLABS_API_KEY', ''),
    resolution: env('RECAST_RESOLUTION', '4k') as RecastMcpConfig['resolution'],
    fps: Number(env('RECAST_FPS', '120')),
    viewport: {
      width: Number(env('RECAST_VIEWPORT_WIDTH', '1920')),
      height: Number(env('RECAST_VIEWPORT_HEIGHT', '1080')),
    },
    introPath: env('RECAST_INTRO_PATH', ''),
    outroPath: env('RECAST_OUTRO_PATH', ''),
    clickSound: env('RECAST_CLICK_SOUND', 'true') === 'true',
    backgroundMusicPath: env('RECAST_BACKGROUND_MUSIC', ''),
    backgroundMusicVolume: Number(env('RECAST_BACKGROUND_MUSIC_VOLUME', '0.15')),
  }
}

function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback
}

/** Auto-detect TTS provider from available API keys */
function resolveProvider(): RecastMcpConfig['ttsProvider'] {
  const explicit = process.env.RECAST_TTS_PROVIDER
  if (explicit === 'openai' || explicit === 'elevenlabs' || explicit === 'none') return explicit

  if (process.env.OPENAI_API_KEY) return 'openai'
  if (process.env.ELEVENLABS_API_KEY) return 'elevenlabs'
  return 'none'
}
