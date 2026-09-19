import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { AccessPolicy } from '../src/access.js'
import { TextCapture } from '../src/interact/text-capture.js'
import { UpdateRouter } from '../src/router.js'
import { resolveDirectory } from '../src/session/workspaces.js'
import type { AgentRunner } from '../src/router.js'
import type { TelegramUpdate } from '../src/telegram/types.js'

const OWNER = 7
const STRANGER = 99

/** A router wired to spies, with a real access policy in a temp directory. */
async function build(
  options: {
    allowFrom?: number[]
    media?: unknown
    /** Omit to run without an indicator at all, as a bare deployment does. */
    typing?: boolean
    /** What `inspect` reports for whatever path /cd resolves to. */
    at?: 'directory' | 'file' | 'missing' | 'denied'
    /** Set false to run without the workspace seam, as a bare deployment does. */
    workspace?: boolean
    /** Set false to answer every group message, the older behaviour. */
    requireAddressing?: boolean
    /** Set false to run without a model catalog, as a bare deployment does. */
    models?: boolean
    /** Set false to run without the effort seam. */
    effort?: boolean
    /** Efforts the current model offers; empty means it offers no choice. */
    efforts?: string[]
    /** Set false to run without the permission seam. */
    permission?: boolean
    /** Set false to run without the vision seam. */
    vision?: boolean
    /** Set false to run below Bot API 10.1, where a table is just pipes. */
    richMessages?: boolean
    /** Set false to run without diagnostics. */
    diagnostics?: boolean
    /** Seams to report as composed; the rest report as absent. */
    seams?: string[]
    /** Failures to report. */
    failures?: { at: string; level: string; message: string }[]
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-telegram-router-'))
  const access = await AccessPolicy.open(join(dir, 'owner.json'), {
    allowFrom: options.allowFrom ?? [OWNER],
    claimCode: 'the-code',
  })

  const said: string[] = []
  const answered: string[] = []
  const runner: AgentRunner = {
    prompt: vi.fn(async () => undefined),
    reset: vi.fn(async () => undefined),
    stop: vi.fn(async () => true),
    status: vi.fn(async () => [
      { label: 'Session', value: 'ch-1' },
      { label: 'Directory', value: '/tmp' },
    ]),
  }
  const questions = { handleCallback: vi.fn(() => false) }
  const approvals = { handleCallback: vi.fn(() => false) }
  const textCapture = new TextCapture()

  /** Every hold taken on the indicator, and whether it has been let go. */
  const holds: { chatId: string; released: boolean }[] = []
  const typing = {
    hold(target: { chatId: string }) {
      const entry = { chatId: target.chatId, released: false }
      holds.push(entry)
      return () => void (entry.released = true)
    },
  }

  /** The conversation's directory, and every /cd that moved it. */
  let directory = '/work'
  const moved: string[] = []
  const workspace = {
    current: () => directory,
    resolve: (input: string, current: string) =>
      resolveDirectory(input, current, '/Users/adam'),
    inspect: async () => options.at ?? 'directory',
    set: async (_target: { chatId: string }, next: string) => {
      moved.push(next)
      directory = next
    },
  }

  /** The conversation's model, and every /model that changed it. */
  let model: string | undefined
  const models = {
    describe: () => model ?? 'the deployment default',
    origin: () =>
      model === undefined ? undefined : 'this chat; the deployment default is deepseek/flash',
    list: async () => '<b>DeepSeek</b>\n• <code>deepseek-official/deepseek-v4-pro</code>',
    choose: async (_target: { chatId: string }, input: string) => {
      if (input === 'ambiguous') return { kind: 'ambiguous' as const, candidates: ['a/m', 'b/m'] }
      if (!input.includes('/')) return { kind: 'unknown' as const }
      model = input
      return { kind: 'route' as const, route: input }
    },
    clear: async () => void (model = undefined),
  }

  /** The conversation's reasoning effort. */
  let effort: string | undefined
  const offered = options.efforts ?? ['low', 'medium', 'high']
  const effortSeam = {
    describe: () => effort ?? "the model's own default",
    model: () => 'xiaomi/mimo-v2.5',
    options: async () => offered,
    choose: async (_target: { chatId: string }, input: string) => {
      if (!offered.includes(input)) return undefined
      effort = input
      return input
    },
    clear: async () => void (effort = undefined),
  }

  /** What the agent may do here. */
  let preset: string | undefined
  const permissionSeam = {
    describe: () => preset ?? 'the deployment default',
    options: () => ['read-only', 'workspace-write', 'danger-full-access'],
    choose: async (_target: { chatId: string }, input: string) => {
      const matched = ['read-only', 'workspace-write', 'danger-full-access'].find((name) =>
        name.replace(/-/g, '').includes(input.replace(/[\s_-]/g, '').toLowerCase()),
      )
      if (matched === undefined) return undefined
      preset = matched
      return matched
    },
    clear: async () => void (preset = undefined),
  }

  /** Which model reads images here: a route, 'off', or nothing chosen. */
  let reader: string | undefined
  const visionSeam = {
    describe: () =>
      reader === 'off' ? 'nothing — the conversation itself' : (reader ?? 'nothing configured'),
    origin: () =>
      reader === undefined ? undefined : 'this chat; the deployment default is xiaomi/mimo-v2.5',
    choose: async (_target: { chatId: string }, input: string) => {
      if (input === 'ambiguous') return { kind: 'ambiguous' as const, candidates: ['a/m', 'b/m'] }
      if (!input.includes('/')) return { kind: 'unknown' as const }
      reader = input
      return { kind: 'route' as const, route: input }
    },
    disable: async () => void (reader = 'off'),
    clear: async () => void (reader = undefined),
  }

  const router = new UpdateRouter({
    chat: {
      sendMessage: async ({ html }) => void said.push(html),
      answerCallbackQuery: async (id) => void answered.push(id),
      ...(options.richMessages === false
        ? {}
        : {
            // Reads `this` on purpose. The real client's does, and a fake that
            // did not let a detached call — which loses `this` and throws —
            // pass every test while /status silently fell back to lines.
            sendRichMessage(this: { rich: string[] }, { markdown }: { markdown: string }) {
              this.rich.push(markdown)
              said.push(markdown)
              return Promise.resolve({ messageId: said.length })
            },
            rich: [] as string[],
          }),
    },
    access,
    questions,
    approvals,
    ...(options.typing === false ? {} : { typing }),
    ...(options.workspace === false ? {} : { workspace }),
    ...(options.models === false ? {} : { models }),
    ...(options.diagnostics === false
      ? {}
      : {
          diagnostics: {
            report: async () => ({
              status: [{ label: 'Bot', value: '@my_bot' }],
              seams: ['agents', 'agentPresets', 'llm'].map((name) => ({
                name,
                present: (options.seams ?? ['agents', 'llm']).includes(name),
              })),
              failures: options.failures ?? [],
            }),
          },
        }),
    ...(options.effort === false ? {} : { effort: effortSeam }),
    ...(options.permission === false ? {} : { permission: permissionSeam }),
    ...(options.vision === false ? {} : { vision: visionSeam }),
    textCapture,
    runner,
    botUsername: 'my_bot',
    botId: 4242,
    requireAddressing: options.requireAddressing !== false,
    ...(options.media ? { media: options.media as never } : {}),
    albumWindowMs: 20,
    redact: (text) => text.split('SECRET-TOKEN').join('<redacted>'),
  })

  return {
    router,
    said,
    answered,
    runner,
    questions,
    approvals,
    textCapture,
    access,
    holds,
    moved,
    /** Whether the chat is showing "typing…" right now. */
    typing: () => holds.some((entry) => !entry.released),
    /** Where the conversation is working now. */
    directory: () => directory,
    /** Which model it is talking to now. */
    model: () => model,
    /** How hard it is thinking. */
    effort: () => effort,
    /** What it is allowed to do. */
    preset: () => preset,
    /** What reads images here. */
    reader: () => reader,
  }
}

/** A text message update from `from`. */
function message(text: string, from = OWNER, chatId = 1): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: chatId, type: 'private' },
      from: { id: from },
      text,
    },
  }
}

