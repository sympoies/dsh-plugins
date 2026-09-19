import { describe, expect, it } from 'vitest'

import { COMMANDS, commandMenu, helpText, parseCommand } from '../src/commands.js'
import { TextCapture } from '../src/interact/text-capture.js'

describe('parseCommand', () => {
  it('parses a bare command', () => {
    expect(parseCommand('/new')).toEqual({ name: 'new', args: '' })
  })

  it('parses a command with arguments', () => {
    expect(parseCommand('/claim abc123')).toEqual({ name: 'claim', args: 'abc123' })
  })

  it('keeps multi-word arguments together', () => {
    expect(parseCommand('/claim  a b  c ')).toEqual({ name: 'claim', args: 'a b  c' })
  })

  it('lowercases the command name', () => {
    expect(parseCommand('/NEW')).toEqual({ name: 'new', args: '' })
  })

  it('accepts a command addressed to this bot', () => {
    expect(parseCommand('/new@my_bot', 'my_bot')).toEqual({ name: 'new', args: '' })
  })

  it('ignores a command addressed to a different bot in the same group', () => {
    expect(parseCommand('/new@other_bot', 'my_bot')).toBeUndefined()
  })

  it('matches the bot suffix case-insensitively', () => {
    expect(parseCommand('/new@My_Bot', 'my_bot')).toEqual({ name: 'new', args: '' })
  })

  it('ignores an unknown command, leaving it as a prompt', () => {
    expect(parseCommand('/deploy')).toBeUndefined()
  })

  it('ignores ordinary text', () => {
    expect(parseCommand('what is 2 + 2?')).toBeUndefined()
  })

  it('ignores a slash inside a sentence', () => {
    expect(parseCommand('read src/index.ts /new stuff')).toBeUndefined()
  })

  it('ignores an empty message', () => {
    expect(parseCommand('')).toBeUndefined()
  })
})

describe('helpText', () => {
  it('lists every command', () => {
    const help = helpText()
    expect(help).toContain('/new')
    expect(help).toContain('/status')
    expect(help).toContain('/claim')
  })

  it('escapes the descriptions, which are prose and not markup', () => {
    // This is what broke /help: the claim description ends in "/claim <code>",
    // and Telegram read that as an unclosed <code> tag and refused the WHOLE
    // message with a 400. The command answered with silence.
    const help = helpText()
    expect(help).toContain('&lt;code&gt;')
    expect(help).not.toContain('<code>')
  })

  it('leaves only tags it opened and closed itself', () => {
    // The general form of the same bug: any tag in the body that this function
    // did not balance makes Telegram reject the message.
    const tags = [...helpText().matchAll(/<\/?([a-z]+)[^>]*>/g)].map((match) => match[1])
    expect(tags).toEqual(['b', 'b'])
  })

  it('stays sendable however a description is worded later', () => {
    // Every description goes through the same escape, so a future one carrying
    // markup cannot repeat this.
    for (const description of Object.values(COMMANDS)) {
      const escaped = helpText()
      if (description.includes('<')) expect(escaped).not.toContain(description)
    }
  })
})

describe('commandMenu', () => {
  it('offers every command while the bot is still unclaimed', () => {
    const names = commandMenu(true).map((entry) => entry.command)
    expect(names).toEqual(Object.keys(COMMANDS))
  })

  it('drops /claim once the bot has an owner', () => {
    // It is the one command that stops working the moment it succeeds, and
    // offering it forever invites everyone to try a code that cannot be right.
    expect(commandMenu(false).map((entry) => entry.command)).not.toContain('claim')
  })

  it('describes each one, since the menu is the description', () => {
    for (const entry of commandMenu(true)) {
      expect(entry.description.length).toBeGreaterThan(0)
      expect(entry.description.length).toBeLessThanOrEqual(256)
    }
  })

  it('uses names Telegram accepts', () => {
    // Telegram takes lowercase letters, digits and underscores, 1-32 chars.
    for (const entry of commandMenu(true)) expect(entry.command).toMatch(/^[a-z0-9_]{1,32}$/)
  })
})

describe('TextCapture', () => {
  const chat = { chatId: '1' }

  it('reports that nothing is waiting by default', () => {
    expect(new TextCapture().isWaiting(chat)).toBe(false)
  })

  it('hands the next message to a waiting prompt', async () => {
    const capture = new TextCapture()
    const waited = capture.next(chat)
    expect(capture.deliver(chat, 'my answer')).toBe(true)
    await expect(waited).resolves.toBe('my answer')
  })

  it('reports no consumer when nothing is waiting', () => {
    expect(new TextCapture().deliver(chat, 'stray')).toBe(false)
  })

  it('does not let one chat consume another chat\'s message', async () => {
    const capture = new TextCapture()
    capture.next(chat)
    expect(capture.deliver({ chatId: '2' }, 'wrong chat')).toBe(false)
  })

  it('treats a forum topic as its own conversation', () => {
    const capture = new TextCapture()
    capture.next({ chatId: '1', threadId: 5 })
    expect(capture.deliver({ chatId: '1' }, 'general')).toBe(false)
    expect(capture.deliver({ chatId: '1', threadId: 5 }, 'topic')).toBe(true)
  })

  it('cancels a wait when its signal aborts', async () => {
    const capture = new TextCapture()
    const controller = new AbortController()
    const waited = capture.next(chat, controller.signal)
    controller.abort()
    await expect(waited).resolves.toBeUndefined()
  })

  it('supersedes an earlier wait on the same chat', async () => {
    const capture = new TextCapture()
    const first = capture.next(chat)
    const second = capture.next(chat)

    await expect(first).resolves.toBeUndefined()
    capture.deliver(chat, 'answer')
    await expect(second).resolves.toBe('answer')
  })

  it('cancels every wait on dispose', async () => {
    const capture = new TextCapture()
    const waited = capture.next(chat)
    capture.dispose()
    await expect(waited).resolves.toBeUndefined()
  })
})
