'use client'

import { BlurFade } from '@/components/magicui/blur-fade'
import { Cog, Presentation, BookOpen } from 'lucide-react'
import type { ReactNode } from 'react'

interface UseCase {
  title: string
  description: string
  icon: ReactNode
}

const useCases: UseCase[] = [
  {
    title: 'Product demos from CI',
    description:
      'Regenerate polished videos on every deploy, no manual recording. Your CI pipeline already runs the tests — let it produce the marketing assets too.',
    icon: <Cog className="h-5 w-5" />,
  },
  {
    title: 'Sales enablement',
    description:
      'Consistent, branded demo videos for prospects. Every rep sends the same high-quality walkthrough, always showing the latest UI.',
    icon: <Presentation className="h-5 w-5" />,
  },
  {
    title: 'Living documentation',
    description:
      'Embed code walkthroughs that stay current with your UI. When the product changes, the docs update themselves on the next test run.',
    icon: <BookOpen className="h-5 w-5" />,
  },
]

export function UseCases() {
  return (
    <section className="relative border-t border-fd-border bg-fd-background px-6 py-24">
      <div className="mx-auto max-w-5xl">
        <BlurFade delay={0.1}>
          <div className="mb-14 text-center">
            <h2 className="text-3xl font-bold tracking-tight text-fd-foreground sm:text-4xl">
              Built for your workflow
            </h2>
            <p className="mx-auto mt-4 max-w-md text-base text-fd-muted-foreground">
              Three ways teams use playwright-recast today.
            </p>
          </div>
        </BlurFade>

        <div className="grid gap-6 sm:grid-cols-3">
          {useCases.map((useCase, i) => (
            <BlurFade key={useCase.title} delay={0.1 + i * 0.08}>
              <div className="group flex h-full flex-col rounded-xl border border-fd-border bg-fd-card p-6 transition-all duration-200 hover:border-fd-primary/20 hover:shadow-lg hover:shadow-fd-primary/5">
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg border border-fd-border bg-fd-background text-fd-primary transition-colors group-hover:border-fd-primary/30 group-hover:bg-fd-primary/5">
                  {useCase.icon}
                </div>
                <h3 className="text-base font-semibold text-fd-foreground">
                  {useCase.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-fd-muted-foreground">
                  {useCase.description}
                </p>
              </div>
            </BlurFade>
          ))}
        </div>
      </div>
    </section>
  )
}
