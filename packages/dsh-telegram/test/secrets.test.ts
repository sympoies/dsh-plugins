import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { SecretRegistry } from '../src/secrets.js'
import { StatusFile } from '../src/diagnostics.js'
import { TelegramApi } from '../src/telegram/api.js'

const TOKEN = '123456:AAHf9-SECRET-BOT-TOKEN-VALUE-abcdefgh'

describe('SecretRegistry', () => {
  it('strips a registered secret', () => {
    const secrets = new SecretRegistry()
    secrets.protect(TOKEN)
    expect(secrets.redact(`failed at https://api.telegram.org/bot${TOKEN}/getMe`)).toBe(
      'failed at https://api.telegram.org/bot<redacted>/getMe',
    )
  })

  it('strips every occurrence, not just the first', () => {
    const secrets = new SecretRegistry()
    secrets.protect(TOKEN)
    const redacted = secrets.redact(`${TOKEN} and again ${TOKEN}`)
    expect(redacted).not.toContain(TOKEN)
    expect(redacted).toBe('<redacted> and again <redacted>')
  })

  it('strips more than one secret', () => {
    const secrets = new SecretRegistry()
    secrets.protect(TOKEN)
    secrets.protect('another-long-secret-value')
    expect(secrets.redact(`${TOKEN} / another-long-secret-value`)).toBe(
      '<redacted> / <redacted>',
    )
  })

  it('leaves text alone when nothing is registered', () => {
    expect(new SecretRegistry().redact('nothing to hide')).toBe('nothing to hide')
  })

  it('refuses the empty string, which would mark every character', () => {
    const secrets = new SecretRegistry()
    secrets.protect('')
    expect(secrets.redact('hello')).toBe('hello')
  })

  it('refuses a secret too short to strip without mangling ordinary text', () => {
    const secrets = new SecretRegistry()
    secrets.protect('abc')
    expect(secrets.redact('abc is part of many words')).toBe('abc is part of many words')
  })

  it('ignores an absent secret', () => {
    const secrets = new SecretRegistry()
    secrets.protect(undefined)
    expect(secrets.redact('unchanged')).toBe('unchanged')
  })

  it('hands out a bound redactor for modules that should not hold it', () => {
    const secrets = new SecretRegistry()
    secrets.protect(TOKEN)
    const redact = secrets.redactor()
    expect(redact(TOKEN)).toBe('<redacted>')
  })

  it('applies a secret registered after the redactor was handed out', () => {
    // The token is only known once resolved, after the redactor has already
    // been passed to the status file.
    const secrets = new SecretRegistry()
    const redact = secrets.redactor()
    secrets.protect(TOKEN)
    expect(redact(TOKEN)).toBe('<redacted>')
  })
})

describe('StatusFile — what reaches disk', () => {
  it('redacts the detail it writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-telegram-status-'))
    const file = join(dir, 'status.json')

    const secrets = new SecretRegistry()
    secrets.protect(TOKEN)
    await new StatusFile(file, secrets.redactor()).publish('failed', {
      detail: `connect failed for https://api.telegram.org/bot${TOKEN}/getMe`,
    })

    const written = await readFile(file, 'utf8')
    expect(written).not.toContain(TOKEN)
    expect(written).toContain('<redacted>')
  })

  it('never breaks the plugin when it cannot write', async () => {
    const impossible = join(tmpdir(), 'dsh-telegram-nope', '\0', 'status.json')
    await expect(new StatusFile(impossible).publish('connected')).resolves.toBeUndefined()
  })
})

describe('TelegramApi — the download path', () => {
  it('redacts the token when the transport quotes the download url', async () => {
    // undici puts the url in its error, and the file url carries the token in
    // its path — the one fetch in this client that was not wrapped.
    const fetchImpl = (async (url: string) => {
      throw new Error(`connect ECONNREFUSED for ${url}`)
    }) as unknown as typeof fetch

    const api = new TelegramApi({
      token: TOKEN,
      baseUrl: 'https://api.telegram.org',
      timeoutMs: 10,
      fetchImpl,
      sleep: async () => undefined,
    })

    const error = await api.downloadFile('photos/file_1.jpg').catch((e: unknown) => e)
    expect(String(error)).not.toContain(TOKEN)
    expect(String(error)).toContain('<redacted>')
  })

  it('still reports a refused download by status', async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 404 }) as unknown as Response) as unknown as typeof fetch

    const api = new TelegramApi({
      token: TOKEN,
      baseUrl: 'https://api.telegram.org',
      timeoutMs: 10,
      fetchImpl,
      sleep: async () => undefined,
    })

    await expect(api.downloadFile('gone.jpg')).rejects.toThrow(/404/)
  })
})
