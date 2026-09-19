import { describe, expect, it, vi } from 'vitest'

import { TelegramQuestionProvider, decodeCallback } from '../src/interact/questions.js'
import { PendingRegistry } from '../src/interact/pending.js'
import type { ChatSurface, ChatTarget } from '../src/interact/surface.js'
import type { InlineKeyboard } from '../src/telegram/types.js'
import type { AskUserQuestionItem, UserQuestionProvider } from '../src/harness/types.js'

/** A chat surface that records everything and lets a test read the keyboard back. */
function fakeSurface() {
  const sent: { html: string; keyboard?: InlineKeyboard }[] = []
  const edits: { messageId: number; html: string; keyboard?: InlineKeyboard }[] = []
  let nextId = 100

  const markdown: string[] = []

  const surface: ChatSurface = {
    async send(_target: ChatTarget, html, keyboard) {
      sent.push({ html, ...(keyboard ? { keyboard } : {}) })
      return (nextId += 1)
    },
    async sendMarkdown(_target: ChatTarget, text) {
      markdown.push(text)
      sent.push({ html: text })
      return (nextId += 1)
    },
    async edit(_target, messageId, html, keyboard) {
      edits.push({ messageId, html, ...(keyboard ? { keyboard } : {}) })
    },
  }

  return { surface, sent, edits, markdown, last: () => sent[sent.length - 1] }
}

/** Build a provider wired to a fake chat, bound to session 'S'. */
function build(options: { fallback?: UserQuestionProvider; bound?: boolean } = {}) {
  const chat = fakeSurface()
  const pending = new PendingRegistry<unknown>()
  const provider = new TelegramQuestionProvider({
    surface: chat.surface,
    pending,
    targetOf: (sessionId) => (options.bound === false || sessionId !== 'S' ? undefined : { chatId: '42' }),
    readText: async () => 'typed answer',
    ...(options.fallback ? { fallback: options.fallback } : {}),
  })
  return { provider, pending, chat }
}

/**
 * Press a button on the nth question message. `nth` matters: each question is
 * its own send, and pressing the previous question's stale token would hang.
 */
async function press(
  chat: ReturnType<typeof fakeSurface>,
  provider: TelegramQuestionProvider,
  row = 0,
  column = 0,
  nth = 0,
) {
  await vi.waitFor(() => expect(chat.sent.length).toBeGreaterThan(nth))
  const data = chat.sent[nth]?.keyboard?.[row]?.[column]?.callbackData
  expect(data).toBeDefined()
  provider.handleCallback(data as string)
}

const agent = { id: 'S', session: { id: 'S' } }

const QUESTION: AskUserQuestionItem = {
  id: 'q1',
  question: 'Deploy to production?',
  options: [{ label: 'Yes' }, { label: 'No' }],
}

describe('TelegramQuestionProvider — single select', () => {
  it('sends the question with one button per option', async () => {
    const { provider, chat } = build()
    const answer = provider.ask({ questions: [QUESTION], agent })
    await press(chat, provider)

    expect(chat.sent).toHaveLength(1)
    expect(chat.sent[0]?.html).toContain('Deploy to production?')
    expect(chat.sent[0]?.keyboard?.flat().map((b) => b.text)).toEqual(['Yes', 'No', '✏️ Other…'])
    await answer
  })

  it('resolves with the pressed option label', async () => {
    const { provider, chat } = build()
    const answer = provider.ask({ questions: [QUESTION], agent })
    await press(chat, provider, 1, 0)

    await expect(answer).resolves.toEqual({ answers: [{ id: 'q1', selected: ['No'] }] })
  })

  it('retires the keyboard and shows the choice once answered', async () => {
    const { provider, chat } = build()
    const answer = provider.ask({ questions: [QUESTION], agent })
    await press(chat, provider)
    await answer

    const final = chat.edits[chat.edits.length - 1]
    expect(final?.keyboard).toEqual([])
    expect(final?.html).toContain('Yes')
  })

  it('escapes html in the question text', async () => {
    const { provider, chat } = build()
    const answer = provider.ask({
      questions: [{ id: 'q', question: 'Use <script> tags?', options: [{ label: 'ok' }] }],
      agent,
    })
    await press(chat, provider)
    expect(chat.sent[0]?.html).toContain('&lt;script&gt;')
    await answer
  })

  it('renders an option description under its label', async () => {
    const { provider, chat } = build()
    const answer = provider.ask({
      questions: [{ id: 'q', question: 'Pick', options: [{ label: 'A', description: 'the safe one' }] }],
      agent,
    })
    await press(chat, provider)
    expect(chat.sent[0]?.html).toContain('the safe one')
    await answer
  })

  it('asks several questions one after another', async () => {
    const { provider, chat } = build()
    const answer = provider.ask({
      questions: [QUESTION, { ...QUESTION, id: 'q2', question: 'Also run migrations?' }],
      agent,
    })
    await press(chat, provider, 0, 0, 0)
    await press(chat, provider, 1, 0, 1)

    await expect(answer).resolves.toEqual({
      answers: [
        { id: 'q1', selected: ['Yes'] },
        { id: 'q2', selected: ['No'] },
      ],
    })
    expect(chat.sent).toHaveLength(2)
  })
})

