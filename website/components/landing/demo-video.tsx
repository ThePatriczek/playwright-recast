'use client'

import { BlurFade } from '@/components/magicui/blur-fade'
import { Play } from 'lucide-react'
import { useState } from 'react'

const DEMO_VIDEO_URL =
  'https://github.com/user-attachments/assets/418d996d-2e18-4ae8-9ccc-3e5161dc7af8'

export function DemoVideo() {
  const [playing, setPlaying] = useState(false)

  return (
    <section className="relative px-6 py-24">
      <div className="mx-auto max-w-5xl">
        <BlurFade delay={0.1}>
          <div className="mb-12 text-center">
            <h2 className="text-3xl font-bold text-fd-foreground sm:text-4xl">
              See it in action
            </h2>
            <p className="mt-4 text-lg text-fd-muted-foreground">
              A Playwright trace transformed into a polished demo video with
              voiceover, subtitles, and visual effects.
            </p>
          </div>
        </BlurFade>

        <BlurFade delay={0.2}>
          <div className="relative mx-auto overflow-hidden rounded-2xl border border-fd-border bg-fd-card shadow-2xl">
            <div className="relative aspect-video">
              {!playing ? (
                <button
                  onClick={() => setPlaying(true)}
                  className="group absolute inset-0 flex cursor-pointer items-center justify-center bg-black/5 transition-colors hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10"
                >
                  <div className="flex h-20 w-20 items-center justify-center rounded-full bg-fd-primary/90 shadow-lg transition-transform group-hover:scale-110">
                    <Play className="h-8 w-8 text-white" fill="white" />
                  </div>
                </button>
              ) : (
                <video
                  src={DEMO_VIDEO_URL}
                  controls
                  autoPlay
                  playsInline
                  className="h-full w-full"
                />
              )}
            </div>
          </div>
        </BlurFade>
      </div>
    </section>
  )
}
