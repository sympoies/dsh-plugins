import { describe, expect, it, vi } from 'vitest'

import { describeMedia, isStorableImage } from '../src/media/intake.js'
import { MediaCollector } from '../src/media/collect.js'
import { VisionCheck } from '../src/media/vision.js'
import type { ImageRef } from '../src/media/collect.js'
import type { TelegramMessage } from '../src/telegram/types.js'

const chat = { id: 1, type: 'private' } as const

/** A message carrying whatever fields a test needs. */
function message(fields: Partial<TelegramMessage>): TelegramMessage {
  return { message_id: 1, chat, from: { id: 7 }, ...fields } as TelegramMessage
}

describe('describeMedia — what a message carries', () => {
  it('finds nothing in a plain text message', () => {
    expect(describeMedia(message({ text: 'hello' }))).toBeUndefined()
  })

  it('takes the largest of the photo sizes Telegram sends', () => {
    const item = describeMedia(
      message({
        photo: [
          { file_id: 'small', file_size: 100 },
          { file_id: 'large', file_size: 90_000 },
        ],
      }),
    )
    expect(item?.fileId).toBe('large')
    expect(item?.kind).toBe('image')
  })

  it('treats an image sent as a document as an image', () => {
    // Telegram sends uncompressed images as documents, so the field it arrived
    // in says nothing about what it is.
    const item = describeMedia(
      message({ document: { file_id: 'f', file_name: 'shot.png', mime_type: 'image/png' } }),
    )
    expect(item?.kind).toBe('image')
  })

  it('treats a text document as readable text', () => {
    const item = describeMedia(
      message({ document: { file_id: 'f', file_name: 'server.log', mime_type: 'text/plain' } }),
    )
    expect(item?.kind).toBe('text')
  })

  it('trusts the extension when Telegram guesses octet-stream', () => {
    // Source files usually arrive typed as application/octet-stream.
    const item = describeMedia(
      message({
        document: { file_id: 'f', file_name: 'index.ts', mime_type: 'application/octet-stream' },
      }),
    )
    expect(item?.kind).toBe('text')
  })

  it('declines a binary it cannot use, and names it', () => {
    const item = describeMedia(
      message({ document: { file_id: 'f', file_name: 'app.zip', mime_type: 'application/zip' } }),
    )
    expect(item?.kind).toBe('unsupported')
    expect(item?.describedAs).toBe('application/zip')
  })

  it('names a voice note, an audio file, and a video for the refusal', () => {
    expect(describeMedia(message({ voice: { file_id: 'v' } }))?.describedAs).toBe('a voice note')
    expect(describeMedia(message({ audio: { file_id: 'a' } }))?.describedAs).toBe('an audio file')
    expect(describeMedia(message({ video: { file_id: 'v' } }))?.describedAs).toBe('a video')
  })
})

describe('isStorableImage', () => {
  it('accepts the four types the harness stores', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
      expect(isStorableImage(type)).toBe(true)
    }
  })

  it('refuses anything else, including an unknown type', () => {
    expect(isStorableImage('image/heic')).toBe(false)
    expect(isStorableImage(undefined)).toBe(false)
  })
})

/** The refusal the harness seam throws for an oversized image. */
class TooLarge extends Error {
  readonly code = 'IMAGE_DIMENSION_TOO_LARGE'
  constructor() {
    super('Image exceeds the configured per-side pixel limit.')
  }
}