describe('UpdateRouter — access', () => {
  it('sends an allowed user\'s message to the agent', async () => {
    const { router, runner } = await build()
    await router.handle(message('build the thing'))
    expect(runner.prompt).toHaveBeenCalledWith({ chatId: '1' }, [
      { type: 'text', text: 'build the thing' },
    ])
  })

  it('never lets an unauthorised message reach the agent', async () => {
    const { router, runner, said } = await build()
    await router.handle(message('rm -rf /', STRANGER))

    expect(runner.prompt).not.toHaveBeenCalled()
    expect(said[0]).toContain('not allowed')
  })

  it('refuses commands from an unauthorised user too', async () => {
    const { router, runner } = await build()
    await router.handle(message('/new', STRANGER))
    expect(runner.reset).not.toHaveBeenCalled()
  })

  it('tells an unclaimed bot\'s first visitor how to claim it', async () => {
    const { router, said } = await build({ allowFrom: [] })
    await router.handle(message('hello', STRANGER))
    expect(said[0]).toContain('/claim')
  })

  it('grants ownership for the right claim code', async () => {
    const { router, said, runner } = await build({ allowFrom: [] })
    await router.handle(message('/claim the-code', STRANGER))
    expect(said[0]).toContain('Claimed')

    await router.handle(message('now do work', STRANGER))
    expect(runner.prompt).toHaveBeenCalled()
  })

  it('refuses a wrong claim code', async () => {
    const { router, said } = await build({ allowFrom: [] })
    await router.handle(message('/claim wrong', STRANGER))
    expect(said[0]).toContain('not right')
  })
})

