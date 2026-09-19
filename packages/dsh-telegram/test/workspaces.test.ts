import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import { isUsableDirectory, resolveDirectory } from '../src/session/workspaces.js'
import { ChatPreferences } from '../src/session/preferences.js'

const CHAT = { chatId: '1' }
const HOME = '/Users/adam'

describe('resolveDirectory — the spellings people actually type', () => {
  it('takes an absolute path as it is', () => {
    expect(resolveDirectory('/srv/app', '/work', HOME)).toBe('/srv/app')
  })

  it('expands a bare tilde to home', () => {
    expect(resolveDirectory('~', '/work', HOME)).toBe(HOME)
  })

  it('expands a tilde path', () => {
    expect(resolveDirectory('~/projects/app', '/work', HOME)).toBe('/Users/adam/projects/app')
  })

  it('resolves a relative path against where the conversation is', () => {
    expect(resolveDirectory('app', '/work', HOME)).toBe('/work/app')
  })

  it('handles going up, which is how anyone leaves a subdirectory', () => {
    expect(resolveDirectory('..', '/work/app', HOME)).toBe('/work')
  })

  it('normalizes a path that walks around', () => {
    expect(resolveDirectory('/work/app/../lib', '/', HOME)).toBe('/work/lib')
  })

  it('strips quotes, which a shell would have eaten', () => {
    // Paths get pasted from a terminal, quotes and all.
    expect(resolveDirectory('"/work/my app"', '/', HOME)).toBe('/work/my app')
    expect(resolveDirectory("'/work/my app'", '/', HOME)).toBe('/work/my app')
  })

  it('keeps a quote that is part of the name', () => {
    expect(resolveDirectory('/work/it\'s', '/', HOME)).toBe("/work/it's")
  })

  it('ignores surrounding whitespace', () => {
    expect(resolveDirectory('  /srv/app  ', '/work', HOME)).toBe('/srv/app')
  })

  it('answers nothing for empty input, which means "where am I"', () => {
    expect(resolveDirectory('', '/work', HOME)).toBeUndefined()
    expect(resolveDirectory('   ', '/work', HOME)).toBeUndefined()
  })

  it('does not guess at another account\'s home', () => {
    // Resolving `~someone` needs the password database, and guessing wrong
    // would silently open a directory the user did not name.
    expect(resolveDirectory('~root', '/work', HOME)).toBe('/work/~root')
  })
})

describe('ChatPreferences — as the directory store', () => {
  let file: string

  beforeEach(async () => {
    file = join(await mkdtemp(join(tmpdir(), 'dsh-telegram-ws-')), 'workspaces.json')
  })

  it('starts empty, so every chat uses the configured default', async () => {
    const store = await ChatPreferences.open(file, { accept: isUsableDirectory })
    expect(store.forChat(CHAT)).toBeUndefined()
  })

  it('remembers a directory', async () => {
    const store = await ChatPreferences.open(file, { accept: isUsableDirectory })
    await store.set(CHAT, '/work/app')
    expect(store.forChat(CHAT)).toBe('/work/app')
  })

  it('survives a restart, which is the whole reason it is a file', async () => {
    const first = await ChatPreferences.open(file, { accept: isUsableDirectory })
    await first.set(CHAT, '/work/app')

    const second = await ChatPreferences.open(file, { accept: isUsableDirectory })
    expect(second.forChat(CHAT)).toBe('/work/app')
  })

  it('keeps conversations apart', async () => {
    const store = await ChatPreferences.open(file, { accept: isUsableDirectory })
    await store.set(CHAT, '/work/app')
    await store.set({ chatId: '2' }, '/work/other')

    expect(store.forChat(CHAT)).toBe('/work/app')
    expect(store.forChat({ chatId: '2' })).toBe('/work/other')
  })

  it('treats a forum topic as its own conversation', async () => {
    const store = await ChatPreferences.open(file, { accept: isUsableDirectory })
    await store.set({ chatId: '1', threadId: 7 }, '/work/topic')

    expect(store.forChat({ chatId: '1', threadId: 7 })).toBe('/work/topic')
    expect(store.forChat(CHAT)).toBeUndefined()
  })

  it('returns a conversation to the default when cleared', async () => {
    const store = await ChatPreferences.open(file, { accept: isUsableDirectory })
    await store.set(CHAT, '/work/app')
    await store.clear(CHAT)
    expect(store.forChat(CHAT)).toBeUndefined()
  })

  it('starts empty rather than refusing to open on a corrupt file', async () => {
    // Losing the directories costs one `/cd`; refusing to start costs the bot.
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, '{ not json', 'utf8')

    const store = await ChatPreferences.open(file, { accept: isUsableDirectory })
    expect(store.forChat(CHAT)).toBeUndefined()
  })

  it('drops a relative path from the document', async () => {
    // It would resolve against whatever the process happens to run in, which
    // is not the directory the user chose.
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, JSON.stringify({ '1': 'work/app', '2': '/work/ok' }), 'utf8')

    const store = await ChatPreferences.open(file, { accept: isUsableDirectory })
    expect(store.forChat(CHAT)).toBeUndefined()
    expect(store.forChat({ chatId: '2' })).toBe('/work/ok')
  })
})
