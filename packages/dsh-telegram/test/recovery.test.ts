import { describe, expect, it, vi } from 'vitest'

import { RecoveryOffer, needsFreshConversation } from '../src/session/recovery.js'
import { PendingRegistry } from '../src/interact/pending.js'
import type { ChatSurface } from '../src/interact/surface.js'
import type { InlineKeyboard } from '../src/telegram/types.js'

describe('needsFreshConversation', () => {
  it('recognises content the provider will not take', () => {
    // The request carries the whole history, so this is never about the
    // message just sent, and retrying can never clear it.
    expect(needsFreshConversation({ message: 'anything', code: 'UNSUPPORTED_CONTENT' })).toBe(true)
  })

  it('recognises the message even without the code', () => {
    expect(
      needsFreshConversation({ message: 'DeepSeek model "x" does not accept image input.' }),
    ).toBe(true)
  })

  it('recognises the other provider\'s wording for the same thing', () => {
    expect(needsFreshConversation({ message: 'pi-ai model "x" does not support image input' })).toBe(
      true,
    )
  })

  it('leaves a failure that may pass on its own alone', () => {
    expect(needsFreshConversation({ message: 'rate limited', code: 'RATE_LIMIT' })).toBe(false)
    expect(needsFreshConversation({ message: 'connection reset' })).toBe(false)
  })
})

/** An offer over a recording chat, with a spy on the reset it may perform. */
function build(options: { bound?: boolean; resetFails?: boolean } = {}) {
  const sent: { html: string; keyboard?: InlineKeyboard }[] = []
  const surface: ChatSurface = {
    async send(_target, html, keyboard) {
      sent.push({ html, ...(keyboard ? { keyboard } : {}) })
      return sent.length
    },
    async edit() {
      return undefined
    },
    async sendMarkdown() {
      return 1
    },
  }

  const reset = vi.fn(async () => {
    if (options.resetFails) throw new Error('could not dispose')
  })

  const offer = new RecoveryOffer({
    surface,
    pending: new PendingRegistry<unknown>(),
    targetOf: (sessionId) =>
      options.bound === false || sessionId !== 'S' ? undefined : { chatId: '42' },
    reset,
  })

  return { offer, sent, reset }
}

const STUCK = { message: 'model "x" does not accept image input.', code: 'UNSUPPORTED_CONTENT' }

/** Press the offer's button. */
function press(sent: { keyboard?: InlineKeyboard }[], offer: RecoveryOffer) {
  const data = sent[sent.length - 1]?.keyboard?.flat()[0]?.callbackData
  expect(data).toBeDefined()
  return offer.handleCallback(data as string)
}

describe('RecoveryOffer — a conversation that cannot continue', () => {
  it('says what failed', async () => {
    const { offer, sent } = build()
    void offer.offer('S', STUCK)

    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]?.html).toContain('does not accept image input')
  })

  it('offers the exit as a button, not as a command to remember', async () => {
    const { offer, sent } = build()
    void offer.offer('S', STUCK)

    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]?.keyboard?.flat()).toHaveLength(1)
    expect(sent[0]?.keyboard?.flat()[0]?.text).toContain('fresh conversation')
  })

  it('starts a fresh conversation when the button is pressed', async () => {
    const { offer, sent, reset } = build()
    void offer.offer('S', STUCK)

    await vi.waitFor(() => expect(sent).toHaveLength(1))
    press(sent, offer)

    await vi.waitFor(() => expect(reset).toHaveBeenCalledWith({ chatId: '42' }))
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[1]?.html).toContain('Started a fresh conversation')
  })

  it('offers once, however many turns fail the same way', async () => {
    // A user retrying hits the same wall each time; one offer is enough.
    const { offer, sent } = build()
    void offer.offer('S', STUCK)
    await vi.waitFor(() => expect(sent).toHaveLength(1))

    await offer.offer('S', STUCK)
    await offer.offer('S', STUCK)
    expect(sent).toHaveLength(1)
  })

  it('offers again after the first offer was taken', async () => {
    const { offer, sent } = build()
    void offer.offer('S', STUCK)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    press(sent, offer)
    await vi.waitFor(() => expect(sent).toHaveLength(2))

    void offer.offer('S', STUCK)
    await vi.waitFor(() => expect(sent).toHaveLength(3))
  })

  it('says so when the reset itself fails, naming the fallback', async () => {
    const { offer, sent } = build({ resetFails: true })
    void offer.offer('S', STUCK)

    await vi.waitFor(() => expect(sent).toHaveLength(1))
    press(sent, offer)

    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[1]?.html).toContain('/new')
  })
})

describe('RecoveryOffer — a failure that may pass', () => {
  it('reports it without a button, since retrying may work', async () => {
    const { offer, sent } = build()
    await offer.offer('S', { message: 'rate limited', code: 'RATE_LIMIT' })

    expect(sent).toHaveLength(1)
    expect(sent[0]?.keyboard).toBeUndefined()
    expect(sent[0]?.html).toContain('rate limited')
  })

  it('reports every one, since each is a separate event', async () => {
    const { offer, sent } = build()
    await offer.offer('S', { message: 'first' })
    await offer.offer('S', { message: 'second' })
    expect(sent).toHaveLength(2)
  })
})

describe('RecoveryOffer — what it stays out of', () => {
  it('says nothing for a session with no Telegram chat', async () => {
    const { offer, sent } = build({ bound: false })
    await offer.offer('S', STUCK)
    expect(sent).toHaveLength(0)
  })

  it('ignores a press belonging to another feature', () => {
    const { offer } = build()
    expect(offer.handleCallback('q:tok:0')).toBe(false)
    expect(offer.handleCallback('a:tok:0')).toBe(false)
  })

  it('ignores malformed callback data', () => {
    const { offer } = build()
    expect(offer.handleCallback('r:tok')).toBe(false)
    expect(offer.handleCallback('r::0')).toBe(false)
    expect(offer.handleCallback(undefined)).toBe(false)
  })

  it('ignores a press for an offer that is already gone', () => {
    const { offer } = build()
    expect(offer.handleCallback('r:vanished:0')).toBe(false)
  })
})
