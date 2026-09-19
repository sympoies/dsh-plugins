import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatHistory } from '../src/session/history.js'
import { SessionPicker } from '../src/session/picker.js'
import { PendingRegistry } from '../src/interact/pending.js'
import type { ChatSurface } from '../src/interact/surface.js'
import type { InlineKeyboard } from '../src/telegram/types.js'

const CHAT = { chatId: '1' }
let file: string

beforeEach(async () => {
  file = join(await mkdtemp(join(tmpdir(), 'dsh-telegram-hist-')), 'history.json')
})

const entry = (sessionId: string, label?: string) => ({
  sessionId,
  startedAt: 1_700_000_000_000,
  cwd: '/work',
  ...(label === undefined ? {} : { label }),
})

describe('ChatHistory', () => {
  it('starts empty', async () => {
    expect((await ChatHistory.open(file)).forChat(CHAT)).toEqual([])
  })

  it('remembers a conversation', async () => {
    const history = await ChatHistory.open(file)
    await history.remember(CHAT, entry('s1', 'fix the build'))

    expect(history.forChat(CHAT)).toEqual([
      { sessionId: 's1', startedAt: 1_700_000_000_000, cwd: '/work', label: 'fix the build' },
    ])
  })

  it('puts the newest first, which is the order anyone wants them', async () => {
    const history = await ChatHistory.open(file)
    await history.remember(CHAT, entry('s1', 'one'))
    await history.remember(CHAT, entry('s2', 'two'))

    expect(history.forChat(CHAT).map((item) => item.sessionId)).toEqual(['s2', 's1'])
  })

  it('keeps the opening words, not the latest message', async () => {
    // The opening words identify a conversation; replacing them with whatever
    // was said last would make the list churn under the reader.
    const history = await ChatHistory.open(file)
    await history.remember(CHAT, entry('s1', 'fix the build'))
    await history.remember(CHAT, entry('s1', 'and now deploy it'))

    expect(history.forChat(CHAT)[0]?.label).toBe('fix the build')
  })

  it('clips a label, since a first message can be a whole stack trace', async () => {
    const history = await ChatHistory.open(file)
    await history.remember(CHAT, entry('s1', 'x'.repeat(200)))

    const label = history.forChat(CHAT)[0]?.label ?? ''
    expect(label.length).toBeLessThanOrEqual(60)
    expect(label.endsWith('…')).toBe(true)
  })

  it('flattens whitespace so a pasted log stays one line', async () => {
    const history = await ChatHistory.open(file)
    await history.remember(CHAT, entry('s1', '  fix\n\n the   build '))
    expect(history.forChat(CHAT)[0]?.label).toBe('fix the build')
  })

  it('survives a restart, which is the whole point of a file', async () => {
    const first = await ChatHistory.open(file)
    await first.remember(CHAT, entry('s1', 'fix the build'))

    const second = await ChatHistory.open(file)
    expect(second.forChat(CHAT).map((item) => item.sessionId)).toEqual(['s1'])
  })

  it('keeps chats apart', async () => {
    const history = await ChatHistory.open(file)
    await history.remember(CHAT, entry('s1'))
    await history.remember({ chatId: '2' }, entry('s2'))

    expect(history.forChat(CHAT).map((i) => i.sessionId)).toEqual(['s1'])
    expect(history.forChat({ chatId: '2' }).map((i) => i.sessionId)).toEqual(['s2'])
  })

  it('caps the list, so a busy chat does not grow without limit', async () => {
    const history = await ChatHistory.open(file)
    for (let index = 0; index < 30; index += 1) await history.remember(CHAT, entry(`s${index}`))

    expect(history.forChat(CHAT)).toHaveLength(20)
    expect(history.forChat(CHAT)[0]?.sessionId).toBe('s29')
  })

  it('forgets one whose log has gone', async () => {
    const history = await ChatHistory.open(file)
    await history.remember(CHAT, entry('s1'))
    await history.forget(CHAT, 's1')
    expect(history.forChat(CHAT)).toEqual([])
  })

  it('starts empty rather than refusing to open on a corrupt file', async () => {
    await writeFile(file, '{ not json', 'utf8')
    expect((await ChatHistory.open(file)).forChat(CHAT)).toEqual([])
  })

  it('drops a malformed entry but keeps its neighbours', async () => {
    await writeFile(file, JSON.stringify({ '1': [{ nope: true }, entry('s1')] }), 'utf8')
    const history = await ChatHistory.open(file)
    expect(history.forChat(CHAT).map((i) => i.sessionId)).toEqual(['s1'])
  })
})