describe('TelegramQuestionProvider — multi select', () => {
  const MULTI: AskUserQuestionItem = {
    id: 'm',
    question: 'Which checks?',
    multiSelect: true,
    options: [{ label: 'lint' }, { label: 'test' }, { label: 'build' }],
  }

  it('keeps the keyboard open while options are toggled', async () => {
    const { provider, chat } = build()
    const answer = provider.ask({ questions: [MULTI], agent })

    await press(chat, provider, 0, 0)
    await vi.waitFor(() => expect(chat.edits.length).toBeGreaterThan(0))
    expect(chat.edits[0]?.keyboard?.flat().some((b) => b.text.startsWith('✅'))).toBe(true)

    const done = lastKeyboard(chat).flat().find((b) => b.text.includes('Done'))
    provider.handleCallback(done?.callbackData as string)
    await expect(answer).resolves.toEqual({ answers: [{ id: 'm', selected: ['lint'] }] })
  })

  it('collects several selections', async () => {
    const { provider, chat } = build()
    const answer = provider.ask({ questions: [MULTI], agent })

    await press(chat, provider, 0, 0)
    await toggleByLabel(chat, provider, 'test')
    const done = lastKeyboard(chat).flat().find((b) => b.text.includes('Done'))
    provider.handleCallback(done?.callbackData as string)

    await expect(answer).resolves.toEqual({ answers: [{ id: 'm', selected: ['lint', 'test'] }] })
  })

  it('un-toggles an option pressed twice', async () => {
    const { provider, chat } = build()
    const answer = provider.ask({ questions: [MULTI], agent })

    await press(chat, provider, 0, 0)
    await toggleByLabel(chat, provider, 'lint')
    const done = lastKeyboard(chat).flat().find((b) => b.text.includes('Done'))
    provider.handleCallback(done?.callbackData as string)

    await expect(answer).resolves.toEqual({ answers: [{ id: 'm', selected: [] }] })
  })
})

describe('TelegramQuestionProvider — free text', () => {
  it('offers an Other button that reads the next chat message', async () => {
    const { provider, chat } = build()
    const answer = provider.ask({ questions: [QUESTION], agent })

    await vi.waitFor(() => expect(chat.last()?.keyboard).toBeDefined())
    const other = lastKeyboard(chat).flat().find((b) => b.text.includes('Other'))
    expect(other).toBeDefined()
    provider.handleCallback(other?.callbackData as string)

    await expect(answer).resolves.toEqual({
      answers: [{ id: 'q1', selected: [], custom: 'typed answer' }],
    })
  })

  it('asks for free text directly when a question offers no options', async () => {
    const { provider, chat } = build()
    const answer = provider.ask({ questions: [{ id: 'open', question: 'Which branch?' }], agent })

    await expect(answer).resolves.toEqual({
      answers: [{ id: 'open', selected: [], custom: 'typed answer' }],
    })
    expect(chat.sent[0]?.keyboard).toBeUndefined()
  })
})