describe('UpdateRouter — commands', () => {
  it('starts a fresh conversation on /new', async () => {
    const { router, runner, said } = await build()
    await router.handle(message('/new'))

    expect(runner.reset).toHaveBeenCalledWith({ chatId: '1' })
    expect(said[0]).toContain('fresh conversation')
  })

  it('cancels the current turn on /stop', async () => {
    const { router, runner, said } = await build()
    await router.handle(message('/stop'))

    expect(runner.stop).toHaveBeenCalled()
    expect(said[0]).toContain('Stopped')
  })

  it('says so when /stop had nothing to cancel', async () => {
    const { router, runner, said } = await build()
    ;(runner.stop as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false)
    await router.handle(message('/stop'))
    expect(said[0]).toContain('Nothing was running')
  })

  it('reports the session on /status', async () => {
    const { router, said } = await build()
    await router.handle(message('/status'))
    expect(said[0]).toContain('ch-1')
  })

  it('calls the client as a method, so the send is not detached from it', async () => {
    // The bug this pins: `const rich = chat.sendRichMessage` loses `this`, the
    // client's own `this.call(...)` throws, and the catch turns that into a
    // silent fall back to lines — a table that never appears.
    const { router, said } = await build()
    await router.handle(message('/status'))

    expect(said[said.length - 1]).toContain('| --- | --- |')
  })

  it('draws it as a table, which Telegram renders itself since Bot API 10.1', async () => {
    const { router, said } = await build()
    await router.handle(message('/status'))

    const status = said[said.length - 1] ?? ''
    expect(status).toContain('| --- | --- |')
    expect(status).toContain('| Session | ch-1 |')
  })

  it('keeps a pipe inside its own cell, rather than shifting every column', async () => {
    // A working directory can contain one, and a router-style model id does
    // routinely.
    const { router, said, runner } = await build()
    runner.status = vi.fn(async () => [{ label: 'Model', value: 'router/a|b' }])

    await router.handle(message('/status'))
    expect(said[said.length - 1]).toContain('router/a\\|b')
  })

  it('falls back to lines below Bot API 10.1, where a table is just pipes', async () => {
    const { router, said } = await build({ richMessages: false })
    await router.handle(message('/status'))

    const status = said[said.length - 1] ?? ''
    expect(status).toContain('<b>Session</b>')
    expect(status).not.toContain('| --- |')
  })

  it('answers "what am I talking to" in one message, not four commands', async () => {
    // The permission line especially: it is the one worth being sure about
    // before asking for something destructive.
    const { router, said } = await build()
    await router.handle(message('/model xiaomi/mimo-v2.5'))
    await router.handle(message('/effort high'))
    await router.handle(message('/permission read-only'))
    await router.handle(message('/status'))

    const status = said[said.length - 1] ?? ''
    expect(status).toContain('xiaomi/mimo-v2.5')
    expect(status).toContain('high')
    expect(status).toContain('read-only')
  })

  it('lists the commands on /help', async () => {
    const { router, said } = await build()
    await router.handle(message('/help'))
    expect(said[0]).toContain('/new')
  })

  it('reports the user id on /whoami', async () => {
    const { router, said } = await build()
    await router.handle(message('/whoami'))
    expect(said[0]).toContain(String(OWNER))
  })

  it('ignores a command addressed to another bot in a group', async () => {
    const { router, runner } = await build()
    await router.handle(message('/new@other_bot'))

    expect(runner.reset).not.toHaveBeenCalled()
    expect(runner.prompt).toHaveBeenCalled()
  })

  it('treats an unknown slash word as an ordinary prompt', async () => {
    const { router, runner } = await build()
    await router.handle(message('/deploy staging'))
    expect(runner.prompt).toHaveBeenCalledWith({ chatId: '1' }, [
      { type: 'text', text: '/deploy staging' },
    ])
  })
})

/** A group message, optionally addressing the bot. */
function groupMessage(text: string, options: { mention?: boolean; replyToBot?: boolean } = {}) {
  const body = options.mention ? `@my_bot ${text}` : text
  return {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: -100200300, type: 'supergroup' },
      from: { id: OWNER },
      text: body,
      ...(options.mention
        ? { entities: [{ type: 'mention', offset: 0, length: '@my_bot'.length }] }
        : {}),
      ...(options.replyToBot ? { reply_to_message: { message_id: 9, from: { id: 4242 } } } : {}),
    },
  } as TelegramUpdate
}

describe('UpdateRouter — groups', () => {
  it('stays out of a conversation it was not part of', async () => {
    // A bot that answers every line in a room is one nobody keeps around.
    const { router, runner, said } = await build()
    await router.handle(groupMessage('did you see the deploy?'))

    expect(runner.prompt).not.toHaveBeenCalled()
    expect(said).toHaveLength(0)
  })

  it('answers when @mentioned', async () => {
    const { router, runner } = await build()
    await router.handle(groupMessage('what changed?', { mention: true }))
    expect(runner.prompt).toHaveBeenCalled()
  })

  it('drops its own name from the prompt, since that is addressing', async () => {
    const { router, runner } = await build()
    await router.handle(groupMessage('what changed?', { mention: true }))

    expect(runner.prompt).toHaveBeenCalledWith(
      { chatId: '-100200300' },
      [{ type: 'text', text: 'what changed?' }],
    )
  })

  it('answers a reply to something it said', async () => {
    const { router, runner } = await build()
    await router.handle(groupMessage('yes, do it', { replyToBot: true }))
    expect(runner.prompt).toHaveBeenCalled()
  })

  it('leaves private chats untouched', async () => {
    const { router, runner } = await build()
    await router.handle(message('no mention needed here'))
    expect(runner.prompt).toHaveBeenCalled()
  })

  it('does not answer a command it was not addressed with', async () => {
    // A room with several bots would otherwise see all of them react to /new.
    const { router, runner } = await build()
    await router.handle(groupMessage('/new'))
    expect(runner.reset).not.toHaveBeenCalled()
  })

  it('answers a command addressed to it', async () => {
    const { router, runner } = await build()
    await router.handle(groupMessage('/new', { mention: true }))
    expect(runner.reset).toHaveBeenCalled()
  })

  it('answers everything when the operator turns addressing off', async () => {
    const { router, runner } = await build({ requireAddressing: false })
    await router.handle(groupMessage('did you see the deploy?'))
    expect(runner.prompt).toHaveBeenCalled()
  })

  it('still refuses a stranger in a group, addressed or not', async () => {
    // Access is checked first and answers a different question.
    const { router, runner } = await build()
    const update = groupMessage('what changed?', { mention: true })
    ;(update.message as { from: { id: number } }).from = { id: STRANGER }

    await router.handle(update)
    expect(runner.prompt).not.toHaveBeenCalled()
  })
})

