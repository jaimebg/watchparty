import { describe, it, expect } from 'vitest'
import { nextDelay } from '../src/ws'

describe('nextDelay', () => {
  it('doubles from 500ms capped at 8s', () => {
    expect([0, 1, 2, 3, 4, 5].map(nextDelay)).toEqual([500, 1000, 2000, 4000, 8000, 8000])
  })
})
