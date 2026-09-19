import { describe, expect, it, vi } from 'vitest'

import { clamp, escapeWithin } from '../src/render/clamp.js'
import { PendingRegistry } from '../src/interact/pending.js'
import { TelegramApprovalAnswerer } from '../src/interact/approvals.js'
import { TelegramQuestionProvider } from '../src/interact/questions.js'
import type { ChatSurface } from '../src/interact/surface.js'
import type { InlineKeyboard } from '../src/telegram/types.js'

/** Telegram's limit for a plain text message. */
const TELEGRAM_LIMIT = 4096

describe('escapeWithin', () => {
  it('leaves short text alone', () => {
    expect(escapeWithin('hello', 100)).toBe('hello')
  })

  it('still escapes what it keeps', () => {
    expect(escapeWithin('a < b & c', 100)).toBe('a &lt; b &amp; c')
  })

  it('respects the budget for ordinary text', () => {
    expect(escapeWithin('x'.repeat(500), 100).length).toBeLessThanOrEqual(100)
  })

  it('respects the budget when escaping expands the text fivefold', () => {
    // Every '&' becomes '&amp;', so a naive cut would overshoot by 5x.
    const result = escapeWithin('&'.repeat(500), 100)
    expect(result.length).toBeLessThanOrEqual(100)
  })

  it('never cuts an html entity in half', () => {
    const result = escapeWithin('&'.repeat(500), 100)
    expect(result).not.toMatch(/&[a-z]*$/)
    expect(result.replace(/…$/, '')).toMatch(/^(?:&amp;)*$/)
  })

  it('marks that it cut something', () => {
    expect(escapeWithin('x'.repeat(500), 100)).toMatch(/…$/)
  })

  it('returns nothing for a budget of zero', () => {
    expect(escapeWithin('anything', 0)).toBe('')
  })
})

describe('clamp', () => {
  it('leaves short text alone', () => {
    expect(clamp('hello', 100)).toBe('hello')
  })

  it('cuts to the budget', () => {
    expect(clamp('x'.repeat(500), 50).length).toBeLessThanOrEqual(50)
  })

  it('prefers a word boundary when one is close', () => {
    expect(clamp('the quick brown fox jumps over', 20)).not.toMatch(/\s…$/)
    expect(clamp('the quick brown fox jumps over', 20)).toMatch(/…$/)
  })
})

/** A surface recording what would go over the wire. */
function fakeSurface() {
  const sent: { html: string; keyboard?: InlineKeyboard }[] = []
  const surface: ChatSurface = {
    async send(_target, html, keyboard) {
      sent.push({ html, ...(keyboard ? { keyboard } : {}) })
      return sent.length
    },
    async edit(_target, _messageId, html, keyboard) {
      sent.push({ html, ...(keyboard ? { keyboard } : {}) })
    },
    async sendMarkdown(_target, markdown) {
      sent.push({ html: markdown })
      return sent.length
    },
  }
  return { surface, sent }
}

const agent = { id: 'S', session: { id: 'S' } }

describe('an approval with a huge reason', () => {
  it('still fits in one message, so the buttons actually appear', async () => {
    const chat = fakeSurface()
    const answerer = new TelegramApprovalAnswerer({
      surface: chat.surface,
      pending: new PendingRegistry<unknown>(),
      targetOf: () => ({ chatId: '42' }),
    })

    const outcome = answerer.decide({
      agent,
      toolName: 'bash',
      // A tool that quotes an entire file back as its reason.
      reason: 'rm -rf ./build && '.repeat(2000),
    })

    await vi.waitFor(() => expect(chat.sent).toHaveLength(1))
    expect(chat.sent[0]?.html.length).toBeLessThanOrEqual(TELEGRAM_LIMIT)
    expect(chat.sent[0]?.keyboard?.flat()).toHaveLength(2)

    const allow = chat.sent[0]?.keyboard?.flat()[0]?.callbackData
    answerer.handleCallback(allow as string)
    await expect(outcome).resolves.toBe('allowed-once')
  })

  it('keeps the beginning of the reason, which is the part that matters', async () => {
    const chat = fakeSurface()
    const answerer = new TelegramApprovalAnswerer({
      surface: chat.surface,
      pending: new PendingRegistry<unknown>(),
      targetOf: () => ({ chatId: '42' }),
    })

    void answerer.decide({ agent, toolName: 'bash', reason: `DELETE EVERYTHING ${'x'.repeat(9000)}` })
    await vi.waitFor(() => expect(chat.sent).toHaveLength(1))

    expect(chat.sent[0]?.html).toContain('DELETE EVERYTHING')
  })

  it('survives a reason made entirely of characters that expand when escaped', async () => {
    const chat = fakeSurface()
    const answerer = new TelegramApprovalAnswerer({
      surface: chat.surface,
      pending: new PendingRegistry<unknown>(),
      targetOf: () => ({ chatId: '42' }),
    })

    void answerer.decide({ agent, toolName: 'bash', reason: '<&>'.repeat(3000) })
    await vi.waitFor(() => expect(chat.sent).toHaveLength(1))

    expect(chat.sent[0]?.html.length).toBeLessThanOrEqual(TELEGRAM_LIMIT)
  })
})

describe('a question with verbose options', () => {
  it('still fits in one message', async () => {
    const chat = fakeSurface()
    const provider = new TelegramQuestionProvider({
      surface: chat.surface,
      pending: new PendingRegistry<unknown>(),
      targetOf: () => ({ chatId: '42' }),
      readText: async () => undefined,
    })

    void provider.ask({
      questions: [
        {
          id: 'q',
          header: 'H'.repeat(500),
          question: 'Q'.repeat(4000),
          options: Array.from({ length: 20 }, (_, i) => ({
            label: `option ${i}`,
            description: 'D'.repeat(600),
          })),
        },
      ],
      agent,
    })

    await vi.waitFor(() => expect(chat.sent).toHaveLength(1))
    expect(chat.sent[0]?.html.length).toBeLessThanOrEqual(TELEGRAM_LIMIT)
  })

  it('still offers every option as a button, even those it did not describe', async () => {
    const chat = fakeSurface()
    const provider = new TelegramQuestionProvider({
      surface: chat.surface,
      pending: new PendingRegistry<unknown>(),
      targetOf: () => ({ chatId: '42' }),
      readText: async () => undefined,
    })

    void provider.ask({
      questions: [
        {
          id: 'q',
          question: 'Pick one',
          options: Array.from({ length: 20 }, (_, i) => ({
            label: `option ${i}`,
            description: 'D'.repeat(600),
          })),
        },
      ],
      agent,
    })

    await vi.waitFor(() => expect(chat.sent).toHaveLength(1))
    // 20 options plus the "Other…" row.
    expect(chat.sent[0]?.keyboard?.flat()).toHaveLength(21)
  })
})