/** A collector over a stub Telegram and a stub attachment seam. */
function build(
  options: {
    bytes?: Uint8Array
    noStore?: boolean
    failDownload?: boolean
    /** Fail with the raw request URL in the message, as a transport would. */
    leakyFailure?: boolean
    /** Published limits, as the local attachment store exposes them. */
    imageLimits?: { maxImageDimension?: number; maxImagePixels?: number }
    /** File ids the seam refuses as too large, whatever their real size. */
    refuse?: string[]
  } = {},
) {
  const saved: { mediaType: string; name?: string }[] = []
  /** Every file id downloaded, in order — what was tried and in what order. */
  const fetched: string[] = []
  let downloading: string | undefined

  const collector = new MediaCollector({
    source: {
      async getFile(fileId: string) {
        downloading = fileId
        return { file_path: `photos/${fileId}.jpg`, file_size: 1000 }
      },
      async downloadFile() {
        if (options.leakyFailure) throw new Error(`fetch failed: https://api.telegram.org/file/bot${SECRET}/x.jpg`)
        if (options.failDownload) throw new Error('connection reset')
        fetched.push(downloading as string)
        return options.bytes ?? new Uint8Array([1, 2, 3])
      },
    },
    ...(options.noStore
      ? {}
      : {
          attachments: {
            ...(options.imageLimits ? { imageLimits: options.imageLimits } : {}),
            async saveImage(input) {
              if (options.refuse?.includes(fetched[fetched.length - 1] as string)) throw new TooLarge()
              saved.push({ mediaType: input.mediaType, ...(input.name ? { name: input.name } : {}) })
              return {
                attachmentId: 'a1',
                mediaType: input.mediaType,
                bytes: input.data.length,
                width: 10,
                height: 10,
              } as ImageRef
            },
          },
        }),
    maxBytes: 20_000,
    maxTextChars: 100,
    redact: (text) => text.split(SECRET).join('<redacted>'),
  })

  return { collector, saved, fetched }
}

/** Stands in for a bot token, which lives in every request URL. */
const SECRET = '8123456789:AAH0mVeryS3cretT0kenValue0123456789x'

/** The sizes Telegram renders for a full-height portrait screenshot. */
const SCREENSHOT = [
  { file_id: 'tiny', width: 90, height: 195 },
  { file_id: 'small', width: 320, height: 694 },
  { file_id: 'medium', width: 800, height: 1735 },
  { file_id: 'original', width: 1179, height: 2556, file_size: 900 },
]

const LIMITS = { maxImageDimension: 2000, maxImagePixels: 40_000_000 }

describe('MediaCollector — what a refusal is allowed to say', () => {
  it('never repeats a secret into the chat', async () => {
    // A transport failure quotes the URL it was given, and the URL carries the
    // token. This is the second lock — the API client redacts its own errors —
    // but this sink is the one that persists.
    const { collector } = build({ leakyFailure: true })
    const { notice } = await collector.collect(message({ photo: SCREENSHOT }), 'look')

    expect(notice).not.toContain(SECRET)
    expect(notice).toContain('<redacted>')
  })

  it('never writes a secret into the session log either', async () => {
    // The worse of the two: a prompt is carried forward for the whole
    // conversation, so a leak here outlives the message that caused it.
    const { collector } = build({ leakyFailure: true })
    const { parts } = await collector.collect(message({ photo: SCREENSHOT }), 'look')

    const written = JSON.stringify(parts)
    expect(written).not.toContain(SECRET)
    expect(written).toContain('look')
  })

  it('redacts a refusal that never touched the network', async () => {
    const { collector } = build({ noStore: true })
    const { notice, parts } = await collector.collect(message({ photo: SCREENSHOT }), SECRET)

    expect(notice).not.toContain(SECRET)
    expect(JSON.stringify(parts)).not.toContain(SECRET)
  })
})

