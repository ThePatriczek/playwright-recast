import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

interface BentoGridProps {
  children: ReactNode
  className?: string
}

export function BentoGrid({ children, className }: BentoGridProps) {
  return (
    <div
      className={cn(
        'grid w-full auto-rows-[22rem] grid-cols-3 gap-4',
        className,
      )}
    >
      {children}
    </div>
  )
}

interface BentoCardProps {
  name: string
  description: string
  icon: ReactNode
  className?: string
  background?: ReactNode
}

export function BentoCard({
  name,
  description,
  icon,
  className,
  background,
}: BentoCardProps) {
  return (
    <div
      className={cn(
        'group relative col-span-3 flex flex-col justify-end overflow-hidden rounded-xl',
        'bg-fd-card border border-fd-border',
        'transform-gpu transition-all duration-300 hover:shadow-xl',
        className,
      )}
    >
      {background && (
        <div className="pointer-events-none absolute inset-0 [mask-image:linear-gradient(to_top,transparent_10%,#000_100%)]">
          {background}
        </div>
      )}
      <div className="pointer-events-none z-10 flex transform-gpu flex-col gap-1 p-6 transition-all duration-300 group-hover:-translate-y-2">
        <div className="flex items-center gap-2">
          <span className="text-fd-primary">{icon}</span>
          <h3 className="text-xl font-semibold text-fd-foreground">{name}</h3>
        </div>
        <p className="max-w-lg text-fd-muted-foreground">{description}</p>
      </div>
    </div>
  )
}
