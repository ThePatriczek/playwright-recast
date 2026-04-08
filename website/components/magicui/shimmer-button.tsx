'use client'

import { cn } from '@/lib/utils'
import type { ComponentPropsWithoutRef } from 'react'

interface ShimmerButtonProps extends ComponentPropsWithoutRef<'button'> {
  shimmerColor?: string
  shimmerSize?: string
  borderRadius?: string
  shimmerDuration?: string
  background?: string
}

export function ShimmerButton({
  shimmerColor = '#ffffff',
  shimmerSize = '0.05em',
  borderRadius = '100px',
  shimmerDuration = '3s',
  background = 'rgba(0, 0, 0, 1)',
  className,
  children,
  ...props
}: ShimmerButtonProps) {
  return (
    <button
      style={
        {
          '--shimmer-color': shimmerColor,
          '--radius': borderRadius,
          '--speed': shimmerDuration,
          '--cut': shimmerSize,
          '--bg': background,
        } as React.CSSProperties
      }
      className={cn(
        'group relative z-0 flex cursor-pointer items-center justify-center overflow-hidden whitespace-nowrap px-6 py-3 [background:var(--bg)] [border-radius:var(--radius)]',
        'transform-gpu transition-transform duration-300 ease-in-out active:translate-y-px',
        className,
      )}
      {...props}
    >
      <div className="absolute inset-0 overflow-hidden [border-radius:var(--radius)]">
        <span className="absolute inset-[-100%] animate-[shimmer-slide_var(--speed)_ease-in-out_infinite] [background:linear-gradient(to_right,transparent_calc(50%-var(--cut)),var(--shimmer-color)_50%,transparent_calc(50%+var(--cut)))]" />
      </div>
      <span className="relative z-10 text-sm font-medium text-white">
        {children}
      </span>
    </button>
  )
}