describe('UpdateRouter — /cd', () => {
  it('reports where the conversation is when given nothing', async () => {
    const { router, said } = await build()
    await router.handle(message('/cd'))
    expect(said[0]).toContain('/work')
  })

  it('moves the conversation to a directory that exists', async () => {
    const { router, said, directory } = await build()
    await router.handle(message('/cd /srv/app'))

    expect(directory()).toBe('/srv/app')
    expect(said[0]).toContain('/srv/app')
  })

  it('starts a fresh conversation, because a session keeps its own directory', async () => {
    // The sandbox derives its writable root from the session's cwd, and that
    // root is fixed when the session opens — so the move needs a new session.
    const { router, runner, said } = await build()
    await router.handle(message('/cd /srv/app'))

    expect(runner.reset).toHaveBeenCalledWith({ chatId: '1' })
    expect(said[0]).toContain('fresh conversation')
  })

  it('resolves a path relative to where the conversation already is', async () => {
    const { router, directory } = await build()
    await router.handle(message('/cd app'))
    expect(directory()).toBe('/work/app')
  })

  it('expands a tilde, which is how anyone types a home path', async () => {
    const { router, directory } = await build()
    await router.handle(message('/cd ~/projects/api'))
    expect(directory()).toBe('/Users/adam/projects/api')
  })

  it('says so and changes nothing when the directory is not there', async () => {
    const { router, said, directory, runner } = await build({ at: 'missing' })
    await router.handle(message('/cd /nope'))

    expect(directory()).toBe('/work')
    expect(said[0]).toContain('no such directory')
    expect(runner.reset).not.toHaveBeenCalled()
  })

  it('tells a file apart from a missing directory', async () => {
    // Different mistakes deserve different sentences; a boolean would make
    // both of them "that did not work".
    const { router, said } = await build({ at: 'file' })
    await router.handle(message('/cd /work/notes.md'))
    expect(said[0]).toContain('a file, not a directory')
  })

  it('tells a permission failure apart from both', async () => {
    const { router, said } = await build({ at: 'denied' })
    await router.handle(message('/cd /root/private'))
    expect(said[0]).toContain('cannot be read')
  })

  it('does not restart the conversation for a move that goes nowhere', async () => {
    const { router, said, runner } = await build()
    await router.handle(message('/cd /work'))

    expect(runner.reset).not.toHaveBeenCalled()
    expect(said[0]).toContain('Already in')
  })

  it('keeps the choice even when the reset that follows fails', async () => {
    // The directory is recorded first on purpose: a failed reset should cost
    // the user a `/new`, not the directory they just chose.
    const { router, directory, runner } = await build()
    runner.reset = vi.fn(async () => {
      throw new Error('the harness is gone')
    })

    await router.handle(message('/cd /srv/app')).catch(() => undefined)
    expect(directory()).toBe('/srv/app')
  })

  it('says so where the deployment offers no way to change directory', async () => {
    const { router, said } = await build({ workspace: false })
    await router.handle(message('/cd /srv/app'))
    expect(said[0]).toContain('does not allow')
  })

  it('refuses an unauthorised /cd like any other command', async () => {
    const { router, directory } = await build()
    await router.handle(message('/cd /srv/app', STRANGER))
    expect(directory()).toBe('/work')
  })
})

describe('UpdateRouter — /model', () => {
  it('reports the model in force when given nothing', async () => {
    const { router, said } = await build()
    await router.handle(message('/model'))
    expect(said[0]).toContain('the deployment default')
  })

  it('lists what is configured', async () => {
    const { router, said } = await build()
    await router.handle(message('/model list'))
    expect(said[0]).toContain('deepseek-official/deepseek-v4-pro')
  })

  it('changes the model', async () => {
    const { router, said, model } = await build()
    await router.handle(message('/model xiaomi/mimo-v2.5'))

    expect(model()).toBe('xiaomi/mimo-v2.5')
    expect(said[0]).toContain('xiaomi/mimo-v2.5')
  })

  it('does not restart the conversation, unlike /cd', async () => {
    // The harness reads a mutable selection while assembling each step, so a
    // model change lands on the next message with the history intact.
    const { router, runner, said } = await build()
    await router.handle(message('/model xiaomi/mimo-v2.5'))

    expect(runner.reset).not.toHaveBeenCalled()
    expect(said[0]).toContain('next message')
  })

  it('returns to the deployment default', async () => {
    const { router, said, model } = await build()
    await router.handle(message('/model xiaomi/mimo-v2.5'))
    await router.handle(message('/model default'))

    expect(model()).toBeUndefined()
    expect(said[1]).toContain('the deployment default')
  })

  it('asks which one when several providers offer the name', async () => {
    const { router, said, model } = await build()
    await router.handle(message('/model ambiguous'))

    expect(model()).toBeUndefined()
    expect(said[0]).toContain('a/m')
    expect(said[0]).toContain('b/m')
  })

  it('says so for a model nobody offers, and points at the list', async () => {
    const { router, said, model } = await build()
    await router.handle(message('/model imaginary'))

    expect(model()).toBeUndefined()
    expect(said[0]).toContain('/model list')
  })

  it('says so where the deployment offers no catalog', async () => {
    const { router, said } = await build({ models: false })
    await router.handle(message('/model list'))
    expect(said[0]).toContain('does not allow')
  })
})

