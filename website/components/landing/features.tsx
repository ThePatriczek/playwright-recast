'use client'

import { BlurFade } from '@/components/magicui/blur-fade'
import {
  Workflow,
  Mic,
  Gauge,
  Subtitles,
  MousePointerClick,
  ZoomIn,
  Music,
  Terminal,
  Puzzle,
} from 'lucide-react'
import type { ReactNode } from 'react'

interface Feature {
  name: string
  description: string
  icon: ReactNode
}

const features: Feature[] = [
  {
    name: 'Fluent Pipeline API',
    description:
      'Chainable, immutable, lazy-evaluated. Build complex video pipelines that read like English.',
    icon: <Workflow className="h-5 w-5" />,
  },
  {
    name: 'TTS Voiceover',
    description:
      'Generate narration with OpenAI TTS or ElevenLabs. Timed with silence padding and ducking.',
    icon: <Mic className="h-5 w-5" />,
  },
  {
    name: 'Smart Speed Control',
    description:
      'Speed up idle time and network waits automatically while keeping user actions at normal speed.',
    icon: <Gauge className="h-5 w-5" />,
  },
  {
    name: 'Styled Subtitles',
    description:
      'SRT, WebVTT, and ASS output. Burn into video with configurable font, color, and position.',
    icon: <Subtitles className="h-5 w-5" />,
  },
  {
    name: 'Click Effects & Cursor',
    description:
      'Animated ripple highlights with sound at click positions. Cursor overlay with ease-out motion.',
    icon: <MousePointerClick className="h-5 w-5" />,
  },
  {
    name: 'Animated Zoom',
    description:
      'Auto-zoom to user actions with customizable easing. Smooth panning between zoom targets.',
    icon: <ZoomIn className="h-5 w-5" />,
  },
  {
    name: 'Music & Intro/Outro',
    description:
      'Background music with auto-ducking. Prepend/append branded clips with crossfade transitions.',
    icon: <Music className="h-5 w-5" />,
  },
  {
    name: 'CLI Included',
    description:
      'npx playwright-recast -i trace.zip -o demo.mp4 — full pipeline from the command line.',
    icon: <Terminal className="h-5 w-5" />,
  },
  {
    name: 'Zero Lock-in',
    description:
      'Every stage is optional and composable. Use just the trace parser, subtitles, or the full pipeline.',
    icon: <Puzzle className="h-5 w-5" />,
  },
]

function FeatureCard({ name, description, icon }: Feature) {
  return (
    <div className="group relative rounded-xl border border-fd-border bg-fd-card p-6 transition-all duration-200 hover:border-fd-primary/20 hover:shadow-lg hover:shadow-fd-primary/5">
      <div className="mb-4 inline-flex rounded-lg border border-fd-border bg-fd-background p-2.5 text-fd-primary transition-colors group-hover:border-fd-primary/30 group-hover:bg-fd-primary/5">
        {icon}
      </div>
      <h3 className="text-base font-semibold text-fd-foreground">{name}</h3>
      <p className="mt-2 text-sm leading-relaxed text-fd-muted-foreground">
        {description}
      </p>
    </div>
  )
}

export function Features() {
  return (
    <section className="relative px-4 py-16 sm:px-6 sm:py-24">
      <div className="mx-auto max-w-5xl">
        <BlurFade delay={0.1}>
          <div className="mb-14 text-center">
            <h2 className="text-3xl font-bold tracking-tight text-fd-foreground sm:text-4xl">
              Everything you need
            </h2>
            <p className="mx-auto mt-4 max-w-lg text-base text-fd-muted-foreground">
              From trace parsing to polished video — every stage is composable
              and optional.
            </p>
          </div>
        </BlurFade>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature, i) => (
            <BlurFade key={feature.name} delay={0.05 + i * 0.04}>
              <FeatureCard {...feature} />
            </BlurFade>
          ))}
        </div>
      </div>
    </section>
  )
}
