import { RootProvider } from 'fumadocs-ui/provider/next'
import { Inter } from 'next/font/google'
import type { ReactNode } from 'react'
import type { Metadata } from 'next'
import './global.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: {
    template: '%s | playwright-recast',
    default: 'playwright-recast — Playwright traces to demo videos',
  },
  description:
    'Transform Playwright traces into stunning demo videos with voiceover, subtitles, zoom, and click effects.',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={inter.className}>
      <body className="overflow-x-hidden">
        <RootProvider search={{ options: { type: 'static', api: '/playwright-recast/api/search' } }}>
          {children}
        </RootProvider>
      </body>
    </html>
  )
}