/** One part of an album, sharing a group id with its siblings. */
function albumPart(messageId: number, caption?: string): TelegramUpdate {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      chat: { id: 1, type: 'private' },
      from: { id: OWNER },
      photo: [{ file_id: `p${messageId}` }],
      media_group_id: 'g1',
      ...(caption === undefined ? {} : { caption }),
    },
  } as TelegramUpdate
}

describe('UpdateRouter — albums', () => {
  /** A collector that reports what it was handed. */
  const album = () => ({
    collect: async () => ({ parts: [{ type: 'text', text: 'single' }] }),
    collectAll: async (messages: unknown[], caption?: string) => ({
      parts: [
        ...(caption === undefined ? [] : [{ type: 'text', text: caption }]),
        ...messages.map(() => ({ type: 'image', attachment: {} })),
      ],
    }),
  })

  it('answers three photos once, not three times', async () => {
    // Telegram sends an album as N updates; handling each separately turned
    // three screenshots into three turns, two of them with no question.
    const { router, runner } = await build({ media: album() })
    await router.handle(albumPart(1, 'what changed?'))
    await router.handle(albumPart(2))
    await router.handle(albumPart(3))

    await vi.waitFor(() => expect(runner.prompt).toHaveBeenCalledTimes(1))
  })

  it('puts every image in that one prompt', async () => {
    const { router, runner } = await build({ media: album() })
    await router.handle(albumPart(1, 'what changed?'))
    await router.handle(albumPart(2))
    await router.handle(albumPart(3))

    await vi.waitFor(() => expect(runner.prompt).toHaveBeenCalled())
    const parts = (runner.prompt as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as {
      type: string
    }[]
    expect(parts.filter((part) => part.type === 'image')).toHaveLength(3)
  })

  it('keeps the caption, which only one part carries', async () => {
    const { router, runner } = await build({ media: album() })
    await router.handle(albumPart(1, 'what changed?'))
    await router.handle(albumPart(2))

    await vi.waitFor(() => expect(runner.prompt).toHaveBeenCalled())
    const parts = (runner.prompt as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as {
      type: string
      text?: string
    }[]
    expect(parts[0]).toMatchObject({ type: 'text', text: 'what changed?' })
  })

  it('leaves a lone photo on the single-message path', async () => {
    // Waiting on one photo would add latency for nothing.
    const { router, runner } = await build({ media: album() })
    await router.handle({
      update_id: 9,
      message: {
        message_id: 9,
        chat: { id: 1, type: 'private' },
        from: { id: OWNER },
        photo: [{ file_id: 'p9' }],
      },
    } as TelegramUpdate)

    expect(runner.prompt).toHaveBeenCalledWith({ chatId: '1' }, [
      { type: 'text', text: 'single' },
    ])
  })

  it('never lets an unauthorised album through', async () => {
    const { router, runner } = await build({ media: album() })
    const update = albumPart(1, 'what changed?')
    ;(update.message as { from: { id: number } }).from = { id: STRANGER }

    await router.handle(update)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(runner.prompt).not.toHaveBeenCalled()
  })
})

describe('UpdateRouter — /diag', () => {
  it('reports the connection', async () => {
    const { router, said } = await build()
    await router.handle(message('/diag'))
    expect(said[0]).toContain('@my_bot')
  })

  it('names which harness seams are actually composed', async () => {
    // The most useful line in the report: an absent seam explains a whole
    // class of "why does it not do that". A missing agentPresets is why
    // Telegram agents once reached the model with almost no tools.
    const { router, said } = await build()
    await router.handle(message('/diag'))

    expect(said[0]).toContain('| agents | ✅ |')
    expect(said[0]).toContain('| agentPresets | ❌ |')
  })

  it('says so plainly when nothing has gone wrong', async () => {
    const { router, said } = await build()
    await router.handle(message('/diag'))
    expect(said[0]).toContain('Nothing has gone wrong')
  })

  it('lists recent failures, newest first, with the level marked', async () => {
    const { router, said } = await build({
      failures: [
        { at: '2026-08-21T10:00:00.000Z', level: 'error', message: 'the harness is gone' },
        { at: '2026-08-21T09:59:00.000Z', level: 'warn', message: 'a slow download' },
      ],
    })
    await router.handle(message('/diag'))

    expect(said[0]).toContain('🔴 the harness is gone')
    expect(said[0]).toContain('🟠 a slow download')
    expect(said[0]).toContain('**Recent failures** (2)')
  })

  it('falls back to lines below Bot API 10.1', async () => {
    const { router, said } = await build({ richMessages: false })
    await router.handle(message('/diag'))
    expect(said[0]).toContain('<b>Bot</b>')
  })

  it('says so where the deployment keeps none', async () => {
    const { router, said } = await build({ diagnostics: false })
    await router.handle(message('/diag'))
    expect(said[0]).toContain('keeps no diagnostics')
  })

  it('refuses an unauthorised /diag, like any other command', async () => {
    const { router, said } = await build()
    await router.handle(message('/diag', STRANGER))
    expect(said[0]).toContain('not allowed')
  })
})

describe('UpdateRouter — /effort', () => {
  it('shows the effort in force and what the model offers', async () => {
    const { router, said } = await build()
    await router.handle(message('/effort'))

    expect(said[0]).toContain("the model's own default")
    expect(said[0]).toContain('high')
  })

  it('changes it', async () => {
    const { router, said, effort } = await build()
    await router.handle(message('/effort high'))

    expect(effort()).toBe('high')
    expect(said[0]).toContain('next message')
  })

  it('does not restart the conversation', async () => {
    const { router, runner } = await build()
    await router.handle(message('/effort high'))
    expect(runner.reset).not.toHaveBeenCalled()
  })

  it('returns to the model default', async () => {
    const { router, effort } = await build()
    await router.handle(message('/effort high'))
    await router.handle(message('/effort default'))
    expect(effort()).toBeUndefined()
  })

  it('names what the model does offer when the words match none', async () => {
    const { router, said, effort } = await build()
    await router.handle(message('/effort maximum'))

    expect(effort()).toBeUndefined()
    expect(said[0]).toContain('low, medium, high')
  })

  it('says so for a model that offers no choice at all', async () => {
    const { router, said } = await build({ efforts: [] })
    await router.handle(message('/effort high'))
    expect(said[0]).toContain('no reasoning effort')
  })

  it('says so where the deployment offers no catalog', async () => {
    const { router, said } = await build({ effort: false })
    await router.handle(message('/effort high'))
    expect(said[0]).toContain('does not allow')
  })
})

describe('UpdateRouter — saying which layer answered', () => {
  it('says nothing extra when the chat is simply following the deployment', async () => {
    // There is one answer then, and pointing at it would be noise.
    const { router, said } = await build()
    await router.handle(message('/vision'))
    expect(said[0]).not.toContain('this chat')
  })

  it('names the layer beneath once the chat has overridden it', async () => {
    // Two surfaces show related state — this command and the settings page —
    // and neither admitting the other is what made the page look like it lied.
    const { router, said } = await build()
    await router.handle(message('/vision off'))
    await router.handle(message('/vision'))

    const shown = said[said.length - 1] ?? ''
    expect(shown).toContain('this chat')
    expect(shown).toContain('xiaomi/mimo-v2.5')
  })

  it('says it on the reply that made the change, where the confusion starts', async () => {
    const { router, said } = await build()
    await router.handle(message('/vision off'))
    expect(said[0]).toContain('this chat')
  })

  it('does it for /model too', async () => {
    const { router, said } = await build()
    await router.handle(message('/model xiaomi/mimo-v2.5'))
    await router.handle(message('/model'))

    expect(said[said.length - 1]).toContain('this chat')
  })
})

describe('UpdateRouter — /vision', () => {
  it('shows what reads images here', async () => {
    const { router, said } = await build()
    await router.handle(message('/vision'))
    expect(said[0]).toContain('nothing configured')
  })

  it('changes the reader', async () => {
    const { router, reader } = await build()
    await router.handle(message('/vision xiaomi/mimo-v2.5'))
    expect(reader()).toBe('xiaomi/mimo-v2.5')
  })

  it('turns it off, which is a real answer and not an absence', async () => {
    // A conversation whose own model can see wants no reader at all, and
    // saying so has to outrank whatever the deployment configured.
    const { router, said, reader } = await build()
    await router.handle(message('/vision off'))

    expect(reader()).toBe('off')
    expect(said[0]).toContain('the conversation itself')
  })

  it('takes the other words people use for off', async () => {
    for (const word of ['none', 'no', 'disable', 'disabled', 'OFF']) {
      const { router, reader } = await build()
      await router.handle(message(`/vision ${word}`))
      expect(reader()).toBe('off')
    }
  })

  it('returns to whatever the deployment configured', async () => {
    const { router, reader } = await build()
    await router.handle(message('/vision off'))
    await router.handle(message('/vision default'))
    expect(reader()).toBeUndefined()
  })

  it('asks which one when several providers offer the name', async () => {
    const { router, said, reader } = await build()
    await router.handle(message('/vision ambiguous'))

    expect(reader()).toBeUndefined()
    expect(said[0]).toContain('a/m')
  })

  it('points at the list for a model nobody offers', async () => {
    const { router, said } = await build()
    await router.handle(message('/vision imaginary'))
    expect(said[0]).toContain('/model list')
  })

  it('says so where the deployment offers no catalog', async () => {
    const { router, said } = await build({ vision: false })
    await router.handle(message('/vision off'))
    expect(said[0]).toContain('does not allow')
  })

  it('appears in /status, since it decides what happens to a screenshot', async () => {
    const { router, said } = await build()
    await router.handle(message('/vision xiaomi/mimo-v2.5'))
    await router.handle(message('/status'))

    expect(said[said.length - 1]).toContain('Reads images')
    expect(said[said.length - 1]).toContain('xiaomi/mimo-v2.5')
  })
})

describe('UpdateRouter — /permission', () => {
  it('shows what the agent may do, and the alternatives', async () => {
    const { router, said } = await build()
    await router.handle(message('/permission'))

    expect(said[0]).toContain('the deployment default')
    expect(said[0]).toContain('read-only')
    expect(said[0]).toContain('danger-full-access')
  })

  it('tightens it', async () => {
    const { router, said, preset } = await build()
    await router.handle(message('/permission read-only'))

    expect(preset()).toBe('read-only')
    expect(said[0]).toContain('read-only')
  })

  it('takes the words somebody actually types', async () => {
    const { router, preset } = await build()
    await router.handle(message('/permission workspace write'))
    expect(preset()).toBe('workspace-write')
  })

  it('returns to the deployment default', async () => {
    const { router, preset } = await build()
    await router.handle(message('/permission read-only'))
    await router.handle(message('/permission default'))
    expect(preset()).toBeUndefined()
  })

  it('names the presets this deployment has when the words match none', async () => {
    const { router, said, preset } = await build()
    await router.handle(message('/permission yolo'))

    expect(preset()).toBeUndefined()
    expect(said[0]).toContain('workspace-write')
  })

  it('says so where the deployment has no preset table', async () => {
    const { router, said } = await build({ permission: false })
    await router.handle(message('/permission read-only'))
    expect(said[0]).toContain('does not allow')
  })

  it('refuses an unauthorised change, like any other command', async () => {
    const { router, preset } = await build()
    await router.handle(message('/permission danger-full-access', STRANGER))
    expect(preset()).toBeUndefined()
  })
})

describe('UpdateRouter — pending prompts', () => {
  it('gives a waiting question the typed answer instead of the agent', async () => {
    const { router, runner, textCapture } = await build()
    const waited = textCapture.next({ chatId: '1' })

    await router.handle(message('the branch is main'))

    await expect(waited).resolves.toBe('the branch is main')
    expect(runner.prompt).not.toHaveBeenCalled()
  })

  it('lets a waiting question take a message that looks like a command', async () => {
    const { router, runner, textCapture } = await build()
    const waited = textCapture.next({ chatId: '1' })

    await router.handle(message('/new'))

    await expect(waited).resolves.toBe('/new')
    expect(runner.reset).not.toHaveBeenCalled()
  })

  it('only diverts messages from the chat that is waiting', async () => {
    const { router, runner, textCapture } = await build()
    textCapture.next({ chatId: '1' })

    await router.handle(message('other chat', OWNER, 2))
    expect(runner.prompt).toHaveBeenCalledWith({ chatId: '2' }, [
      { type: 'text', text: 'other chat' },
    ])
  })
})

describe('UpdateRouter — button presses', () => {
  const press = (data: string, from = OWNER): TelegramUpdate => ({
    update_id: 2,
    callback_query: { id: 'cb-1', from: { id: from }, data },
  })

  it('acknowledges the press before anything else', async () => {
    const { router, answered } = await build()
    await router.handle(press('q:tok:0'))
    expect(answered).toEqual(['cb-1'])
  })

  it('offers the press to questions first', async () => {
    const { router, questions, approvals } = await build()
    questions.handleCallback.mockReturnValueOnce(true)

    await router.handle(press('q:tok:0'))
    expect(questions.handleCallback).toHaveBeenCalledWith('q:tok:0')
    expect(approvals.handleCallback).not.toHaveBeenCalled()
  })

  it('falls through to approvals when questions do not own it', async () => {
    const { router, approvals } = await build()
    await router.handle(press('a:tok:0'))
    expect(approvals.handleCallback).toHaveBeenCalledWith('a:tok:0')
  })

  it('acknowledges but ignores a stale press nobody owns', async () => {
    const { router, answered } = await build()
    await expect(router.handle(press('q:gone:0'))).resolves.toBeUndefined()
    expect(answered).toEqual(['cb-1'])
  })

  it('ignores a press from an unauthorised user', async () => {
    const { router, questions } = await build()
    await router.handle(press('q:tok:0', STRANGER))
    expect(questions.handleCallback).not.toHaveBeenCalled()
  })
})

describe('UpdateRouter — robustness', () => {
  it('ignores an update carrying neither a message nor a press', async () => {
    const { router, said } = await build()
    await expect(router.handle({ update_id: 3 })).resolves.toBeUndefined()
    expect(said).toHaveLength(0)
  })

  it('ignores a message with no sender', async () => {
    const { router, runner } = await build()
    await router.handle({
      update_id: 4,
      message: { message_id: 1, chat: { id: 1, type: 'private' }, text: 'hi' },
    })
    expect(runner.prompt).not.toHaveBeenCalled()
  })

  it('says so when a photo arrives but attachments are not configured', async () => {
    const { router, said } = await build()
    await router.handle({
      update_id: 5,
      message: {
        message_id: 1,
        chat: { id: 1, type: 'private' },
        from: { id: OWNER },
        photo: [{ file_id: 'abc' }],
      },
    })
    expect(said[0]).toContain('attachments')
  })

  it('sends a photo through the collector when one is configured', async () => {
    const { router, runner } = await build({
      media: {
        collect: async () => ({ parts: [{ type: 'image', attachment: { attachmentId: 'a1' } }] }),
      },
    })

    await router.handle({
      update_id: 6,
      message: {
        message_id: 1,
        chat: { id: 1, type: 'private' },
        from: { id: OWNER },
        photo: [{ file_id: 'abc' }],
        caption: 'why this error?',
      },
    })

    expect(runner.prompt).toHaveBeenCalledWith({ chatId: '1' }, [
      { type: 'image', attachment: { attachmentId: 'a1' } },
    ])
  })

  it('does not read a captioned file as a command', async () => {
    // '/new' as a caption on a screenshot is a caption, not a reset.
    const { router, runner } = await build({
      media: { collect: async () => ({ parts: [{ type: 'text', text: '/new' }] }) },
    })

    await router.handle({
      update_id: 7,
      message: {
        message_id: 1,
        chat: { id: 1, type: 'private' },
        from: { id: OWNER },
        photo: [{ file_id: 'abc' }],
        caption: '/new',
      },
    })

    expect(runner.reset).not.toHaveBeenCalled()
    expect(runner.prompt).toHaveBeenCalled()
  })

  it('reports a prompt failure into the chat instead of dying', async () => {
    const { router, runner, said } = await build()
    ;(runner.prompt as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('no model route'))

    await expect(router.handle(message('hello'))).resolves.toBeUndefined()
    expect(said[0]).toContain('no model route')
  })

  it('keeps the poll loop alive when a handler throws outright', async () => {
    const { router, runner } = await build()
    ;(runner.reset as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'))
    await expect(router.handle(message('/new'))).resolves.toBeUndefined()
  })

  it('routes an edited message like a new one', async () => {
    const { router, runner } = await build()
    await router.handle({
      update_id: 6,
      edited_message: {
        message_id: 1,
        chat: { id: 1, type: 'private' },
        from: { id: OWNER },
        text: 'revised prompt',
      },
    })
    expect(runner.prompt).toHaveBeenCalledWith({ chatId: '1' }, [
      { type: 'text', text: 'revised prompt' },
    ])
  })
})


describe('UpdateRouter — what it says out loud', () => {
  it('redacts a secret quoted by a failure before posting it to the chat', async () => {
    const { router, runner, said } = await build()
    ;(runner.prompt as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('request to https://api.example/botSECRET-TOKEN/x failed'),
    )

    await router.handle(message('hello'))

    expect(said[0]).not.toContain('SECRET-TOKEN')
    // Redaction runs before html escaping, so the marker arrives escaped and
    // the user reads a literal <redacted> rather than markup.
    expect(said[0]).toContain('&lt;redacted&gt;')
  })

  it('still tells the user what went wrong', async () => {
    const { router, runner, said } = await build()
    ;(runner.prompt as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('disk full'))

    await router.handle(message('hello'))
    expect(said[0]).toContain('disk full')
  })
})


describe('UpdateRouter — telling the user what could not be used', () => {
  it('says so in the chat, without waiting for the agent to mention it', async () => {
    const { router, said, runner } = await build({
      media: {
        collect: async () => ({
          parts: [{ type: 'text', text: 'look at this' }],
          notice: "deepseek-v4-flash can't read images.",
        }),
      },
    })

    await router.handle({
      update_id: 8,
      message: {
        message_id: 1,
        chat: { id: 1, type: 'private' },
        from: { id: OWNER },
        photo: [{ file_id: 'abc' }],
        caption: 'look at this',
      },
    })

    expect(said[0]).toContain("can't read images")
    // The caption still reaches the agent: the turn is not wasted.
    expect(runner.prompt).toHaveBeenCalled()
  })

  it('says nothing extra when everything was usable', async () => {
    const { router, said } = await build({
      media: { collect: async () => ({ parts: [{ type: 'text', text: 'fine' }] }) },
    })

    await router.handle({
      update_id: 9,
      message: {
        message_id: 1,
        chat: { id: 1, type: 'private' },
        from: { id: OWNER },
        photo: [{ file_id: 'abc' }],
      },
    })

    expect(said).toHaveLength(0)
  })
})

describe('UpdateRouter — while it is working', () => {
  it('shows an indicator while an attachment is read', async () => {
    // Downloading a file and reading an image on a vision model both outlast
    // Telegram's five-second action, so this is a hold rather than one call.
    const { router, holds } = await build({
      media: { collect: async () => ({ parts: [{ type: 'text', text: 'ok' }] }) },
    })

    await router.handle({
      update_id: 10,
      message: {
        message_id: 1,
        chat: { id: 1, type: 'private' },
        from: { id: OWNER },
        photo: [{ file_id: 'abc' }],
      },
    })

    expect(holds.length).toBeGreaterThan(0)
    expect(holds[0]?.chatId).toBe('1')
  })

  it('shows one for a plain message too, which can wait behind the last', async () => {
    const { router, holds } = await build()

    await router.handle({
      update_id: 12,
      message: {
        message_id: 1,
        chat: { id: 1, type: 'private' },
        from: { id: OWNER },
        text: 'hello',
      },
    })

    expect(holds.length).toBeGreaterThan(0)
  })

  it('lets go once the prompt is queued, so the bridge can take over', async () => {
    const { router, typing } = await build({
      media: { collect: async () => ({ parts: [{ type: 'text', text: 'ok' }] }) },
    })

    await router.handle({
      update_id: 13,
      message: {
        message_id: 1,
        chat: { id: 1, type: 'private' },
        from: { id: OWNER },
        photo: [{ file_id: 'abc' }],
      },
    })

    expect(typing()).toBe(false)
  })

  it('lets go even when the prompt fails, so the chat does not type forever', async () => {
    const { router, runner, typing } = await build()
    runner.prompt = vi.fn(async () => {
      throw new Error('the harness is gone')
    })

    await router.handle({
      update_id: 14,
      message: {
        message_id: 1,
        chat: { id: 1, type: 'private' },
        from: { id: OWNER },
        text: 'hello',
      },
    })

    expect(typing()).toBe(false)
  })

  it('reads the attachment even where the indicator is unavailable', async () => {
    const { router, runner } = await build({
      typing: false,
      media: { collect: async () => ({ parts: [{ type: 'text', text: 'ok' }] }) },
    })

    await router.handle({
      update_id: 11,
      message: {
        message_id: 1,
        chat: { id: 1, type: 'private' },
        from: { id: OWNER },
        photo: [{ file_id: 'abc' }],
      },
    })

    expect(runner.prompt).toHaveBeenCalled()
  })
})
