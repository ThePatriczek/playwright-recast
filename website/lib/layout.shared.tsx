import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: 'playwright-recast',
    },
    links: [
      { text: 'Docs', url: '/docs' },
      {
        text: 'GitHub',
        url: 'https://github.com/ThePatriczek/playwright-recast',
        external: true,
      },
      {
        text: 'npm',
        url: 'https://www.npmjs.com/package/playwright-recast',
        external: true,
      },
    ],
  }
}
