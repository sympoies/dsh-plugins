import { describe, expect, it, vi } from 'vitest'

import { TelegramApprovalAnswerer, decodeApprovalCallback } from '../src/interact/approvals.js'
import { PendingRegistry } from '../src/interact/pending.js'
import type { ChatSurface } from '../src/interact/surface.js'
import type { InlineKeyboard } from '../src/telegram/types.js'

function fakeSurface() {
  const sent: { html: string; keyboard?: InlineKeyboard }[] = []
  const edits: { html: string; keyboard?: InlineKeyboard }[] = []
  const surface: ChatSurface = {
    async send(_target, html, keyboard) {
      sent.push({ html, ...(keyboard ? { keyboard } : {}) })
      return sent.length
    },
    async edit(_target, _messageId, html, keyboard) {
      edits.push({ html, ...(keyboard ? { keyboard } : {}) })
    },
  }
  return { surface, sent, edits }
}

function build(options: { bound?: boolean } = {}) {
  const chat = fakeSurface()
  const answerer = new TelegramApprovalAnswerer({
    surface: chat.surface,
    pending: new PendingRegistry<unknown>(),
    targetOf: (sessionId) =>
      options.bound === false || sessionId !== 'S' ? undefined : { chatId: '42' },
  })
  return { answerer, chat }
}

const agent = { id: 'S', session: { id: 'S' } }

/** Press the button carrying `label` on the pending approval message. */
async function pressLabel(
  chat: ReturnType<typeof fakeSurface>,
  answerer: TelegramApprovalAnswerer,
  label: string,
) {
  await vi.waitFor(() => expect(chat.sent).toHaveLength(1))
  const button = chat.sent[0]?.keyboard?.flat().find((b) => b.text.includes(label))
  expect(button).toBeDefined()
  answerer.handleCallback(button?.callbackData as string)
}

describe('TelegramApprovalAnswerer', () => {
  it('asks in the bound chat, naming the tool', async () => {
    const { answerer, chat } = build()
    const outcome = answerer.decide({ agent, toolName: 'bash' })
    await pressLabel(chat, answerer, 'Allow')

    expect(chat.sent[0]?.html).toContain('bash')
    await outcome
  })

  it('shows the stated reason', async () => {
    const { answerer, chat } = build()
    const outcome = answerer.decide({ agent, toolName: 'bash', reason: 'rm -rf build/' })
    await pressLabel(chat, answerer, 'Allow')

    expect(chat.sent[0]?.html).toContain('rm -rf build/')
    await outcome
  })

  it('escapes html in the reason, which is model-authored text', async () => {
    const { answerer, chat } = build()
    const outcome = answerer.decide({ agent, toolName: 'bash', reason: 'echo <b>hi</b>' })
    await pressLabel(chat, answerer, 'Allow')

    expect(chat.sent[0]?.html).toContain('&lt;b&gt;')
    await outcome
  })

  it('grants a single use when Allow is pressed', async () => {
    const { answerer, chat } = build()
    const outcome = answerer.decide({ agent, toolName: 'bash' })
    await pressLabel(chat, answerer, 'Allow')

    await expect(outcome).resolves.toBe('allowed-once')
  })

  it('rejects when Reject is pressed', async () => {
    const { answerer, chat } = build()
    const outcome = answerer.decide({ agent, toolName: 'bash' })
    await pressLabel(chat, answerer, 'Reject')

    await expect(outcome).resolves.toBe('rejected')
  })

  it('retires the keyboard once decided', async () => {
    const { answerer, chat } = build()
    const outcome = answerer.decide({ agent, toolName: 'bash' })
    await pressLabel(chat, answerer, 'Allow')
    await outcome

    expect(chat.edits[chat.edits.length - 1]?.keyboard).toEqual([])
  })

  it('reports cancelled when the agent gives up first', async () => {
    const { answerer, chat } = build()
    const controller = new AbortController()
    const outcome = answerer.decide({ agent, toolName: 'bash', signal: controller.signal })

    await vi.waitFor(() => expect(chat.sent).toHaveLength(1))
    controller.abort()
    await expect(outcome).resolves.toBe('cancelled')
  })

  it('declines the request when the session has no Telegram chat', async () => {
    const { answerer, chat } = build({ bound: false })
    await expect(answerer.decide({ agent, toolName: 'bash' })).resolves.toBeUndefined()
    expect(chat.sent).toHaveLength(0)
  })

  it('fails closed as unavailable when the chat cannot be reached', async () => {
    const chat = fakeSurface()
    const answerer = new TelegramApprovalAnswerer({
      surface: {
        ...chat.surface,
        send: async () => {
          throw new Error('telegram is down')
        },
      },
      pending: new PendingRegistry<unknown>(),
      targetOf: () => ({ chatId: '42' }),
    })

    await expect(answerer.decide({ agent, toolName: 'bash' })).resolves.toBe('unavailable')
  })

  it('ignores a press for an approval that is already decided', () => {
    const { answerer } = build()
    expect(answerer.handleCallback('a:gone:0')).toBe(false)
  })

  it('ignores callback data belonging to questions', () => {
    const { answerer } = build()
    expect(answerer.handleCallback('q:abc:0')).toBe(false)
  })
})

describe('decodeApprovalCallback', () => {
  it('decodes an approval press', () => {
    expect(decodeApprovalCallback('a:tok:1')).toEqual({ token: 'tok', index: 1 })
  })

  it('rejects other kinds and malformed data', () => {
    expect(decodeApprovalCallback('q:tok:1')).toBeUndefined()
    expect(decodeApprovalCallback('a:tok')).toBeUndefined()
    expect(decodeApprovalCallback(undefined)).toBeUndefined()
  })
})
