import { defineConfig } from '@playwright/test'
import { join } from 'node:path'

const output = process.env.JEV_OUTPUT
if (!output) throw new Error('Run this demo with npm run poc:jev')

export default defineConfig({
  testDir: '.',
  testMatch: 'director.spec.ts',
  timeout: 600_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: join(output, 'recording'),
  use: {
    browserName: 'chromium',
    channel: process.env.JEV_CHANNEL || undefined,
    headless: process.env.JEV_HEADED !== '1',
    viewport: { width: 1280, height: 720 },
    video: { mode: 'on', size: { width: 1280, height: 720 } },
    trace: 'on',
    actionTimeout: 5000,
    navigationTimeout: 30_000,
  },
})
