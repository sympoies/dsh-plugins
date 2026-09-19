import { describe, expect, it } from 'vitest'

import { describeSize, isTooLarge, orderBySuitability, withinLimits } from '../src/media/limits.js'

/** What Telegram actually renders for a full-height iPhone screenshot. */
const SCREENSHOT = [
  { fileId: 'tiny', width: 90, height: 195 },
  { fileId: 'small', width: 320, height: 694 },
  { fileId: 'medium', width: 800, height: 1735 },
  { fileId: 'original', width: 1179, height: 2556 },
]

/** The harness attachment seam's defaults. */
const LIMITS = { maxImageDimension: 2000, maxImagePixels: 40_000_000 }

describe('withinLimits', () => {
  it('accepts a size inside the per-side limit', () => {
    expect(withinLimits({ fileId: 'a', width: 800, height: 1735 }, LIMITS)).toBe(true)
  })

  it('refuses a portrait screenshot, which is the whole bug', () => {
    // 2556 tall against a 2000 limit — every modern phone does this.
    expect(withinLimits({ fileId: 'a', width: 1179, height: 2556 }, LIMITS)).toBe(false)
  })

  it('measures the long side, whichever way round the picture is', () => {
    expect(withinLimits({ fileId: 'a', width: 2556, height: 1179 }, LIMITS)).toBe(false)
  })

  it('refuses one that fits per side but has too many pixels', () => {
    expect(
      withinLimits({ fileId: 'a', width: 1999, height: 1999 }, { maxImagePixels: 1_000_000 }),
    ).toBe(false)
  })

  it('claims nothing about a size Telegram did not measure', () => {
    // A document arrives with no dimensions, and guessing it fits would put it
    // ahead of a size that demonstrably does.
    expect(withinLimits({ fileId: 'a' }, LIMITS)).toBe(false)
  })

  it('claims nothing when the seam publishes no limits', () => {
    expect(withinLimits({ fileId: 'a', width: 100, height: 100 }, undefined)).toBe(false)
  })
})

describe('orderBySuitability', () => {
  it('picks the largest size that fits, not the largest size', () => {
    expect(orderBySuitability(SCREENSHOT, LIMITS)[0]?.fileId).toBe('medium')
  })

  it('keeps the ones that fit in descending order behind it', () => {
    const ordered = orderBySuitability(SCREENSHOT, LIMITS)
    expect(ordered.slice(0, 3).map((entry) => entry.fileId)).toEqual(['medium', 'small', 'tiny'])
  })

  it('keeps the oversized ones as a last resort rather than dropping them', () => {
    // The limit belongs to the harness; this side may have read it wrong, or
    // not at all, so nothing is discarded outright.
    const ordered = orderBySuitability(SCREENSHOT, LIMITS)
    expect(ordered.map((entry) => entry.fileId)).toContain('original')
    expect(ordered[ordered.length - 1]?.fileId).toBe('original')
  })

  it('loses nothing', () => {
    expect(orderBySuitability(SCREENSHOT, LIMITS)).toHaveLength(SCREENSHOT.length)
  })

  it('assumes the harness default when the seam publishes no limits', () => {
    // Knowing nothing would mean leading with a 90-pixel thumbnail, which is
    // legible to nobody. The assumption only decides what to try first.
    const ordered = orderBySuitability(SCREENSHOT, undefined)
    expect(ordered[0]?.fileId).toBe('medium')
  })

  it('handles a single unmeasured size, as a document arrives', () => {
    expect(orderBySuitability([{ fileId: 'doc' }], LIMITS)).toEqual([{ fileId: 'doc' }])
  })

  it('handles an empty list', () => {
    expect(orderBySuitability([], LIMITS)).toEqual([])
  })
})

describe('isTooLarge', () => {
  it('recognises the seam\'s per-side refusal by code', () => {
    expect(isTooLarge({ code: 'IMAGE_DIMENSION_TOO_LARGE' })).toBe(true)
  })

  it('recognises the pixel-count refusal too', () => {
    expect(isTooLarge({ code: 'IMAGE_TOO_MANY_PIXELS' })).toBe(true)
  })

  it('recognises it from the message where no code is carried', () => {
    expect(isTooLarge(new Error('Image exceeds the configured per-side pixel limit.'))).toBe(true)
  })

  it('leaves a failure another size would not fix alone', () => {
    // Retrying these just downloads the same problem again.
    expect(isTooLarge({ code: 'INVALID_IMAGE' })).toBe(false)
    expect(isTooLarge(new Error('ENOSPC: no space left on device'))).toBe(false)
    expect(isTooLarge(undefined)).toBe(false)
  })
})

describe('describeSize', () => {
  it('names what was sent and what the limit is', () => {
    const said = describeSize({ fileId: 'a', width: 4032, height: 3024 }, LIMITS)
    expect(said).toContain('4032×3024')
    expect(said).toContain('2000')
  })

  it('names the limit alone when the size was never measured', () => {
    expect(describeSize({ fileId: 'a' }, LIMITS)).toContain('2000')
  })

  it('says nothing it cannot support', () => {
    expect(describeSize({ fileId: 'a', width: 10, height: 10 }, undefined)).toBeUndefined()
  })
})
