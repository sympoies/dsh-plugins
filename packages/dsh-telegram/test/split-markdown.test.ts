import { describe, expect, it } from 'vitest'

import { splitMarkdown } from '../src/reply/split-markdown.js'

/** Count the fence markers in a chunk; an odd count means one is left open. */
function fenceCount(chunk: string): number {
  return (chunk.match(/^\s{0,3}(?:`{3,}|~{3,})/gm) ?? []).length
}

describe('splitMarkdown — when nothing needs splitting', () => {
  it('returns a short reply whole', () => {
    expect(splitMarkdown('hello', 100)).toEqual(['hello'])
  })

  it('returns nothing for empty input', () => {
    expect(splitMarkdown('', 100)).toEqual([])
  })

  it('returns nothing for whitespace alone', () => {
    expect(splitMarkdown('  \n\n ', 100)).toEqual([])
  })

  it('keeps a reply exactly at the limit whole', () => {
    const text = 'x'.repeat(50)
    expect(splitMarkdown(text, 50)).toEqual([text])
  })
})

describe('splitMarkdown — boundaries', () => {
  it('prefers a blank line', () => {
    const md = `${'a'.repeat(30)}\n\n${'b'.repeat(30)}`
    expect(splitMarkdown(md, 40)).toEqual(['a'.repeat(30), 'b'.repeat(30)])
  })

  it('falls back to a line break', () => {
    const md = `${'a'.repeat(30)}\n${'b'.repeat(30)}`
    expect(splitMarkdown(md, 40)).toEqual(['a'.repeat(30), 'b'.repeat(30)])
  })

  it('hard-splits an unbroken run that cannot fit', () => {
    const chunks = splitMarkdown('x'.repeat(100), 40)
    expect(chunks.every((chunk) => chunk.length <= 40)).toBe(true)
    expect(chunks.join('')).toBe('x'.repeat(100))
  })

  it('never exceeds the limit', () => {
    const md = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')
    for (const chunk of splitMarkdown(md, 100)) expect(chunk.length).toBeLessThanOrEqual(100)
  })

  it('keeps every line of the reply', () => {
    const md = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    const joined = splitMarkdown(md, 80).join('\n')
    for (let i = 0; i < 40; i += 1) expect(joined).toContain(`line ${i}`)
  })
})

describe('splitMarkdown — code fences', () => {
  it('closes a fence it had to cut through', () => {
    const code = Array.from({ length: 20 }, (_, i) => `const x${i} = ${i}`).join('\n')
    const chunks = splitMarkdown('```js\n' + code + '\n```', 120)

    expect(chunks.length).toBeGreaterThan(1)
    // An odd count would leave Telegram treating the rest as code.
    for (const chunk of chunks) expect(fenceCount(chunk) % 2).toBe(0)
  })

  it('reopens the fence with its language, so highlighting survives', () => {
    const code = Array.from({ length: 20 }, (_, i) => `const x${i} = ${i}`).join('\n')
    const chunks = splitMarkdown('```js\n' + code + '\n```', 120)

    expect(chunks[1]).toMatch(/^```js/)
  })

  it('leaves a fence that closed inside one chunk alone', () => {
    const md = '```\nshort\n```\n\n' + 'tail '.repeat(40)
    const chunks = splitMarkdown(md, 60)

    expect(chunks[0]).toContain('short')
    expect(chunks[1]).not.toMatch(/^```/)
  })

  it('handles tilde fences too', () => {
    const code = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    const chunks = splitMarkdown('~~~\n' + code + '\n~~~', 100)
    for (const chunk of chunks) expect(fenceCount(chunk) % 2).toBe(0)
  })
})

describe('splitMarkdown — realistic replies', () => {
  it('splits a long table without losing rows', () => {
    const rows = Array.from({ length: 60 }, (_, i) => `| row-${i} | value-${i} |`)
    const md = ['| a | b |', '| - | - |', ...rows].join('\n')
    const chunks = splitMarkdown(md, 300)

    const joined = chunks.join('\n')
    for (let i = 0; i < 60; i += 1) expect(joined).toContain(`row-${i}`)
  })

  it('produces one chunk for a reply under Telegram\'s real cap', () => {
    // 32768 is the rich-message limit, so ordinary replies never split.
    const md = 'A reasonably long paragraph. '.repeat(200)
    expect(splitMarkdown(md, 32_768)).toHaveLength(1)
  })
})
