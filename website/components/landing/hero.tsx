'use client'

import Link from 'next/link'
import { BlurFade } from '@/components/magicui/blur-fade'
import { ShimmerButton } from '@/components/magicui/shimmer-button'
import { Particles } from '@/components/magicui/particles'
import { ArrowRight, Copy, Check } from 'lucide-react'
import { useState } from 'react'

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  )
}

function NpmInstallBadge() {
  const [copied, setCopied] = useState(false)
  const command = 'npm install playwright-recast'

  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(command)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }}
      className="group mt-6 inline-flex cursor-pointer items-center gap-2 rounded-lg border border-fd-border bg-fd-card px-4 py-2 font-mono text-sm text-fd-muted-foreground transition-colors hover:border-fd-primary/30 hover:text-fd-foreground"
    >
      <span className="text-fd-primary">$</span>
      {command}
      {copied ? (
        <Check className="h-3.5 w-3.5 text-green-500" />
      ) : (
        <Copy className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-100" />
      )}
    </button>
  )
}

type Token = { text: string; color: string }
type CodeLine = Token[]

const K = 'text-purple-400'
const S = 'text-green-400'
const N = 'text-orange-400'
const M = 'text-blue-300'
const P = 'text-sky-300'
const T = 'text-slate-300'

const codeLines: CodeLine[] = [
  [{ text: 'import', color: K }, { text: ' { Recast, ElevenLabsProvider } ', color: T }, { text: 'from', color: K }, { text: " 'playwright-recast'", color: S }],
  [],
  [{ text: 'await', color: K }, { text: ' Recast', color: T }],
  [{ text: '  .from(', color: M }, { text: "'./test-results/trace.zip'", color: S }, { text: ')', color: T }],
  [{ text: '  .parse()', color: M }],
  [{ text: '  .speedUp({ ', color: M }, { text: 'duringIdle: ', color: P }, { text: '3.0', color: N }, { text: ', ', color: T }, { text: 'duringUserAction: ', color: P }, { text: '1.0', color: N }, { text: ' })', color: T }],
  [{ text: '  .subtitlesFromSrt(', color: M }, { text: "'./narration.srt'", color: S }, { text: ')', color: T }],
  [{ text: '  .voiceover(', color: M }, { text: 'ElevenLabsProvider({ ', color: T }, { text: 'voiceId: ', color: P }, { text: "'daniel'", color: S }, { text: ' }))', color: T }],
  [{ text: '  .render({ ', color: M }, { text: 'format: ', color: P }, { text: "'mp4'", color: S }, { text: ', ', color: T }, { text: 'resolution: ', color: P }, { text: "'1080p'", color: S }, { text: ' })', color: T }],
  [{ text: '  .toFile(', color: M }, { text: "'demo.mp4'", color: S }, { text: ')', color: T }],
]

function CodeBlock() {
  const codeText = `import { Recast, ElevenLabsProvider } from 'playwright-recast'

await Recast
  .from('./test-results/trace.zip')
  .parse()
  .speedUp({ duringIdle: 3.0, duringUserAction: 1.0 })
  .subtitlesFromSrt('./narration.srt')
  .voiceover(ElevenLabsProvider({ voiceId: 'daniel' }))
  .render({ format: 'mp4', resolution: '1080p' })
  .toFile('demo.mp4')`

  const [copied, setCopied] = useState(false)

  return (
    <div className="w-full max-w-2xl overflow-hidden rounded-xl border border-white/10 bg-slate-950 shadow-2xl shadow-indigo-500/10">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <div className="h-3 w-3 rounded-full bg-red-500/70" />
          <div className="h-3 w-3 rounded-full bg-yellow-500/70" />
          <div className="h-3 w-3 rounded-full bg-green-500/70" />
          <span className="ml-2 text-xs text-slate-500">pipeline.ts</span>
        </div>
        <button
          onClick={() => {
            navigator.clipboard.writeText(codeText)
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
          }}
          className="cursor-pointer rounded-md p-1.5 text-slate-500 transition-colors hover:bg-white/5 hover:text-slate-300"
          aria-label="Copy code"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-green-400" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
      <pre className="overflow-x-auto p-5 text-left text-[13px] leading-6">
        <code>
          {codeLines.map((line, li) => (
            <div key={li} className={line.length === 0 ? 'h-5' : undefined}>
              {line.map((token, ti) => (
                <span key={ti} className={token.color}>
                  {token.text}
                </span>
              ))}
            </div>
          ))}
        </code>
      </pre>
    </div>
  )
}

export function Hero() {
  return (
    <section className="relative flex min-h-[90vh] flex-col items-center justify-center overflow-hidden px-6 py-24">
      <Particles
        className="absolute inset-0 dark:opacity-100"
        quantity={60}
        color="#6366f1"
        size={1.4}
      />

      <div className="relative z-10 mx-auto flex max-w-5xl flex-col items-center text-center">
        <BlurFade delay={0.1}>
          <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-fd-border bg-fd-card/80 px-4 py-1.5 text-sm text-fd-muted-foreground backdrop-blur-sm">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
            </span>
            v0.12.0 — Single-phase recorder
          </div>
        </BlurFade>

        <BlurFade delay={0.2}>
          <h1 className="bg-gradient-to-b from-fd-foreground to-fd-foreground/70 bg-clip-text text-5xl font-bold tracking-tight text-transparent sm:text-6xl lg:text-7xl">
            Playwright traces to
            <br />
            demo videos
          </h1>
        </BlurFade>

        <BlurFade delay={0.4}>
          <p className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-fd-muted-foreground sm:text-lg">
            Your tests already capture everything.{' '}
            <span className="font-medium text-fd-foreground">playwright-recast</span>{' '}
            turns those artifacts into polished, narrated product videos
            with a single fluent pipeline.
          </p>
        </BlurFade>

        <BlurFade delay={0.6}>
          <div className="mt-10 flex flex-col items-center gap-3 sm:flex-row">
            <Link href="/docs/getting-started/installation">
              <ShimmerButton
                shimmerColor="#a78bfa"
                background="linear-gradient(135deg, #4f46e5, #7c3aed)"
                borderRadius="12px"
              >
                <span className="flex items-center gap-2 text-sm">
                  Get Started
                  <ArrowRight className="h-4 w-4" />
                </span>
              </ShimmerButton>
            </Link>
            <a
              href="https://github.com/ThePatriczek/playwright-recast"
              target="_blank"
              rel="noopener noreferrer"
              className="flex cursor-pointer items-center gap-2 rounded-xl border border-fd-border bg-fd-card px-5 py-3 text-sm font-medium text-fd-foreground transition-all duration-200 hover:border-fd-primary/30 hover:shadow-md"
            >
              <GitHubIcon className="h-4 w-4" />
              View on GitHub
            </a>
          </div>
        </BlurFade>

        <BlurFade delay={0.7}>
          <NpmInstallBadge />
        </BlurFade>

        <BlurFade delay={0.9}>
          <div className="mt-14">
            <CodeBlock />
          </div>
        </BlurFade>
      </div>
    </section>
  )
}
