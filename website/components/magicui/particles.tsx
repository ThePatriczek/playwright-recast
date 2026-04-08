'use client'

import { cn } from '@/lib/utils'
import { useEffect, useRef, useState } from 'react'

interface ParticlesProps {
  className?: string
  quantity?: number
  color?: string
  size?: number
}

export function Particles({
  className,
  quantity = 50,
  color = '#6366f1',
  size = 1,
}: ParticlesProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        setDimensions({ width, height })
        canvas.width = width
        canvas.height = height
      }
    })

    resizeObserver.observe(canvas.parentElement!)

    const particles = Array.from({ length: quantity }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
      alpha: Math.random() * 0.5 + 0.1,
    }))

    let animationId: number

    const animate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      for (const p of particles) {
        p.x += p.vx
        p.y += p.vy

        if (p.x < 0 || p.x > canvas.width) p.vx *= -1
        if (p.y < 0 || p.y > canvas.height) p.vy *= -1

        ctx.beginPath()
        ctx.arc(p.x, p.y, size, 0, Math.PI * 2)
        ctx.fillStyle = color
        ctx.globalAlpha = p.alpha
        ctx.fill()
      }

      ctx.globalAlpha = 1
      animationId = requestAnimationFrame(animate)
    }

    animate()

    return () => {
      cancelAnimationFrame(animationId)
      resizeObserver.disconnect()
    }
  }, [quantity, color, size, dimensions.width, dimensions.height])

  return (
    <canvas
      ref={canvasRef}
      className={cn('pointer-events-none absolute inset-0', className)}
    />
  )
}
