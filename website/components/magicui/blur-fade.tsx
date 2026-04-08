'use client'

import { cn } from '@/lib/utils'
import { motion, useInView } from 'framer-motion'
import { useRef, type ReactNode } from 'react'

interface BlurFadeProps {
  children: ReactNode
  className?: string
  delay?: number
  duration?: number
  yOffset?: number
  inView?: boolean
}

export function BlurFade({
  children,
  className,
  delay = 0,
  duration = 0.4,
  yOffset = 6,
  inView = true,
}: BlurFadeProps) {
  const ref = useRef<HTMLDivElement>(null)
  const isInView = useInView(ref, { once: true, margin: '0px 0px -50px 0px' })
  const shouldAnimate = inView ? isInView : true

  return (
    <motion.div
      ref={ref}
      initial={{ y: yOffset, opacity: 0, filter: 'blur(6px)' }}
      animate={
        shouldAnimate
          ? { y: 0, opacity: 1, filter: 'blur(0px)' }
          : { y: yOffset, opacity: 0, filter: 'blur(6px)' }
      }
      transition={{
        delay,
        duration,
        ease: 'easeOut',
      }}
      className={cn(className)}
    >
      {children}
    </motion.div>
  )
}
