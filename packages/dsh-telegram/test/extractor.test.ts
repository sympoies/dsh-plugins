import { describe, expect, it, vi } from 'vitest'

import { VisionExtractor } from '../src/media/extractor.js'
import type { ExtractionAgent, ExtractionHost } from '../src/media/extractor.js'
import type { ModelRoute } from '../src/harness/model-selection.js'

const VISION: ModelRoute = { provider: 'xiaomi', model: 'mimo-v2.5' }

/** A prompt as a screenshot with a caption arrives. */
const withImage = (caption: string) => [
  { type: 'text' as const, text: caption },
  { type: 'image' as const, attachment: { attachmentId: 'a1' } as never },
]

/**
 * A host whose agents record what they were asked and are driven by hand.
 *
 * Nothing answers on its own: each test decides what the vision model says,
 * which is what makes the failure paths as reachable as the happy one.
 */
function fakeHost(options: { createFails?: boolean; disposeFails?: boolean } = {}) {
  const created: { sessionId: string; cwd: string; route: ModelRoute }[] = []
  const prompts: { sessionId: string; content: readonly { type: string; text?: string }[] }[] = []
  const disposed: string[] = []

  const host: ExtractionHost = {
    async create(sessionId, cwd, route) {
      if (options.createFails) throw new Error('no session could be opened')
      created.push({ sessionId, cwd, route })

      const agent: ExtractionAgent = {
        sessionId,
        followup(content) {
          prompts.push({ sessionId, content })
        },
        async dispose() {
          disposed.push(sessionId)
          if (options.disposeFails) throw new Error('could not dispose')
        },
      }
      return agent
    },
  }

  return { host, created, prompts, disposed }
}

/** An extractor over a fake host, with a fixed session id per reading. */
function build(
  host: ExtractionHost,
  options: { visionModel?: ModelRoute | undefined; timeoutMs?: number } = {},
) {
  let counter = 0
  return new VisionExtractor({
    host,
    cwd: '/work',
    visionModel: () => ('visionModel' in options ? options.visionModel : VISION),
    newSessionId: () => `v${(counter += 1)}`,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })
}

/** Say something as the model, then end the turn. */
function answer(extractor: VisionExtractor, sessionId: string, text: string) {
  extractor.handle(sessionId, {
    type: 'assistant/message',
    data: { turn: 1, message: { content: [{ type: 'text', text }] } },
  })
  extractor.handle(sessionId, { type: 'turn/end', data: { turn: 1 } })
}

describe('VisionExtractor — availability', () => {
  it('is available when a vision model is configured', () => {
    expect(build(fakeHost().host).available).toBe(true)
  })

  it('is not available without one, so nothing tries to read', () => {
    expect(build(fakeHost().host, { visionModel: undefined }).available).toBe(false)
  })

  it('follows the setting rather than a value captured at construction', () => {
    // The setting can change while the plugin runs; a captured route would
    // leave the feature silently on the old model, or silently off.
    let route: ModelRoute | undefined
    const extractor = new VisionExtractor({
      host: fakeHost().host,
      cwd: '/work',
      visionModel: () => route,
    })

    expect(extractor.available).toBe(false)
    route = VISION
    expect(extractor.available).toBe(true)
  })
})

