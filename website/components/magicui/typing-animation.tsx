'use client'

import { cn } from '@/lib/utils'
import { motion, useInView } from 'framer-motion'
import { useRef } from 'react'

interface TypingAnimationProps {
  text: string
  className?: string
  duration?: number
  delay?: number
}

export function TypingAnimation({
  text,
  className,
  duration = 100,
  delay = 0,
}: TypingAnimationProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const isInView = useInView(ref, { once: true })

  return (
    <span ref={ref} className={cn('inline-block', className)}>
      {isInView &&
        text.split('').map((char, index) => (
          <motion.span
            key={index}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{
              duration: 0.01,
              delay: delay + index * (duration / 1000),
            }}
          >
            {char}
          </motion.span>
        ))}
    </span>
  )
}
