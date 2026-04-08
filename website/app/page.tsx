import { HomeLayout } from 'fumadocs-ui/layouts/home'
import { baseOptions } from '@/lib/layout.shared'
import { Hero } from '@/components/landing/hero'
import { Features } from '@/components/landing/features'
import { DemoVideo } from '@/components/landing/demo-video'
import { UseCases } from '@/components/landing/use-cases'
import { Footer } from '@/components/landing/footer'

export default function HomePage() {
  return (
    <HomeLayout {...baseOptions()}>
      <Hero />
      <Features />
      <DemoVideo />
      <UseCases />
      <Footer />
    </HomeLayout>
  )
}