describe('MediaCollector — a photo bigger than the harness stores', () => {
  it('sends the largest size that fits, not the largest size', async () => {
    // The bug: a portrait screenshot is 2556 tall against a 2000 limit, so
    // taking the biggest rendering refused every phone screenshot ever sent.
    const { collector, fetched, saved } = build({ imageLimits: LIMITS })
    const { parts } = await collector.collect(message({ photo: SCREENSHOT }), 'how much?')

    expect(fetched).toEqual(['medium'])
    expect(saved).toHaveLength(1)
    expect(parts.map((part) => part.type)).toEqual(['text', 'image'])
  })

  it('never downloads the oversized original at all', async () => {
    const { collector, fetched } = build({ imageLimits: LIMITS })
    await collector.collect(message({ photo: SCREENSHOT }), undefined)

    expect(fetched).not.toContain('original')
  })

  it('steps down when the seam refuses a size this side thought would fit', async () => {
    // The limit is the harness's to change, so its refusal outranks the number
    // read here rather than ending the attempt.
    const { collector, fetched, saved } = build({ imageLimits: LIMITS, refuse: ['medium'] })
    await collector.collect(message({ photo: SCREENSHOT }), undefined)

    expect(fetched).toEqual(['medium', 'small'])
    expect(saved).toHaveLength(1)
  })

  it('explains it in words the user can act on when every size is refused', async () => {
    // The seam's own wording — "Image exceeds the configured per-side pixel
    // limit" — is what the user saw, and it told them nothing to do about it.
    const { collector } = build({
      imageLimits: LIMITS,
      refuse: ['tiny', 'small', 'medium', 'original'],
    })
    const { parts, notice } = await collector.collect(message({ photo: SCREENSHOT }), 'how much?')

    expect(notice).toContain('2000')
    expect(notice).toContain('as a photo')
    expect((parts[0] as { text: string }).text).toContain('how much?')
  })

  it('keeps trying a size that is not measured rather than refusing outright', async () => {
    // An image sent as a file has one size and no dimensions; blind is still
    // better than declining something that may well be fine.
    const { collector, saved } = build({ imageLimits: LIMITS })
    await collector.collect(
      message({ document: { file_id: 'f', file_name: 'shot.png', mime_type: 'image/png' } }),
      undefined,
    )

    expect(saved).toEqual([{ mediaType: 'image/png', name: 'shot.png' }])
  })

  it('assumes the harness default where the seam publishes no limits', async () => {
    const { collector, fetched } = build()
    await collector.collect(message({ photo: SCREENSHOT }), undefined)

    expect(fetched).toEqual(['medium'])
  })

  it('does not retry a failure another size would not fix', async () => {
    const { collector } = build({ imageLimits: LIMITS, failDownload: true })
    const { notice } = await collector.collect(message({ photo: SCREENSHOT }), undefined)

    expect(notice).toContain('connection reset')
  })
})

describe('MediaCollector — images', () => {
  it('stores a photo and hands the agent an image block', async () => {
    const { collector, saved } = build()
    const { parts } = await collector.collect(message({ photo: [{ file_id: 'p' }] }), undefined)

    expect(saved).toEqual([{ mediaType: 'image/jpeg' }])
    expect(parts).toHaveLength(1)
    expect(parts[0]?.type).toBe('image')
  })

  it('puts the caption before the image, since it is the question', async () => {
    const { collector } = build()
    const { parts } = await collector.collect(message({ photo: [{ file_id: 'p' }] }), 'why this error?')

    expect(parts.map((p) => p.type)).toEqual(['text', 'image'])
    expect(parts[0]).toMatchObject({ text: 'why this error?' })
  })

  it('explains rather than drops when there is no attachment seam', async () => {
    const { collector } = build({ noStore: true })
    const { parts } = await collector.collect(message({ photo: [{ file_id: 'p' }] }), 'look')

    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ type: 'text' })
    expect((parts[0] as { text: string }).text).toContain('look')
    expect((parts[0] as { text: string }).text).toContain('stores none')
  })

  it('explains an image type the harness will not store', async () => {
    const { collector } = build()
    const { parts } = await collector.collect(
      message({ document: { file_id: 'f', file_name: 'x.heic', mime_type: 'image/heic' } }),
      undefined,
    )
    expect((parts[0] as { text: string }).text).toContain('image/heic')
  })
})

