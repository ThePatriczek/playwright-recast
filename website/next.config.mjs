import { createMDX } from 'fumadocs-mdx/next'

const withMDX = createMDX()

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  basePath: '/playwright-recast',
  images: { unoptimized: true },
}

export default withMDX(config)
