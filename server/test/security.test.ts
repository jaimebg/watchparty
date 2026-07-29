import { describe, it, expect } from 'vitest'
import { isPathInside } from '../src/http/security.js'

describe('isPathInside', () => {
  it.each([
    ['/media', '/media/peli.mkv', true],
    ['/media', '/media/sub/x.mp4', true],
    ['/media', '/media/../etc/passwd', false],
    ['/media', '/mediafalso/x.mkv', false],
  ])('root=%s p=%s -> %s', (root, p, ok) => {
    expect(isPathInside(root, p)).toBe(ok)
  })
})