describe('VisionExtractor — reading a picture', () => {
  it('reads it on the vision model, in a session of its own', async () => {
    const fake = fakeHost()
    const extractor = build(fake.host)

    const resolving = extractor.resolve(withImage('how much?'))
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(1))
    answer(extractor, 'v1', 'Rp 250.000 to Adam, 21 Aug 2026')
    await resolving

    expect(fake.created).toEqual([{ sessionId: 'v1', cwd: '/work', route: VISION }])
  })

  it('sends the picture with an instruction to transcribe it', async () => {
    const fake = fakeHost()
    const extractor = build(fake.host)

    const resolving = extractor.resolve(withImage('how much?'))
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(1))

    const sent = fake.prompts[0]?.content ?? []
    expect(sent[0]?.text).toContain('Transcribe every piece of')
    expect(sent.filter((part) => part.type === 'image')).toHaveLength(1)

    answer(extractor, 'v1', 'anything')
    await resolving
  })

  it('does not send the user\'s own caption, which would answer the wrong question', async () => {
    // The reading session is asked to read, not to help: a caption like
    // "is this right?" would get an opinion instead of a transcription.
    const fake = fakeHost()
    const extractor = build(fake.host)

    const resolving = extractor.resolve(withImage('is this right?'))
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(1))
    expect(JSON.stringify(fake.prompts[0]?.content)).not.toContain('is this right?')

    answer(extractor, 'v1', 'anything')
    await resolving
  })

  it('returns the caption followed by what the model read', async () => {
    const fake = fakeHost()
    const extractor = build(fake.host)

    const resolving = extractor.resolve(withImage('how much?'))
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(1))
    answer(extractor, 'v1', 'Rp 250.000')

    expect(await resolving).toEqual([
      { type: 'text', text: 'how much?' },
      { type: 'text', text: 'Contents of the image the user sent:\n\nRp 250.000' },
    ])
  })

  it('carries no image out, which is what keeps a conversation unstuck', async () => {
    const fake = fakeHost()
    const extractor = build(fake.host)

    const resolving = extractor.resolve(withImage('how much?'))
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(1))
    answer(extractor, 'v1', 'Rp 250.000')

    expect((await resolving).some((part) => part.type === 'image')).toBe(false)
  })

  it('disposes the reading session, since it exists for one turn', async () => {
    const fake = fakeHost()
    const extractor = build(fake.host)

    const resolving = extractor.resolve(withImage('how much?'))
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(1))
    answer(extractor, 'v1', 'Rp 250.000')
    await resolving

    expect(fake.disposed).toEqual(['v1'])
  })

  it('still returns the reading when disposing the session fails', async () => {
    const fake = fakeHost({ disposeFails: true })
    const extractor = build(fake.host)

    const resolving = extractor.resolve(withImage('how much?'))
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(1))
    answer(extractor, 'v1', 'Rp 250.000')

    expect((await resolving)[1]?.text).toContain('Rp 250.000')
  })

  it('uses a fresh session per picture, so two never share a reading', async () => {
    const fake = fakeHost()
    const extractor = build(fake.host)

    const first = extractor.resolve(withImage('one'))
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(1))
    const second = extractor.resolve(withImage('two'))
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(2))

    answer(extractor, 'v2', 'second reading')
    answer(extractor, 'v1', 'first reading')

    expect((await first)[1]?.text).toContain('first reading')
    expect((await second)[1]?.text).toContain('second reading')
  })
})

/** An extractor with OCR behind it, and optionally no model in front. */
function withFallback(
  options: { model?: boolean; ocrText?: string; ocrThere?: boolean; timeoutMs?: number } = {},
) {
  const fake = fakeHost()
  const extractor = new VisionExtractor({
    host: fake.host,
    cwd: '/work',
    visionModel: () => (options.model === false ? undefined : VISION),
    newSessionId: () => 'v1',
    timeoutMs: options.timeoutMs ?? 2000,
    fallback: {
      available: async () => options.ocrThere !== false,
      read: async () => options.ocrText,
    },
    attachments: { readImage: async () => ({ data: new Uint8Array([1, 2, 3]) }) },
  })
  return { extractor, fake }
}

describe('VisionExtractor — falling back to OCR', () => {
  it('reads the text when no vision model is configured', async () => {
    // Otherwise the image is refused outright and the user gets a sentence
    // about model configuration instead of an answer.
    const { extractor } = withFallback({ model: false, ocrText: 'Rp 250.000' })
    const resolved = await extractor.resolve(withImage('how much?'))

    expect(resolved[1]?.text).toContain('Rp 250.000')
  })

  it('labels it as OCR, so a misread digit is not taken as fact', async () => {
    const { extractor } = withFallback({ model: false, ocrText: 'Rp 250.000' })
    const resolved = await extractor.resolve(withImage('how much?'))

    expect(resolved[1]?.text).toContain('OCR')
    expect(resolved[1]?.text).toContain('may contain')
  })

  it('never opens a session when there is no model to open one on', async () => {
    const { extractor, fake } = withFallback({ model: false, ocrText: 'Rp 250.000' })
    await extractor.resolve(withImage('how much?'))

    expect(fake.created).toEqual([])
  })

  it('prefers the model, since OCR reads text and does not see', async () => {
    const { extractor, fake } = withFallback({ ocrText: 'from ocr' })

    const resolving = extractor.resolve(withImage('how much?'))
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(1))
    answer(extractor, 'v1', 'from the model')

    expect((await resolving)[1]?.text).toContain('from the model')
  })

  it('falls back when the model was configured but could not be reached', async () => {
    // The reading session never answers; its timeout ends it, and OCR is what
    // stands between that and the user getting nothing.
    const { extractor } = withFallback({ ocrText: 'Rp 250.000', timeoutMs: 30 })
    const resolved = await extractor.resolve(withImage('how much?'))

    expect(resolved[1]?.text).toContain('Rp 250.000')
  })

  it('says nothing can read an image when neither can', async () => {
    const { extractor } = withFallback({ model: false, ocrThere: false })
    const resolved = await extractor.resolve(withImage('how much?'))

    expect(resolved[1]?.text).toContain('nothing here can read one')
    expect(resolved[1]?.text).toContain('tesseract')
  })

  it('marks each image when several were sent together', async () => {
    const { extractor } = withFallback({ model: false, ocrText: 'a receipt' })
    const two = [
      { type: 'text' as const, text: 'these two' },
      { type: 'image' as const, attachment: { attachmentId: 'a1' } as never },
      { type: 'image' as const, attachment: { attachmentId: 'a2' } as never },
    ]

    const resolved = await extractor.resolve(two)
    expect(resolved[1]?.text).toContain('image 1')
    expect(resolved[1]?.text).toContain('image 2')
  })
})

