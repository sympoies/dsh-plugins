import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TypingIndicator } from '../src/telegram/typing.js'

/** A Bot API stand-in recording every action sent. */
function fakeChat(options: { fails?: boolean } = {}) {
  const actions: { chatId: string; action: string; threadId?: number }[] = []
  return {
    actions,
    chat: {
      async sendChatAction(chatId: string, action: 'typing', threadId?: number) {
        actions.push({ chatId, action, ...(threadId === undefined ? {} : { threadId }) })
        if (options.fails) throw new Error('chat not found')
      },
    },
  }
}

beforeEach(() => void vi.useFakeTimers())
afterEach(() => void vi.useRealTimers())

const CHAT = { chatId: '42' }

describe('TypingIndicator — showing it', () => {
  it('shows it at once, without waiting for the first refresh', async () => {
    const fake = fakeChat()
    new TypingIndicator({ chat: fake.chat }).hold(CHAT)

    expect(fake.actions).toEqual([{ chatId: '42', action: 'typing' }])
  })

  it('keeps it alive past the five seconds Telegram gives it', async () => {
    // The whole reason this exists: one call lapses long before a vision model
    // has finished reading an image, so the bot looks like it died.
    const fake = fakeChat()
    new TypingIndicator({ chat: fake.chat }).hold(CHAT)

    await vi.advanceTimersByTimeAsync(13_000)
    expect(fake.actions.length).toBeGreaterThanOrEqual(3)
  })

  it('addresses a forum topic, not just its chat', async () => {
    const fake = fakeChat()
    new TypingIndicator({ chat: fake.chat }).hold({ chatId: '42', threadId: 7 })

    expect(fake.actions[0]).toEqual({ chatId: '42', action: 'typing', threadId: 7 })
  })
})

describe('TypingIndicator — stopping it', () => {
  it('stops refreshing once released', async () => {
    const fake = fakeChat()
    const release = new TypingIndicator({ chat: fake.chat }).hold(CHAT)

    release()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(fake.actions).toHaveLength(1)
  })

  it('ignores a release called twice, which would drop somebody else\'s hold', async () => {
    const fake = fakeChat()
    const indicator = new TypingIndicator({ chat: fake.chat })

    const first = indicator.hold(CHAT)
    indicator.hold(CHAT)
    first()
    first()

    await vi.advanceTimersByTimeAsync(5_000)
    expect(fake.actions.length).toBeGreaterThan(1)
  })

  it('gives up on its own if a release never comes', async () => {
    // A listener dropped mid-turn would otherwise leave a chat typing forever.
    const fake = fakeChat()
    new TypingIndicator({ chat: fake.chat, maxHoldMs: 30_000 }).hold(CHAT)

    await vi.advanceTimersByTimeAsync(31_000)
    const settled = fake.actions.length
    await vi.advanceTimersByTimeAsync(20_000)

    expect(fake.actions).toHaveLength(settled)
  })

  it('stops every conversation when the plugin unloads', async () => {
    const fake = fakeChat()
    const indicator = new TypingIndicator({ chat: fake.chat })
    indicator.hold(CHAT)
    indicator.hold({ chatId: '43' })

    indicator.dispose()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(fake.actions).toHaveLength(2)
  })
})

describe('TypingIndicator — overlapping holds', () => {
  it('shows it once however many holders there are', () => {
    const fake = fakeChat()
    const indicator = new TypingIndicator({ chat: fake.chat })

    indicator.hold(CHAT)
    indicator.hold(CHAT)
    expect(fake.actions).toHaveLength(1)
  })

  it('keeps going until the last holder lets go', async () => {
    // The router holds it while an image is read and the bridge holds it while
    // the turn runs; the first to finish must not stop the other's indicator.
    const fake = fakeChat()
    const indicator = new TypingIndicator({ chat: fake.chat })

    const reading = indicator.hold(CHAT)
    const turn = indicator.hold(CHAT)

    reading()
    await vi.advanceTimersByTimeAsync(9_000)
    const during = fake.actions.length
    expect(during).toBeGreaterThan(1)

    turn()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(fake.actions).toHaveLength(during)
  })

  it('keeps conversations apart, so one release does not quiet another', async () => {
    const fake = fakeChat()
    const indicator = new TypingIndicator({ chat: fake.chat })

    const one = indicator.hold(CHAT)
    indicator.hold({ chatId: '43' })
    one()

    await vi.advanceTimersByTimeAsync(9_000)
    expect(fake.actions.filter((entry) => entry.chatId === '42')).toHaveLength(1)
    expect(fake.actions.filter((entry) => entry.chatId === '43').length).toBeGreaterThan(1)
  })

  it('treats a forum topic as its own conversation', () => {
    const fake = fakeChat()
    const indicator = new TypingIndicator({ chat: fake.chat })

    indicator.hold({ chatId: '42', threadId: 1 })
    indicator.hold({ chatId: '42', threadId: 2 })
    expect(fake.actions).toHaveLength(2)
  })
})

describe('TypingIndicator — when it cannot be shown', () => {
  it('carries on when the call fails, since this is decoration', async () => {
    const fake = fakeChat({ fails: true })
    const indicator = new TypingIndicator({ chat: fake.chat })

    expect(() => indicator.hold(CHAT)).not.toThrow()
    await vi.advanceTimersByTimeAsync(9_000)
    expect(fake.actions.length).toBeGreaterThan(1)
  })

  it('does nothing at all where the deployment offers no action call', () => {
    const indicator = new TypingIndicator({ chat: {} })
    expect(() => indicator.hold(CHAT)()).not.toThrow()
  })
})
