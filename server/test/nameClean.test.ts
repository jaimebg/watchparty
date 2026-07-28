import { describe, it, expect } from 'vitest'
import { cleanName } from '../src/library/nameClean.js'

describe('cleanName', () => {
  it.each([
    ['La.Peli.2023.1080p.BluRay.x265-GRUPO.mkv', 'La Peli 2023'],
    ['Serie.S01E02.720p.WEB-DL.AAC.mp4', 'Serie S01E02'],
    ['Otra_Peli_[2160p]_(HDR10).mkv', 'Otra Peli'],
    ['simple.mp4', 'simple'],
    ['Peli.Con.Puntos.mkv', 'Peli Con Puntos'],
  ])('%s -> %s', (input, expected) => {
    expect(cleanName(input)).toBe(expected)
  })
})
