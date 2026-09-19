import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import { BindingStore } from '../src/session/bindings.js'

let file: string

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-telegram-'))
  file = join(dir, 'bindings.json')
})

describe('BindingStore — binding a chat to a session', () => {
  it('starts with nothing bound', async () => {
    const store = await BindingStore.open(file)
    expect(store.forChat({ chatId: '1' })).toBeUndefined()
  })

  it('remembers the session bound to a chat', async () => {
    const store = await BindingStore.open(file)
    await store.bind({ chatId: '1' }, 'session-a')
    expect(store.forChat({ chatId: '1' })?.sessionId).toBe('session-a')
  })

  it('looks a chat up from its session, which is how prompts find their way back', async () => {
    const store = await BindingStore.open(file)
    await store.bind({ chatId: '1', threadId: 7 }, 'session-a')
    expect(store.forSession('session-a')).toEqual({ chatId: '1', threadId: 7 })
  })

  it('treats two topics of one group as separate conversations', async () => {
    const store = await BindingStore.open(file)
    await store.bind({ chatId: '1', threadId: 7 }, 'session-a')
    await store.bind({ chatId: '1', threadId: 8 }, 'session-b')

    expect(store.forChat({ chatId: '1', threadId: 7 })?.sessionId).toBe('session-a')
    expect(store.forChat({ chatId: '1', threadId: 8 })?.sessionId).toBe('session-b')
  })

  it('replaces a chat binding when the conversation is restarted', async () => {
    const store = await BindingStore.open(file)
    await store.bind({ chatId: '1' }, 'old')
    await store.bind({ chatId: '1' }, 'new')

    expect(store.forChat({ chatId: '1' })?.sessionId).toBe('new')
    expect(store.forSession('old')).toBeUndefined()
  })

  it('forgets a binding on request', async () => {
    const store = await BindingStore.open(file)
    await store.bind({ chatId: '1' }, 'session-a')
    await store.unbind({ chatId: '1' })

    expect(store.forChat({ chatId: '1' })).toBeUndefined()
    expect(store.forSession('session-a')).toBeUndefined()
  })
})

describe('BindingStore — persistence', () => {
  it('survives a restart', async () => {
    const first = await BindingStore.open(file)
    await first.bind({ chatId: '1' }, 'session-a')

    const second = await BindingStore.open(file)
    expect(second.forChat({ chatId: '1' })?.sessionId).toBe('session-a')
  })

  it('writes readable json', async () => {
    const store = await BindingStore.open(file)
    await store.bind({ chatId: '1' }, 'session-a')

    const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    expect(Object.keys(parsed)).toEqual(['1'])
  })

  it('starts clean rather than crashing on a corrupt file', async () => {
    await writeFile(file, 'this is not json', 'utf8')
    const store = await BindingStore.open(file)
    expect(store.forChat({ chatId: '1' })).toBeUndefined()
  })

  it('drops entries that do not match the expected shape', async () => {
    await writeFile(file, JSON.stringify({ '1': { nonsense: true }, '2': { chatId: '2', sessionId: 'ok' } }), 'utf8')
    const store = await BindingStore.open(file)

    expect(store.forChat({ chatId: '1' })).toBeUndefined()
    expect(store.forChat({ chatId: '2' })?.sessionId).toBe('ok')
  })

  it('creates the directory it is asked to write into', async () => {
    const nested = join(tmpdir(), `dsh-telegram-${Date.now()}`, 'deep', 'bindings.json')
    const store = await BindingStore.open(nested)
    await expect(store.bind({ chatId: '1' }, 'session-a')).resolves.toBeUndefined()
  })

  it('lists every binding, for a status command', async () => {
    const store = await BindingStore.open(file)
    await store.bind({ chatId: '1' }, 'a')
    await store.bind({ chatId: '2' }, 'b')
    expect(store.list()).toHaveLength(2)
  })
})

describe('BindingStore — remembering that a session carries an image', () => {
  it('starts unmarked', async () => {
    const store = await BindingStore.open(file)
    await store.bind({ chatId: '1' }, 'session-a')
    expect(store.forChat({ chatId: '1' })?.hasImages).toBeUndefined()
  })

  it('marks a conversation once an image has gone through', async () => {
    const store = await BindingStore.open(file)
    await store.bind({ chatId: '1' }, 'session-a')
    await store.markImages({ chatId: '1' })

    expect(store.forChat({ chatId: '1' })?.hasImages).toBe(true)
  })

  it('remembers across a restart, since the session log does', async () => {
    const first = await BindingStore.open(file)
    await first.bind({ chatId: '1' }, 'session-a')
    await first.markImages({ chatId: '1' })

    const second = await BindingStore.open(file)
    expect(second.forChat({ chatId: '1' })?.hasImages).toBe(true)
  })

  it('clears the mark when the conversation is restarted', async () => {
    const store = await BindingStore.open(file)
    await store.bind({ chatId: '1' }, 'session-a')
    await store.markImages({ chatId: '1' })

    await store.bind({ chatId: '1' }, 'session-b')
    expect(store.forChat({ chatId: '1' })?.hasImages).toBeUndefined()
  })

  it('does nothing for a conversation with no binding', async () => {
    const store = await BindingStore.open(file)
    await expect(store.markImages({ chatId: '404' })).resolves.toBeUndefined()
  })

  it('marks only the conversation it was told about', async () => {
    const store = await BindingStore.open(file)
    await store.bind({ chatId: '1' }, 'a')
    await store.bind({ chatId: '2' }, 'b')
    await store.markImages({ chatId: '1' })

    expect(store.forChat({ chatId: '2' })?.hasImages).toBeUndefined()
  })
})
