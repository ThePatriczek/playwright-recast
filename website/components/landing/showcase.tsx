'use client'

import { BlurFade } from '@/components/magicui/blur-fade'
import { ExternalLink, Heart } from 'lucide-react'

const VIDEO_URL = 'https://www.youtube.com/watch?v=A20UqfxuKBA'
const EMBED_URL = 'https://www.youtube-nocookie.com/embed/A20UqfxuKBA'

export function Showcase() {
  return (
    <section
      id="showcase"
      className="relative border-t border-fd-border bg-fd-background px-4 py-16 sm:px-6 sm:py-24"
    >
      <div className="mx-auto max-w-5xl">
        <BlurFade delay={0.1}>
          <div className="mb-12 text-center">
            <p className="text-sm font-semibold tracking-[0.24em] text-fd-primary">
              SHOWCASE
            </p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-fd-foreground sm:text-4xl">
              Built with playwright-recast
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-base text-fd-muted-foreground">
              Community projects that turn real Playwright workflows into
              polished product stories.
            </p>
          </div>
        </BlurFade>

        <BlurFade delay={0.2}>
          <article className="overflow-hidden rounded-2xl border border-fd-border bg-fd-card shadow-2xl shadow-fd-primary/5">
            <div className="aspect-video bg-black">
              <iframe
                className="h-full w-full"
                src={EMBED_URL}
                title="Snowflake Cortex Neo4j Agent Integration"
                loading="lazy"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                referrerPolicy="strict-origin-when-cross-origin"
                allowFullScreen
              />
            </div>
            <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-7">
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest text-fd-primary">
                  Neo4j
                </p>
                <h3 className="mt-1 text-lg font-semibold text-fd-foreground sm:text-xl">
                  Snowflake Cortex Neo4j Agent Integration
                </h3>
              </div>
              <a
                href={VIDEO_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex shrink-0 items-center gap-2 text-sm font-medium text-fd-primary transition-opacity hover:opacity-75"
              >
                Watch on YouTube
                <ExternalLink className="h-4 w-4" />
              </a>
            </div>
          </article>
        </BlurFade>

        <BlurFade delay={0.3}>
          <div className="mt-8 flex flex-col items-center gap-3 rounded-2xl border border-fd-primary/20 bg-fd-primary/5 px-6 py-7 text-center sm:flex-row sm:justify-center sm:text-left">
            <Heart className="h-6 w-6 shrink-0 fill-fd-primary/15 text-fd-primary" />
            <p className="text-sm leading-relaxed text-fd-muted-foreground">
              <span className="font-semibold text-fd-foreground">
                A huge thank you to{' '}
                <a
                  href="https://github.com/Andy2003"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-fd-primary underline underline-offset-4"
                >
                  @Andy2003
                </a>
              </span>{' '}
              for the eight contributions that power the faster, more resilient
              v0.21.0 release.
            </p>
          </div>
        </BlurFade>
      </div>
    </section>
  )
}
