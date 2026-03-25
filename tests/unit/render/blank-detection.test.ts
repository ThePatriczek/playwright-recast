import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

const TMP_DIR = path.join('/tmp', 'recast-blank-test')

describe('Blank frame detection', () => {
  beforeAll(() => {
    fs.mkdirSync(TMP_DIR, { recursive: true })
  })

  afterAll(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true })
  })

  it('white frame produces a small PNG, textured frame produces a large PNG', () => {
    const whitePath = path.join(TMP_DIR, 'white.mp4')
    const noisePath = path.join(TMP_DIR, 'noise.mp4')

    // Create 1s white video
    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi',
      '-i', 'color=c=white:s=1920x1080:d=1:r=25',
      '-c:v', 'libx264', '-preset', 'ultrafast',
      whitePath,
    ], { stdio: 'pipe' })

    // Create 1s noise video (complex content = large frames)
    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi',
      '-i', 'mandelbrot=s=1920x1080:r=25',
      '-t', '1',
      '-c:v', 'libx264', '-preset', 'ultrafast',
      noisePath,
    ], { stdio: 'pipe' })

    // Extract first frame from each
    const whiteFrame = path.join(TMP_DIR, 'white-frame.png')
    const noiseFrame = path.join(TMP_DIR, 'noise-frame.png')

    execFileSync('ffmpeg', ['-y', '-i', whitePath, '-frames:v', '1', whiteFrame], { stdio: 'pipe' })
    execFileSync('ffmpeg', ['-y', '-i', noisePath, '-frames:v', '1', noiseFrame], { stdio: 'pipe' })

    const whiteSize = fs.statSync(whiteFrame).size
    const noiseSize = fs.statSync(noiseFrame).size

    // White frame should be tiny (< 15KB for 1920x1080)
    expect(whiteSize).toBeLessThan(15_000)
    // Noise/content frame should be significantly larger
    expect(noiseSize).toBeGreaterThan(whiteSize * 3)
  })

  it('video with blank lead-in has small first frame and large later frame', () => {
    // Create video: 1s white + 2s mandelbrot
    const whitePath = path.join(TMP_DIR, 'lead-white.mp4')
    const contentPath = path.join(TMP_DIR, 'lead-content.mp4')

    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi',
      '-i', 'color=c=white:s=1920x1080:d=1:r=25',
      '-c:v', 'libx264', '-preset', 'ultrafast',
      whitePath,
    ], { stdio: 'pipe' })

    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi',
      '-i', 'mandelbrot=s=1920x1080:r=25',
      '-t', '2',
      '-c:v', 'libx264', '-preset', 'ultrafast',
      contentPath,
    ], { stdio: 'pipe' })

    const concatFile = path.join(TMP_DIR, 'lead-concat.txt')
    const videoPath = path.join(TMP_DIR, 'lead-video.mp4')
    fs.writeFileSync(concatFile, `file '${whitePath}'\nfile '${contentPath}'`)
    execFileSync('ffmpeg', [
      '-y', '-f', 'concat', '-safe', '0', '-i', concatFile,
      '-c', 'copy', videoPath,
    ], { stdio: 'pipe' })

    // Frame at 0s = blank
    const f0 = path.join(TMP_DIR, 'lead-f0.png')
    execFileSync('ffmpeg', ['-y', '-ss', '0', '-i', videoPath, '-frames:v', '1', f0], { stdio: 'pipe' })

    // Frame at 1.5s = content
    const f1 = path.join(TMP_DIR, 'lead-f1.png')
    execFileSync('ffmpeg', ['-y', '-ss', '1.5', '-i', videoPath, '-frames:v', '1', f1], { stdio: 'pipe' })

    expect(fs.statSync(f0).size).toBeLessThan(15_000)
    expect(fs.statSync(f1).size).toBeGreaterThan(15_000)
  })
})