describe('VisionExtractor — what it leaves alone', () => {
  it('passes a text-only prompt straight through', async () => {
    const fake = fakeHost()
    const content = [{ type: 'text' as const, text: 'just words' }]

    expect(await build(fake.host).resolve(content)).toEqual(content)
    expect(fake.created).toEqual([])
  })

  it('passes a picture through untouched when no vision model is configured', async () => {
    const fake = fakeHost()
    const content = withImage('look')

    expect(await build(fake.host, { visionModel: undefined }).resolve(content)).toEqual(content)
    expect(fake.created).toEqual([])
  })
})

describe('VisionExtractor — when the reading does not arrive', () => {
  it('says so in the prompt rather than dropping the picture silently', async () => {
    const fake = fakeHost({ createFails: true })

    const resolved = await build(fake.host).resolve(withImage('how much?'))
    expect(resolved[0]?.text).toBe('how much?')
    expect(resolved[1]?.text).toContain('could not be read')
    expect(resolved[1]?.text).toContain('mimo-v2.5')
  })

  it('reports a turn that ended in an error', async () => {
    const fake = fakeHost()
    const extractor = build(fake.host)

    const resolving = extractor.resolve(withImage('how much?'))
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(1))
    extractor.handle('v1', {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'error', error: { message: 'rate limited' } } },
    })

    expect((await resolving)[1]?.text).toContain('could not be read')
  })

  it('reports a turn that ended having said nothing', async () => {
    const fake = fakeHost()
    const extractor = build(fake.host)

    const resolving = extractor.resolve(withImage('how much?'))
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(1))
    extractor.handle('v1', { type: 'turn/end', data: { turn: 1 } })

    expect((await resolving)[1]?.text).toContain('could not be read')
  })

  it('gives up rather than holding the message forever', async () => {
    const fake = fakeHost()
    const extractor = build(fake.host, { timeoutMs: 10 })

    const resolved = await extractor.resolve(withImage('how much?'))
    expect(resolved[1]?.text).toContain('could not be read')
    expect(fake.disposed).toEqual(['v1'])
  })

  it('releases every reading in flight when the plugin unloads', async () => {
    const fake = fakeHost()
    const extractor = build(fake.host)

    const resolving = extractor.resolve(withImage('how much?'))
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(1))
    extractor.dispose()

    expect((await resolving)[1]?.text).toContain('could not be read')
  })
})

describe('VisionExtractor — claiming its own session events', () => {
  it('claims events from a reading session, so no chat is told about them', async () => {
    const fake = fakeHost()
    const extractor = build(fake.host)

    const resolving = extractor.resolve(withImage('how much?'))
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(1))

    expect(extractor.handle('v1', { type: 'turn/start', data: { turn: 1 } })).toBe(true)
    answer(extractor, 'v1', 'Rp 250.000')
    await resolving
  })

  it('leaves a conversation\'s own events to the bridge', () => {
    expect(build(fakeHost().host).handle('tg-abc', { type: 'turn/start' })).toBe(false)
  })

  it('stops claiming once the reading is done', async () => {
    const fake = fakeHost()
    const extractor = build(fake.host)

    const resolving = extractor.resolve(withImage('how much?'))
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(1))
    answer(extractor, 'v1', 'Rp 250.000')
    await resolving

    expect(extractor.handle('v1', { type: 'turn/start' })).toBe(false)
  })
})
