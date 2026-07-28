import { describe, it, expect } from 'vitest'
import { parseEncoders } from '../src/media/hwaccel.js'

const OUT = (names: string[]) => names.map(n => ` V....D ${n}  desc`).join('\n')

describe('parseEncoders', () => {
  it('picks videotoolbox on darwin when available', () => {
    expect(parseEncoders(OUT(['libx264', 'h264_videotoolbox']), 'darwin')).toBe('h264_videotoolbox')
  })
  it('prefers nvenc over qsv on win32', () => {
    expect(parseEncoders(OUT(['libx264', 'h264_qsv', 'h264_nvenc']), 'win32')).toBe('h264_nvenc')
  })
  it('falls back to libx264', () => {
    expect(parseEncoders(OUT(['libx264']), 'darwin')).toBe('libx264')
  })
})
