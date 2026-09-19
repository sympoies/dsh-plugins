import { describe, expect, it, vi } from 'vitest'

import { OcrReader, labelOcr } from '../src/media/ocr.js'

/** A reader over a scripted `tesseract`, so no test needs one installed. */
function build(options: { missing?: boolean; text?: string; throws?: Error; hang?: boolean } = {}) {
  const calls: { command: string; args: readonly string[] }[] = []

  const run = async (command: string, args: readonly string[], signal: AbortSignal) => {
    calls.push({ command, args })
    if (options.missing) throw new Error('spawn tesseract ENOENT')
    if (args[0] === '--version') return 'tesseract 5.5.2'
    if (options.throws) throw options.throws
    if (options.hang) {
      return await new Promise<string>((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }
    return options.text ?? 'Rp 250.000'
  }

  return { reader: new OcrReader({ run, timeoutMs: 50 }), calls }
}

const IMAGE = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

describe('OcrReader — availability', () => {
  it('reports tesseract when it answers', async () => {
    expect(await build().reader.available()).toBe(true)
  })

  it('reports its absence, which is the ordinary case', async () => {
    // No operating system this runs on ships tesseract.
    expect(await build({ missing: true }).reader.available()).toBe(false)
  })

  it('probes once, since spawning is not free and the answer cannot change', async () => {
    const { reader, calls } = build()
    await reader.available()
    await reader.available()
    await reader.available()

    expect(calls.filter((call) => call.args[0] === '--version')).toHaveLength(1)
  })

  it('reads nothing at all when tesseract is missing', async () => {
    expect(await build({ missing: true }).reader.read(IMAGE)).toBeUndefined()
  })
})

describe('OcrReader — reading', () => {
  it('returns the text it found', async () => {
    expect(await build({ text: 'Rp 250.000 to Adam' }).reader.read(IMAGE)).toBe('Rp 250.000 to Adam')
  })

  it('asks for the configured languages', async () => {
    const calls: { args: readonly string[] }[] = []
    const reader = new OcrReader({
      languages: 'eng+ind',
      run: async (_command, args) => {
        calls.push({ args })
        return args[0] === '--version' ? 'tesseract 5' : 'teks'.padEnd(20, ' x')
      },
    })

    await reader.read(IMAGE)
    expect(calls[calls.length - 1]?.args).toContain('eng+ind')
  })

  it('tidies the ragged whitespace OCR leaves between columns', async () => {
    const messy = '  Total     Rp 250.000  \n\n\n   Tanggal   21 Aug  \n'
    expect(await build({ text: messy }).reader.read(IMAGE)).toBe('Total Rp 250.000\nTanggal 21 Aug')
  })

  it('treats a near-empty reading as nothing rather than sending noise', async () => {
    // A photo of a wall produces a few stray characters; passing those on as
    // "the contents of the image" is worse than saying nothing.
    expect(await build({ text: '.\n,\n' }).reader.read(IMAGE)).toBeUndefined()
  })

  it('gives up rather than holding the message forever', async () => {
    expect(await build({ hang: true }).reader.read(IMAGE)).toBeUndefined()
  })

  it('survives tesseract failing outright', async () => {
    expect(await build({ throws: new Error('unsupported image format') }).reader.read(IMAGE)).toBeUndefined()
  })

  it('leaves nothing behind on disk', async () => {
    const paths: string[] = []
    const reader = new OcrReader({
      run: async (_command, args) => {
        if (args[0] === '--version') return 'tesseract 5'
        paths.push(args[0] as string)
        return 'some text that is long enough'
      },
    })

    await reader.read(IMAGE)

    const { access } = await import('node:fs/promises')
    await expect(access(paths[0] as string)).rejects.toThrow()
  })
})

describe('labelOcr', () => {
  it('says the reading came from OCR, not from a model that looked', () => {
    // An agent handed unlabelled OCR treats a misread digit as a fact, and a
    // receipt's amount is exactly what it gets wrong.
    const labelled = labelOcr('Rp 250.000')
    expect(labelled).toContain('OCR')
    expect(labelled).toContain('may contain')
    expect(labelled).toContain('Rp 250.000')
  })

  it('says no vision model described the picture', () => {
    expect(labelOcr('x')).toContain('No vision model')
  })
})