/** A picker over a recording chat, with a spy on the session it adopts. */
function build(past: { sessionId: string; label?: string }[], current?: string) {
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

  const adopted: string[] = []
  const picker = new SessionPicker({
    surface,
    pending: new PendingRegistry<unknown>(),
    history: {
      forChat: () => past.map((item) => entry(item.sessionId, item.label)),
    } as never,
    currentSession: () => current,
    adopt: async (_target, sessionId) => void adopted.push(sessionId),
  })

  return { picker, sent, adopted }
}

/** Press the nth button of the newest message. */
function press(sent: { keyboard?: InlineKeyboard }[], picker: SessionPicker, index = 0) {
  const data = sent[sent.length - 1]?.keyboard?.flat()[index]?.callbackData
  expect(data).toBeDefined()
  return picker.handleCallback(data as string)
}

describe('SessionPicker', () => {
  it('offers each earlier conversation as a button', async () => {
    const { picker, sent } = build([{ sessionId: 's1', label: 'fix the build' }], 's2')
    void picker.offer(CHAT)

    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]?.keyboard?.flat()).toHaveLength(1)
    expect(sent[0]?.keyboard?.flat()[0]?.text).toBe('fix the build')
  })

  it('does not offer the conversation you are already in', async () => {
    const { picker, sent } = build(
      [{ sessionId: 's1', label: 'old' }, { sessionId: 's2', label: 'current' }],
      's2',
    )
    void picker.offer(CHAT)

    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]?.keyboard?.flat().map((b) => b.text)).toEqual(['old'])
  })

  it('adopts the one pressed', async () => {
    const { picker, sent, adopted } = build([{ sessionId: 's1', label: 'old' }], 's2')
    void picker.offer(CHAT)

    await vi.waitFor(() => expect(sent).toHaveLength(1))
    press(sent, picker)

    await vi.waitFor(() => expect(adopted).toEqual(['s1']))
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[1]?.html).toContain('Back in')
  })

  it('labels a conversation with no opening words by when it started', async () => {
    const { picker, sent } = build([{ sessionId: 's1' }], 's2')
    void picker.offer(CHAT)

    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]?.keyboard?.flat()[0]?.text).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })

  it('says so when there is nothing to go back to', async () => {
    const { picker, sent } = build([], 's1')
    await picker.offer(CHAT)

    expect(sent).toHaveLength(1)
    expect(sent[0]?.keyboard).toBeUndefined()
    expect(sent[0]?.html).toContain('only conversation')
  })

  it('points a chat with no conversation at starting one', async () => {
    const { picker, sent } = build([])
    await picker.offer(CHAT)
    expect(sent[0]?.html).toContain('send a message')
  })

  it('offers at most a keyboard anyone can use', async () => {
    const many = Array.from({ length: 20 }, (_, index) => ({ sessionId: `s${index}` }))
    const { picker, sent } = build(many, 'current')
    void picker.offer(CHAT)

    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]?.keyboard?.length).toBe(8)
  })

  it('ignores a press belonging to another feature', () => {
    const { picker } = build([{ sessionId: 's1' }], 's2')
    expect(picker.handleCallback('r:tok:0')).toBe(false)
    expect(picker.handleCallback('q:tok:0')).toBe(false)
  })

  it('ignores malformed callback data', () => {
    const { picker } = build([{ sessionId: 's1' }], 's2')
    expect(picker.handleCallback('s:tok')).toBe(false)
    expect(picker.handleCallback('s::0')).toBe(false)
    expect(picker.handleCallback('s:tok:x')).toBe(false)
    expect(picker.handleCallback(undefined)).toBe(false)
  })
})
