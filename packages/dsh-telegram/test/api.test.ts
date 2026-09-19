import { describe, expect, it, vi } from 'vitest'

import { TelegramApi, TelegramApiError } from '../src/telegram/api.js'

const TOKEN = '123456:SUPER-SECRET-TOKEN'

/** Build an api whose transport is a scripted queue of Bot API envelopes. */
function apiWith(responses: unknown[]): { api: TelegramApi; calls: Call[] } {
  const calls: Call[] = []
  const queue = [...responses]

  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body as string) : undefined })
    const next = queue.shift() ?? { ok: true, result: true }
    const status = typeof next === 'object' && next !== null && 'status' in next
      ? (next as { status: number }).status
      : 200
    return {
      ok: status < 400,
      status,
      text: async () => JSON.stringify(next),
      headers: new Map(),
    } as unknown as Response
  }) as unknown as typeof fetch

  const api = new TelegramApi({
    token: TOKEN,
    baseUrl: 'https://api.telegram.org',
    timeoutMs: 1000,
    fetchImpl,
    sleep: async () => undefined,
  })

  return { api, calls }
}

interface Call {
  url: string
  body?: Record<string, unknown>
}

describe('TelegramApi — request shape', () => {
  it('puts the token in the path and the method in the last segment', async () => {
    const { api, calls } = apiWith([{ ok: true, result: { id: 1, is_bot: true } }])
    await api.getMe()
    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`)
  })

  it('asks for callback_query updates, which is what makes buttons work', async () => {
    const { api, calls } = apiWith([{ ok: true, result: [] }])
    await api.getUpdates(0, 25)
    expect(calls[0]?.body?.allowed_updates).toEqual(['message', 'callback_query'])
  })

  it('sends the acknowledged offset so Telegram stops redelivering', async () => {
    const { api, calls } = apiWith([{ ok: true, result: [] }])
    await api.getUpdates(42, 25)
    expect(calls[0]?.body?.offset).toBe(42)
  })
})

describe('TelegramApi — html messages', () => {
  it('sends text with parse_mode HTML', async () => {
    const { api, calls } = apiWith([{ ok: true, result: { message_id: 7 } }])
    await api.sendMessage({ chatId: '1', html: '<b>hi</b>' })
    expect(calls[0]?.body?.parse_mode).toBe('HTML')
    expect(calls[0]?.body?.text).toBe('<b>hi</b>')
  })

  it('returns the new message id', async () => {
    const { api } = apiWith([{ ok: true, result: { message_id: 7 } }])
    await expect(api.sendMessage({ chatId: '1', html: 'hi' })).resolves.toEqual({ messageId: 7 })
  })

  it('attaches an inline keyboard when buttons are given', async () => {
    const { api, calls } = apiWith([{ ok: true, result: { message_id: 7 } }])
    await api.sendMessage({
      chatId: '1',
      html: 'pick',
      keyboard: [[{ text: 'Yes', callbackData: 'a' }]],
    })
    expect(calls[0]?.body?.reply_markup).toEqual({
      inline_keyboard: [[{ text: 'Yes', callback_data: 'a' }]],
    })
  })

  it('sends rich markdown, which Telegram parses itself', async () => {
    const { api, calls } = apiWith([{ ok: true, result: { message_id: 7 } }])
    await api.sendRichMessage({ chatId: '1', markdown: '| a | b |\n| - | - |\n| 1 | 2 |' })

    expect(calls[0]?.url).toContain('/sendRichMessage')
    expect(calls[0]?.body?.rich_message).toEqual({
      markdown: '| a | b |\n| - | - |\n| 1 | 2 |',
    })
  })

  it('streams a draft under a stable id, which Telegram animates', async () => {
    const { api, calls } = apiWith([{ ok: true, result: true }])
    await api.sendRichMessageDraft({ chatId: '1', draftId: 42, markdown: 'partial' })

    expect(calls[0]?.url).toContain('/sendRichMessageDraft')
    expect(calls[0]?.body?.draft_id).toBe(42)
    expect(calls[0]?.body?.rich_message).toEqual({ markdown: 'partial' })
  })

  it('replaces a message with rich markdown', async () => {
    const { api, calls } = apiWith([{ ok: true, result: { message_id: 2 } }])
    await api.editRichMessage({ chatId: '1', messageId: 2, markdown: '# done' })

    expect(calls[0]?.url).toContain('/editMessageText')
    expect(calls[0]?.body?.rich_message).toEqual({ markdown: '# done' })
  })

  it('reports an unchanged rich edit rather than throwing', async () => {
    const { api } = apiWith([
      { status: 400, ok: false, error_code: 400, description: 'Bad Request: message is not modified' },
    ])
    await expect(
      api.editRichMessage({ chatId: '1', messageId: 2, markdown: 'same' }),
    ).resolves.toBe('unchanged')
  })
})

describe('TelegramApi — editing', () => {
  it('reports an unchanged edit as not-modified instead of throwing', async () => {
    const { api } = apiWith([
      {
        status: 400,
        ok: false,
        error_code: 400,
        description: 'Bad Request: message is not modified',
      },
    ])
    await expect(api.editMessageText({ chatId: '1', messageId: 2, html: 'same' })).resolves.toBe(
      'unchanged',
    )
  })

  it('reports a successful edit', async () => {
    const { api } = apiWith([{ ok: true, result: { message_id: 2 } }])
    await expect(api.editMessageText({ chatId: '1', messageId: 2, html: 'new' })).resolves.toBe(
      'edited',
    )
  })

  it('clears a keyboard by sending an empty markup', async () => {
    const { api, calls } = apiWith([{ ok: true, result: true }])
    await api.editMessageReplyMarkup({ chatId: '1', messageId: 2, keyboard: [] })
    expect(calls[0]?.body?.reply_markup).toEqual({ inline_keyboard: [] })
  })
})

describe('TelegramApi — resilience', () => {
  it('waits out a 429 and retries', async () => {
    const sleep = vi.fn(async () => undefined)
    const calls: Call[] = []
    const queue: unknown[] = [
      { status: 429, ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 3 } },
      { ok: true, result: { message_id: 9 } },
    ]
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body as string) : undefined })
      const next = queue.shift()
      const status = (next as { status?: number }).status ?? 200
      return { ok: status < 400, status, text: async () => JSON.stringify(next) } as unknown as Response
    }) as unknown as typeof fetch

    const api = new TelegramApi({ token: TOKEN, baseUrl: 'https://api.telegram.org', timeoutMs: 1000, fetchImpl, sleep })
    await expect(api.sendMessage({ chatId: '1', html: 'hi' })).resolves.toEqual({ messageId: 9 })
    expect(sleep).toHaveBeenCalledWith(3000, undefined)
    expect(calls).toHaveLength(2)
  })

  it('throws an auth error for a rejected token', async () => {
    const { api } = apiWith([
      { status: 401, ok: false, error_code: 401, description: 'Unauthorized' },
    ])
    await expect(api.getMe()).rejects.toThrow(TelegramApiError)
  })

  it('redacts the description too, not only the message', async () => {
    // `description` is read straight into a log line on an auth failure, so a
    // field that skips redaction only has to be wrong once.
    const { api } = apiWith([
      { status: 400, ok: false, error_code: 400, description: `Bad Request: bot${TOKEN} is unknown` },
    ])
    const error = (await api.getMe().catch((e: unknown) => e)) as TelegramApiError

    expect(error.description).not.toContain(TOKEN)
    expect(error.description).toContain('<redacted>')
    expect(error.message).not.toContain(TOKEN)
  })

  it('redacts the token when a network error quotes the request url', async () => {
    // undici puts the full url in its error message, which is the real leak path.
    const fetchImpl = (async (url: string) => {
      throw new Error(`connect ECONNREFUSED for ${url}`)
    }) as unknown as typeof fetch
    const api = new TelegramApi({ token: TOKEN, baseUrl: 'https://api.telegram.org', timeoutMs: 10, fetchImpl, sleep: async () => undefined })
    const error = await api.getMe().catch((e: unknown) => e)
    expect(String(error)).not.toContain(TOKEN)
    expect(String(error)).toContain('<redacted>')
  })
})

describe('TelegramApi — transport failures', () => {
  /** An api whose fetch fails a given number of times, then succeeds. */
  function flaky(failures: number, cause?: unknown) {
    let attempts = 0
    const fetchImpl = (async () => {
      attempts += 1
      if (attempts <= failures) {
        const error = new Error('fetch failed')
        if (cause !== undefined) (error as { cause?: unknown }).cause = cause
        throw error
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, result: { file_id: 'f', file_path: 'a.jpg' } }),
      } as unknown as Response
    }) as unknown as typeof fetch

    const api = new TelegramApi({
      token: TOKEN,
      baseUrl: 'https://api.telegram.org',
      timeoutMs: 1000,
      fetchImpl,
      sleep: async () => undefined,
    })
    return { api, attempts: () => attempts }
  }

  it('retries a read whose connection failed', async () => {
    // getFile runs while the long poll holds its own connection, so it is the
    // call most likely to need a fresh one — and a single flaky connect was
    // turning a sent screenshot into an error.
    const { api, attempts } = flaky(1)
    // getFile returns the Bot API shape verbatim, which is what MediaCollector reads.
    await expect(api.getFile('abc')).resolves.toMatchObject({ file_path: 'a.jpg' })
    expect(attempts()).toBe(2)
  })

  it('gives up once the retries are spent', async () => {
    const { api } = flaky(99)
    await expect(api.getFile('abc')).rejects.toThrow(/fetch failed/)
  })

  it('never repeats a send, which could post the same message twice', async () => {
    const { api, attempts } = flaky(1)
    await expect(api.sendMessage({ chatId: '1', html: 'hi' })).rejects.toThrow()
    expect(attempts()).toBe(1)
  })

  it('reports what actually failed, not just that fetch did', async () => {
    // Node reports every transport failure as the same three words and puts
    // the reason in `cause`; keeping only the top layer says nothing.
    const cause = Object.assign(new Error('connect ECONNREFUSED 149.154.167.220:443'), {
      code: 'ECONNREFUSED',
    })
    const { api } = flaky(99, cause)

    const error = await api.getFile('abc').catch((e: unknown) => e)
    expect(String(error)).toContain('ECONNREFUSED')
  })

  it('still redacts the token when the cause quotes the url', async () => {
    const cause = new Error(`connect failed for https://api.telegram.org/bot${TOKEN}/getFile`)
    const { api } = flaky(99, cause)

    const error = await api.getFile('abc').catch((e: unknown) => e)
    expect(String(error)).not.toContain(TOKEN)
    expect(String(error)).toContain('<redacted>')
  })
})

