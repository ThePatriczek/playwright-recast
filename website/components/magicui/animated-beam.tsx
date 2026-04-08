'use client'

import { cn } from '@/lib/utils'
import { motion } from 'framer-motion'

interface AnimatedBeamProps {
  className?: string
}

export function AnimatedBeam({ className }: AnimatedBeamProps) {
  return (
    <div className={cn('relative h-full w-full overflow-hidden', className)}>
      <motion.div
        className="absolute left-1/2 top-0 h-full w-px bg-gradient-to-b from-transparent via-fd-primary to-transparent opacity-50"
        animate={{
          y: ['-100%', '100%'],
        }}
        transition={{
          duration: 3,
          repeat: Infinity,
          ease: 'linear',
        }}
      />
    </div>
  )
}
