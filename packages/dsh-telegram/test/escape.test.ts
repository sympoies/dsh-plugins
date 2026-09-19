import { describe, expect, it } from 'vitest'

import { escapeHtml } from '../src/render/escape.js'

describe('escapeHtml', () => {
  it('escapes the three characters Telegram treats as markup', () => {
    expect(escapeHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d')
  })

  it('escapes ampersands before angle brackets so entities are not double-built', () => {
    expect(escapeHtml('<b>')).toBe('&lt;b&gt;')
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
  })

  it('leaves quotes alone — Telegram only needs the three', () => {
    expect(escapeHtml(`he said "hi" and 'bye'`)).toBe(`he said "hi" and 'bye'`)
  })

  it('returns empty for empty input', () => {
    expect(escapeHtml('')).toBe('')
  })
})