describe('MediaCollector — text files', () => {
  it('reads a text file into the prompt', async () => {
    const { collector } = build({ bytes: new TextEncoder().encode('line one\nline two') })
    const { parts } = await collector.collect(
      message({ document: { file_id: 'f', file_name: 'app.log', mime_type: 'text/plain' } }),
      undefined,
    )

    const text = (parts[0] as { text: string }).text
    expect(text).toContain('app.log')
    expect(text).toContain('line one')
  })

  it('keeps the caption alongside the file', async () => {
    const { collector } = build({ bytes: new TextEncoder().encode('contents') })
    const { parts } = await collector.collect(
      message({ document: { file_id: 'f', file_name: 'a.txt', mime_type: 'text/plain' } }),
      'what is wrong here',
    )
    expect((parts[0] as { text: string }).text).toContain('what is wrong here')
  })

  it('truncates a file too long to inline, and says so', async () => {
    const { collector } = build({ bytes: new TextEncoder().encode('x'.repeat(5000)) })
    const { parts } = await collector.collect(
      message({ document: { file_id: 'f', file_name: 'big.txt', mime_type: 'text/plain' } }),
      undefined,
    )
    expect((parts[0] as { text: string }).text).toContain('truncated')
  })
})

describe('MediaCollector — what it refuses', () => {
  it('says a voice note cannot be read, keeping the caption', async () => {
    const { collector } = build()
    const { parts } = await collector.collect(message({ voice: { file_id: 'v' } }), 'listen to this')

    const text = (parts[0] as { text: string }).text
    expect(text).toContain('listen to this')
    expect(text).toContain('voice note')
  })

  it('refuses an oversized file before downloading it', async () => {
    const { collector } = build()
    const download = vi.fn()
    const { parts } = await collector.collect(
      message({ photo: [{ file_id: 'p', file_size: 90_000_000 }] }),
      undefined,
    )

    expect(download).not.toHaveBeenCalled()
    expect((parts[0] as { text: string }).text).toContain('size limit')
  })

  it('turns a failed download into a note rather than losing the message', async () => {
    const { collector } = build({ failDownload: true })
    const { parts } = await collector.collect(message({ photo: [{ file_id: 'p' }] }), 'my screenshot')

    const text = (parts[0] as { text: string }).text
    expect(text).toContain('my screenshot')
    expect(text).toContain('connection reset')
  })

  it('passes a plain caption through when there is no media at all', async () => {
    const { collector } = build()
    const { parts } = await collector.collect(message({ text: 'just words' }), 'just words')
    expect(parts).toEqual([{ type: 'text', text: 'just words' }])
  })
})

describe('VisionCheck — asking before sending', () => {
  const route = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }

  /** A catalog answering with whatever modalities a test declares. */
  function catalog(models: { id: string; name?: string; inputModalities?: string[] }[]) {
    return {
      async resolveModelInfo(_provider: string, model: string) {
        const found = models.find((entry) => entry.id === model)
        if (!found) throw new Error('unknown model')
        return found
      },
      async listModels() {
        return models
      },
    }
  }

  it('says no for a model declaring text only', async () => {
    const check = new VisionCheck(catalog([{ id: route.model, inputModalities: ['text'] }]), () => route)
    await expect(check.verdict()).resolves.toBe('no')
  })

  it('says yes for a model declaring image input', async () => {
    const check = new VisionCheck(
      catalog([{ id: route.model, inputModalities: ['text', 'image'] }]),
      () => route,
    )
    await expect(check.verdict()).resolves.toBe('yes')
  })

  it('says unknown when the model declares nothing, so the provider decides', async () => {
    const check = new VisionCheck(catalog([{ id: route.model }]), () => route)
    await expect(check.verdict()).resolves.toBe('unknown')
  })

  it('says unknown when the catalog cannot be read', async () => {
    // A failing check must not remove a capability the model may well have.
    const check = new VisionCheck(catalog([]), () => route)
    await expect(check.verdict()).resolves.toBe('unknown')
  })

  it('says unknown when there is no route at all', async () => {
    const check = new VisionCheck(catalog([]), () => undefined)
    await expect(check.verdict()).resolves.toBe('unknown')
  })

  it('names the models that would have worked', async () => {
    const check = new VisionCheck(
      catalog([
        { id: 'text-only', inputModalities: ['text'] },
        { id: 'sees', name: 'Sees Things', inputModalities: ['text', 'image'] },
      ]),
      () => route,
    )
    await expect(check.alternatives()).resolves.toEqual(['Sees Things'])
  })

  it('names none when the whole provider is text-only', async () => {
    // Which is the case for DeepSeek today: both models are text-only.
    const check = new VisionCheck(
      catalog([
        { id: 'deepseek-v4-flash', inputModalities: ['text'] },
        { id: 'deepseek-v4-pro', inputModalities: ['text'] },
      ]),
      () => route,
    )
    await expect(check.alternatives()).resolves.toEqual([])
  })
})