describe('TelegramQuestionProvider — plan review', () => {
  it('shows the plan body and labels the approving button', async () => {
    const { provider, chat } = build()
    const answer = provider.ask({
      questions: [
        {
          id: 'plan',
          question: 'Approve this plan?',
          detail: '## Steps\n\n- do a thing',
          intent: { kind: 'plan-review', approve: 'Go ahead' },
          options: [{ label: 'Go ahead' }, { label: 'Revise' }],
        },
      ],
      agent,
    })

    await vi.waitFor(() => expect(chat.last()?.keyboard).toBeDefined())
    // The plan is agent-authored markdown, sent for Telegram to render, so it
    // arrives exactly as written rather than converted on the way.
    expect(chat.markdown).toEqual(['## Steps\n\n- do a thing'])
    expect(lastKeyboard(chat).flat()[0]?.text).toContain('Go ahead')

    // The plan body is its own message, so the buttons are on the second send.
    await press(chat, provider, 0, 0, 1)
    await expect(answer).resolves.toEqual({ answers: [{ id: 'plan', selected: ['Go ahead'] }] })
  })
})

describe('TelegramQuestionProvider — delegation and failure', () => {
  it('delegates to the previous provider when the session is not a Telegram one', async () => {
    const fallback = { ask: vi.fn(async () => ({ answers: [{ id: 'q1', selected: ['web'] }] })) }
    const { provider } = build({ fallback, bound: false })

    await expect(provider.ask({ questions: [QUESTION], agent })).resolves.toEqual({
      answers: [{ id: 'q1', selected: ['web'] }],
    })
    expect(fallback.ask).toHaveBeenCalledOnce()
  })

  it('rejects when there is no Telegram chat and no provider to delegate to', async () => {
    const { provider } = build({ bound: false })
    await expect(provider.ask({ questions: [QUESTION], agent })).rejects.toThrow(/no telegram chat/i)
  })

  it('rejects when the agent gives up before the user answers', async () => {
    const { provider, chat } = build()
    const controller = new AbortController()
    const answer = provider.ask({ questions: [QUESTION], agent, signal: controller.signal })

    await vi.waitFor(() => expect(chat.sent).toHaveLength(1))
    controller.abort()
    await expect(answer).rejects.toThrow(/cancel/i)
  })

  it('ignores a press whose token is unknown, so a stale button is inert', () => {
    const { provider } = build()
    expect(provider.handleCallback('q:deadbeef:0')).toBe(false)
  })

  it('ignores callback data it did not produce', () => {
    const { provider } = build()
    expect(provider.handleCallback('something-else')).toBe(false)
  })
})

describe('decodeCallback', () => {
  it('round-trips a question press', () => {
    expect(decodeCallback('q:abc123:2')).toEqual({ token: 'abc123', index: 2 })
  })

  it('rejects data from another feature', () => {
    expect(decodeCallback('a:abc123:0')).toBeUndefined()
  })

  it('rejects malformed data', () => {
    expect(decodeCallback('q:abc123')).toBeUndefined()
    expect(decodeCallback('q:abc123:x')).toBeUndefined()
  })
})

/** The keyboard on the newest message or edit, whichever came last. */
function lastKeyboard(chat: ReturnType<typeof fakeSurface>): InlineKeyboard {
  const edit = chat.edits[chat.edits.length - 1]
  if (edit?.keyboard && edit.keyboard.length > 0) return edit.keyboard
  return chat.last()?.keyboard ?? []
}

/** Wait for a re-render, then press the button carrying `label`. */
async function toggleByLabel(
  chat: ReturnType<typeof fakeSurface>,
  provider: TelegramQuestionProvider,
  label: string,
) {
  const before = chat.edits.length
  await vi.waitFor(() => expect(chat.edits.length).toBeGreaterThanOrEqual(before))
  const button = lastKeyboard(chat).flat().find((b) => b.text.includes(label))
  provider.handleCallback(button?.callbackData as string)
  await vi.waitFor(() => expect(chat.edits.length).toBeGreaterThan(before))
}
