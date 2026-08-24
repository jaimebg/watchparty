import { describe, it, expect } from 'vitest'
import { cleanName } from '../src/library/nameClean.js'

describe('cleanName', () => {
  it.each([
    ['La.Peli.2023.1080p.BluRay.x265-GRUPO.mkv', 'La Peli 2023'],
    ['Serie.S01E02.720p.WEB-DL.AAC.mp4', 'Serie S01E02'],
    ['Otra_Peli_[2160p]_(HDR10).mkv', 'Otra Peli'],
    ['simple.mp4', 'simple'],
    ['Peli.Con.Puntos.mkv', 'Peli Con Puntos'],
    ['Spider-Man.mkv', 'Spider-Man'],
    ['another-movie.mkv', 'another-movie'],
    ['Spider-Man.2002.1080p.BluRay.x264-GRUPO.mkv', 'Spider-Man 2002'],
    ['Project Hail Mary (2026) [IMAX] [1080p] [WEBRip] [5.1] [YTS.BZ].mp4', 'Project Hail Mary 2026'],
    ['Project.Hail.Mary.2026.IMAX.1080p.WEBRip.x264.AAC5.1-[YTS.BZ].mp4', 'Project Hail Mary 2026'],
    ['Otra_Peli_[2024]_(HDR10).mkv', 'Otra Peli 2024'],
  ])('%s -> %s', (input, expected) => {
    expect(cleanName(input)).toBe(expected)
  })
})
