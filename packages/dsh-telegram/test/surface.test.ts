import { describe, expect, it } from 'vitest'

import { Config } from '../src/config.js'
import { telegramSurface } from '../src/interact/surface.js'
import type { TelegramApi } from '../src/telegram/api.js'

/** A Bot API stand-in recording the exact options the surface builds. */
function fakeApi() {
  const sends: Record<string, unknown>[] = []
  const edits: Record<string, unknown>[] = []

  const api = {
    async sendMessage(options: Record<string, unknown>) {
      sends.push(options)
      return { messageId: 55 }
    },
    async editMessageText(options: Record<string, unknown>) {
      edits.push(options)
      return 'edited' as const
    },
  } as unknown as TelegramApi

  return { api, sends, edits }
}

describe('telegramSurface', () => {
  it('returns the id of the message it posted', async () => {
    const { api } = fakeApi()
    await expect(telegramSurface(api).send({ chatId: '1' }, 'hi')).resolves.toBe(55)
  })

  it('passes the chat and html straight through', async () => {
    const { api, sends } = fakeApi()
    await telegramSurface(api).send({ chatId: '1' }, '<b>hi</b>')
    expect(sends[0]).toMatchObject({ chatId: '1', html: '<b>hi</b>' })
  })

  it('omits the thread id for an ordinary chat', async () => {
    const { api, sends } = fakeApi()
    await telegramSurface(api).send({ chatId: '1' }, 'hi')
    expect(sends[0]).not.toHaveProperty('threadId')
  })

  it('carries the thread id for a forum topic', async () => {
    const { api, sends } = fakeApi()
    await telegramSurface(api).send({ chatId: '1', threadId: 9 }, 'hi')
    expect(sends[0]).toMatchObject({ threadId: 9 })
  })

  it('attaches a keyboard when one is given', async () => {
    const { api, sends } = fakeApi()
    await telegramSurface(api).send({ chatId: '1' }, 'hi', [[{ text: 'A', callbackData: 'x' }]])
    expect(sends[0]?.keyboard).toEqual([[{ text: 'A', callbackData: 'x' }]])
  })

  it('omits the keyboard field entirely when there is none', async () => {
    const { api, sends } = fakeApi()
    await telegramSurface(api).send({ chatId: '1' }, 'hi')
    expect(sends[0]).not.toHaveProperty('keyboard')
  })

  it('edits by message id', async () => {
    const { api, edits } = fakeApi()
    await telegramSurface(api).edit({ chatId: '1' }, 7, 'new')
    expect(edits[0]).toMatchObject({ chatId: '1', messageId: 7, html: 'new' })
  })

  it('passes an empty keyboard through, which is how buttons are retired', async () => {
    const { api, edits } = fakeApi()
    await telegramSurface(api).edit({ chatId: '1' }, 7, 'done', [])
    expect(edits[0]?.keyboard).toEqual([])
  })
})

describe('Config', () => {
  it('fills in every default, so an empty config is usable', () => {
    const config = Config({})
    expect(config.enabled).toBe(true)
    expect(config.tokenRef).toBe('TELEGRAM_BOT_TOKEN')
    expect(config.baseUrl).toBe('https://api.telegram.org')
  })

  it('defaults to no allowlist, which is what enables the claim flow', () => {
    expect(Config({}).allowFrom).toEqual([])
  })

  it('defaults streaming on, with a throttle Telegram tolerates', () => {
    const config = Config({})
    expect(config.streaming.enabled).toBe(true)
    expect(config.streaming.throttleMs).toBeGreaterThanOrEqual(1000)
  })

  it('keeps values the operator set', () => {
    const config = Config({ tokenRef: 'MY_BOT', allowFrom: [42] })
    expect(config.tokenRef).toBe('MY_BOT')
    expect(config.allowFrom).toEqual([42])
  })

  it('has no place to put a token, only a reference to one', () => {
    expect(Object.keys(Config({}))).not.toContain('token')
  })
})