describe('MediaCollector — a model that cannot see', () => {
  function withVision(verdict: 'yes' | 'no' | 'unknown', alternatives: string[] = []) {
    const collector = new MediaCollector({
      source: {
        async getFile() {
          return { file_path: 'p.jpg', file_size: 100 }
        },
        async downloadFile() {
          return new Uint8Array([1])
        },
      },
      attachments: {
        async saveImage(input) {
          return { attachmentId: 'a', mediaType: input.mediaType, bytes: 1, width: 1, height: 1 }
        },
      },
      vision: {
        async verdict() {
          return verdict
        },
        async alternatives() {
          return alternatives
        },
        currentModel() {
          return 'deepseek-v4-flash'
        },
      } as never,
      maxBytes: 20_000,
      maxTextChars: 100,
    })
    return collector
  }

  it('sends the image anyway when the turn\'s own model can see', async () => {
    // The refusal judges the deployment default, which stopped being right the
    // moment a model that can see became selectable per conversation.
    const collector = withVision('no')
    const { parts, notice } = await collector.collect(
      message({ photo: [{ file_id: 'p' }] }),
      'why this error?',
      { modelSees: true },
    )

    expect(notice).toBeUndefined()
    expect(parts.map((part) => part.type)).toEqual(['text', 'image'])
  })

  it('still refuses when nothing can read it', async () => {
    const collector = withVision('no')
    const { notice } = await collector.collect(
      message({ photo: [{ file_id: 'p' }] }),
      'why?',
      { modelSees: false },
    )

    expect(notice).toContain("can't read images")
  })

  it('leaves the image out rather than failing the turn', async () => {
    const collector = withVision('no')
    const { parts } = await collector.collect(message({ photo: [{ file_id: 'p' }] }), 'why?')

    expect(parts.every((part) => part.type === 'text')).toBe(true)
  })

  it('tells the user which model cannot see, and what can', async () => {
    const collector = withVision('no', ['GPT Vision'])
    const { notice } = await collector.collect(message({ photo: [{ file_id: 'p' }] }), 'why?')

    expect(notice).toContain('deepseek-v4-flash')
    expect(notice).toContain('GPT Vision')
  })

  it('says plainly when nothing configured can see', async () => {
    const collector = withVision('no', [])
    const { notice } = await collector.collect(message({ photo: [{ file_id: 'p' }] }), 'why?')
    expect(notice).toContain('No configured model accepts images')
  })

  it('keeps the caption, so the turn is not wasted', async () => {
    const collector = withVision('no')
    const { parts } = await collector.collect(message({ photo: [{ file_id: 'p' }] }), 'why this error?')
    expect((parts[0] as { text: string }).text).toContain('why this error?')
  })

  it('sends the image when the model declares it can see', async () => {
    const collector = withVision('yes')
    const { parts, notice } = await collector.collect(message({ photo: [{ file_id: 'p' }] }), undefined)

    expect(parts.some((part) => part.type === 'image')).toBe(true)
    expect(notice).toBeUndefined()
  })

  it('sends the image when the answer is unknown, letting the provider decide', async () => {
    const collector = withVision('unknown')
    const { parts } = await collector.collect(message({ photo: [{ file_id: 'p' }] }), undefined)
    expect(parts.some((part) => part.type === 'image')).toBe(true)
  })
})