describe('TelegramApi — downloading a file', () => {
  /** A download that fails a given number of times, then returns bytes. */
  function flakyDownload(failures: number) {
    let attempts = 0
    const fetchImpl = (async () => {
      attempts += 1
      if (attempts <= failures) {
        throw Object.assign(new Error('fetch failed'), {
          cause: Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }),
        })
      }
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      } as unknown as Response
    }) as unknown as typeof fetch

    const api = new TelegramApi({
      token: TOKEN,
      baseUrl: 'https://api.telegram.org',
      timeoutMs: 1000,
      fetchImpl,
      sleep: async () => undefined,
    })
    return { api, attempts: () => attempts }
  }

  it('retries a timed-out download, which is a pure read', async () => {
    const { api, attempts } = flakyDownload(1)
    await expect(api.downloadFile('photos/a.jpg')).resolves.toEqual(new Uint8Array([1, 2, 3]))
    expect(attempts()).toBe(2)
  })

  it('names the timeout rather than only saying fetch failed', async () => {
    const { api } = flakyDownload(99)
    const error = await api.downloadFile('photos/a.jpg').catch((e: unknown) => e)
    expect(String(error)).toContain('ETIMEDOUT')
  })

  it('carries its own deadline, rather than waiting on the operating system', async () => {
    let signalled: AbortSignal | undefined
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      signalled = init.signal as AbortSignal
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array().buffer } as unknown as Response
    }) as unknown as typeof fetch

    const api = new TelegramApi({
      token: TOKEN,
      baseUrl: 'https://api.telegram.org',
      timeoutMs: 1000,
      fetchImpl,
      sleep: async () => undefined,
    })

    await api.downloadFile('a.jpg')
    expect(signalled).toBeInstanceOf(AbortSignal)
  })

  it('gives up on a refused download rather than repeating a definite answer', async () => {
    let attempts = 0
    const fetchImpl = (async () => {
      attempts += 1
      return { ok: false, status: 404 } as unknown as Response
    }) as unknown as typeof fetch

    const api = new TelegramApi({
      token: TOKEN,
      baseUrl: 'https://api.telegram.org',
      timeoutMs: 1000,
      fetchImpl,
      sleep: async () => undefined,
    })

    await expect(api.downloadFile('gone.jpg')).rejects.toThrow(/404/)
    expect(attempts).toBe(1)
  })
})
