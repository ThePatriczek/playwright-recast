'use client'

import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

interface MarqueeProps {
  children: ReactNode
  className?: string
  reverse?: boolean
  pauseOnHover?: boolean
  vertical?: boolean
  repeat?: number
}

export function Marquee({
  children,
  className,
  reverse = false,
  pauseOnHover = false,
  vertical = false,
  repeat = 4,
}: MarqueeProps) {
  return (
    <div
      className={cn(
        'group flex overflow-hidden [--duration:40s] [--gap:1rem] [gap:var(--gap)]',
        vertical ? 'flex-col' : 'flex-row',
        className,
      )}
    >
      {Array.from({ length: repeat }).map((_, i) => (
        <div
          key={i}
          className={cn(
            'flex shrink-0 justify-around [gap:var(--gap)]',
            vertical ? 'flex-col' : 'flex-row',
            vertical
              ? 'animate-[marquee-vertical_var(--duration)_linear_infinite]'
              : 'animate-[marquee_var(--duration)_linear_infinite]',
            reverse && 'direction-reverse',
            pauseOnHover && 'group-hover:[animation-play-state:paused]',
          )}
        >
          {children}
        </div>
      ))}
    </div>
  )
}
