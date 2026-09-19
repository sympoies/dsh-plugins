import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { BindingStore } from '../src/session/bindings.js'
import { SessionRunner } from '../src/session/runner.js'
import type { AgentHost, PromptResolver, RunningAgent } from '../src/session/runner.js'

const CHAT = { chatId: '1' }

/** One text prompt part, the ordinary case. */
const text = (value: string) => [{ type: 'text' as const, text: value }]

/** An agent host backed by an in-memory map, with spies on every transition. */
function fakeHost() {
  const agents = new Map<string, RunningAgent & { prompts: string[]; cancelled: string[] }>()
  const created: string[] = []
  const resumed: string[] = []
  let resumable = true

  const make = (sessionId: string) => {
    const agent = {
      sessionId,
      prompts: [] as string[],
      cancelled: [] as string[],
      /** The override in force when each prompt was queued. */
      routes: [] as (undefined | { provider: string; model: string })[],
      model: undefined as undefined | { provider: string; model: string },
      followup(content: readonly { type: string; text?: string }[]) {
        agent.prompts.push(content.map((part) => part.text ?? `[${part.type}]`).join(''))
        agent.routes.push(agent.model)
      },
      useModel(route: { provider: string; model: string } | undefined) {
        agent.model = route
        return true
      },
      cancel(reason: string) {
        agent.cancelled.push(reason)
      },
      async dispose() {
        agents.delete(sessionId)
      },
    }
    agents.set(sessionId, agent)
    return agent
  }

  const host: AgentHost = {
    live: (sessionId) => agents.get(sessionId),
    async create(sessionId) {
      created.push(sessionId)
      return make(sessionId)
    },
    async resume(sessionId) {
      resumed.push(sessionId)
      return resumable ? make(sessionId) : undefined
    },
  }

  return {
    host,
    agents,
    created,
    resumed,
    setResumable: (value: boolean) => void (resumable = value),
  }
}

let bindings: BindingStore

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-telegram-runner-'))
  bindings = await BindingStore.open(join(dir, 'bindings.json'))
})

function build(
  host: AgentHost,
  ids = ['s1', 's2', 's3'],
  visionRoute?: () => { provider: string; model: string } | undefined,
  extractor?: PromptResolver,
) {
  const queue = [...ids]
  return new SessionRunner({
    host,
    bindings,
    cwdFor: () => '/work',
    newSessionId: () => queue.shift() ?? 'exhausted',
    ...(visionRoute ? { visionRoute } : {}),
    ...(extractor ? { extractor } : {}),
  })
}

/** A prompt carrying an image, as a screenshot with a caption arrives. */
const withImage = (caption: string) => [
  { type: 'text' as const, text: caption },
  { type: 'image' as const, attachment: { attachmentId: 'a1' } as never },
]

const VISION = { provider: 'openai', model: 'gpt-5' }

describe('SessionRunner — first message', () => {
  it('creates a session and binds the chat to it', async () => {
    const fake = fakeHost()
    await build(fake.host).prompt(CHAT, text('hello'))

    expect(fake.created).toEqual(['s1'])
    expect(bindings.forChat(CHAT)?.sessionId).toBe('s1')
  })

  it('delivers the prompt to the new agent', async () => {
    const fake = fakeHost()
    await build(fake.host).prompt(CHAT, text('hello'))
    expect(fake.agents.get('s1')?.prompts).toEqual(['hello'])
  })

  it('starts the session in the configured working directory', async () => {
    const fake = fakeHost()
    const create = vi.spyOn(fake.host, 'create')
    await build(fake.host).prompt(CHAT, text('hello'))
    expect(create).toHaveBeenCalledWith('s1', '/work')
  })
})

describe('SessionRunner — continuing a conversation', () => {
  it('reuses the loaded agent for a second message', async () => {
    const fake = fakeHost()
    const runner = build(fake.host)

    await runner.prompt(CHAT, text('one'))
    await runner.prompt(CHAT, text('two'))

    expect(fake.created).toEqual(['s1'])
    expect(fake.agents.get('s1')?.prompts).toEqual(['one', 'two'])
  })

  it('resumes from the log after a restart', async () => {
    const first = fakeHost()
    await build(first.host).prompt(CHAT, text('before restart'))

    // A new process: the binding survives, the loaded agent does not.
    const second = fakeHost()
    await build(second.host).prompt(CHAT, text('after restart'))

    expect(second.resumed).toEqual(['s1'])
    expect(second.created).toEqual([])
  })

  it('starts fresh when the persisted session can no longer be loaded', async () => {
    const first = fakeHost()
    await build(first.host).prompt(CHAT, text('before'))

    const second = fakeHost()
    second.setResumable(false)
    await build(second.host, ['s9']).prompt(CHAT, text('after'))

    expect(second.created).toEqual(['s9'])
    expect(bindings.forChat(CHAT)?.sessionId).toBe('s9')
  })

  it('starts fresh when resuming throws outright', async () => {
    const first = fakeHost()
    await build(first.host).prompt(CHAT, text('before'))

    const second = fakeHost()
    vi.spyOn(second.host, 'resume').mockRejectedValueOnce(new Error('log is corrupt'))
    await build(second.host, ['s9']).prompt(CHAT, text('after'))

    expect(second.created).toEqual(['s9'])
  })

  it('does not create two sessions for two messages arriving together', async () => {
    const fake = fakeHost()
    const runner = build(fake.host)

    await Promise.all([runner.prompt(CHAT, text('one')), runner.prompt(CHAT, text('two'))])

    expect(fake.created).toEqual(['s1'])
    expect(fake.agents.get('s1')?.prompts).toEqual(['one', 'two'])
  })

  it('keeps separate conversations for separate chats', async () => {
    const fake = fakeHost()
    const runner = build(fake.host)

    await runner.prompt({ chatId: '1' }, text('a'))
    await runner.prompt({ chatId: '2' }, text('b'))

    expect(fake.created).toEqual(['s1', 's2'])
  })
})

describe('SessionRunner — reset', () => {
  it('forgets the binding so the next message starts fresh', async () => {
    const fake = fakeHost()
    const runner = build(fake.host)

    await runner.prompt(CHAT, text('one'))
    await runner.reset(CHAT)
    await runner.prompt(CHAT, text('two'))

    expect(fake.created).toEqual(['s1', 's2'])
  })

  it('disposes the loaded agent it is discarding', async () => {
    const fake = fakeHost()
    const runner = build(fake.host)

    await runner.prompt(CHAT, text('one'))
    await runner.reset(CHAT)

    expect(fake.agents.has('s1')).toBe(false)
  })

  it('does nothing for a chat that has no conversation yet', async () => {
    const fake = fakeHost()
    await expect(build(fake.host).reset(CHAT)).resolves.toBeUndefined()
  })

  it('still forgets the binding when disposal fails', async () => {
    const fake = fakeHost()
    const runner = build(fake.host)
    await runner.prompt(CHAT, text('one'))

    const agent = fake.agents.get('s1')
    if (agent) agent.dispose = async () => Promise.reject(new Error('stuck'))

    await runner.reset(CHAT)
    expect(bindings.forChat(CHAT)).toBeUndefined()
  })
})

describe('SessionRunner — stop and status', () => {
  it('cancels the loaded agent', async () => {
    const fake = fakeHost()
    const runner = build(fake.host)
    await runner.prompt(CHAT, text('one'))

    await expect(runner.stop(CHAT)).resolves.toBe(true)
    expect(fake.agents.get('s1')?.cancelled).toHaveLength(1)
  })

  it('reports nothing to stop for an unbound chat', async () => {
    const fake = fakeHost()
    await expect(build(fake.host).stop(CHAT)).resolves.toBe(false)
  })

  it('reports nothing to stop when the session is only on disk', async () => {
    const first = fakeHost()
    await build(first.host).prompt(CHAT, text('one'))

    const second = fakeHost()
    await expect(build(second.host).stop(CHAT)).resolves.toBe(false)
  })

  /** The rows as one string, for asserting on what they say. */
  const flatten = (rows: { label: string; value: string }[]) =>
    rows.map((row) => `${row.label}=${row.value}`).join('\n')

  it('says there is no conversation before the first message', async () => {
    const fake = fakeHost()
    expect(flatten(await build(fake.host).status(CHAT))).toContain('none yet')
  })

  it('still names the directory before the first message', async () => {
    // It is what the next message opens in, and /cd before saying anything is
    // a reasonable thing to do.
    const fake = fakeHost()
    expect(flatten(await build(fake.host).status(CHAT))).toContain('/work')
  })

  it('reports the session id and working directory', async () => {
    const fake = fakeHost()
    const runner = build(fake.host)
    await runner.prompt(CHAT, text('one'))

    const status = flatten(await runner.status(CHAT))
    expect(status).toContain('s1')
    expect(status).toContain('/work')
    expect(status).toContain('loaded')
  })

  it('reports an unloaded session as idle', async () => {
    const first = fakeHost()
    await build(first.host).prompt(CHAT, text('one'))

    const second = fakeHost()
    expect(flatten(await build(second.host).status(CHAT))).toContain('idle')
  })

  it('reports rows rather than markup, so the caller can add its own', async () => {
    const fake = fakeHost()
    const rows = await build(fake.host).status(CHAT)
    expect(rows.map((row) => row.label)).toContain('Directory')
  })
})


describe('SessionRunner — empty prompts', () => {
  it('does not wake an agent for a prompt with no content', async () => {
    // A message whose every attachment failed to read produces no parts.
    const fake = fakeHost()
    await build(fake.host).prompt(CHAT, [])
    expect(fake.created).toEqual([])
  })
})


/** A resolver standing in for a vision model that reads pictures. */
function reader(options: { available?: boolean; fails?: boolean } = {}): PromptResolver {
  return {
    available: options.available !== false,
    async resolve(content) {
      if (options.fails) throw new Error('the vision model is unreachable')
      return [
        ...content.filter((part) => part.type === 'text'),
        { type: 'text' as const, text: 'Contents of the image the user sent:\n\nRp 250.000' },
      ]
    },
  }
}

describe('SessionRunner — the model a conversation chose', () => {
  const CHOSEN = { provider: 'xiaomi', model: 'mimo-v2.5' }

  /** A runner whose conversation has picked its own model. */
  function withChoice(host: AgentHost, chosen?: { provider: string; model: string }) {
    return new SessionRunner({
      host,
      bindings,
      cwdFor: () => '/work',
      newSessionId: () => 's1',
      visionRoute: () => VISION,
      ...(chosen ? { chosenRoute: () => chosen } : {}),
    })
  }

  it('routes an ordinary turn onto the chosen model', async () => {
    const fake = fakeHost()
    await withChoice(fake.host, CHOSEN).prompt(CHAT, text('hello'))
    expect(fake.agents.get('s1')?.routes).toEqual([CHOSEN])
  })

  it('leaves a conversation that chose nothing on the deployment default', async () => {
    const fake = fakeHost()
    await withChoice(fake.host).prompt(CHAT, text('hello'))
    expect(fake.agents.get('s1')?.routes).toEqual([undefined])
  })

  it('lets an image outrank the choice, since a blind model fails the request', async () => {
    // Not a preference to honour: a model with no image input rejects the
    // whole request rather than degrading.
    const fake = fakeHost()
    await withChoice(fake.host, CHOSEN).prompt(CHAT, withImage('what is this?'))
    expect(fake.agents.get('s1')?.routes).toEqual([VISION])
  })

  it('falls back to the choice when no vision model is configured', async () => {
    const fake = fakeHost()
    const runner = new SessionRunner({
      host: fake.host,
      bindings,
      cwdFor: () => '/work',
      newSessionId: () => 's1',
      chosenRoute: () => CHOSEN,
    })

    await runner.prompt(CHAT, withImage('what is this?'))
    expect(fake.agents.get('s1')?.routes).toEqual([CHOSEN])
  })

  it('reads the choice per prompt, so /model lands on the next message', async () => {
    const fake = fakeHost()
    const queue = [undefined, CHOSEN]
    const runner = new SessionRunner({
      host: fake.host,
      bindings,
      cwdFor: () => '/work',
      newSessionId: () => 's1',
      chosenRoute: () => queue.shift(),
    })

    await runner.prompt(CHAT, text('one'))
    await runner.prompt(CHAT, text('two'))

    expect(fake.agents.get('s1')?.routes).toEqual([undefined, CHOSEN])
  })
})

describe('SessionRunner — the permission preset', () => {
  /** A runner whose permission control just records what it was asked. */
  function withPermission(host: AgentHost, ids = ['s1']) {
    const applied: string[] = []
    const queue = [...ids]
    const runner = new SessionRunner({
      host,
      bindings,
      cwdFor: () => '/work',
      newSessionId: () => queue.shift() ?? 'exhausted',
      permission: { apply: (_target, sessionId) => void applied.push(sessionId) },
    })
    return { runner, applied }
  }

  it('applies it to a new session', async () => {
    const fake = fakeHost()
    const { runner, applied } = withPermission(fake.host)

    await runner.prompt(CHAT, text('hello'))
    expect(applied).toEqual(['s1'])
  })

  it('applies it to a resumed session too, since the surface has not changed', async () => {
    // A conversation that outlived a restart is still a Telegram conversation.
    const first = fakeHost()
    await build(first.host, ['s1']).prompt(CHAT, text('hello'))

    const second = fakeHost()
    const { runner, applied } = withPermission(second.host, ['s9'])
    await runner.prompt(CHAT, text('again'))

    expect(applied).toEqual(['s1'])
  })

  it('applies it once per session, not once per message', async () => {
    const fake = fakeHost()
    const { runner, applied } = withPermission(fake.host)

    await runner.prompt(CHAT, text('one'))
    await runner.prompt(CHAT, text('two'))

    expect(applied).toEqual(['s1'])
  })
})

describe('SessionRunner — the status rows', () => {
  it('reports the directory verbatim, leaving escaping to whoever renders it', async () => {
    // Rows are data. Escaping here would double-escape the moment the caller
    // renders them as anything other than the markup this guessed at.
    const fake = fakeHost()
    const runner = new SessionRunner({
      host: fake.host,
      bindings,
      cwdFor: () => '/work/<repo> & co',
      newSessionId: () => 's1',
    })

    await runner.prompt(CHAT, text('hello'))
    const rows = await runner.status(CHAT)

    expect(rows.find((row) => row.label === 'Directory')?.value).toBe('/work/<repo> & co')
  })
})

describe('SessionRunner — the reader a conversation chose', () => {
  it('reads with the route that conversation picked, not a global one', async () => {
    // /vision is per conversation, so two chats can read with different models.
    const seen: (undefined | { provider: string; model: string })[] = []
    const fake = fakeHost()
    const runner = new SessionRunner({
      host: fake.host,
      bindings,
      cwdFor: () => '/work',
      newSessionId: () => 's1',
      visionRoute: (target) => (target.chatId === '1' ? VISION : undefined),
      extractor: {
        available: true,
        async resolve(content, route) {
          seen.push(route)
          return [...content.filter((part) => part.type === 'text')]
        },
      },
    })

    await runner.prompt(CHAT, withImage('one'))
    expect(seen).toEqual([VISION])
  })

  it('passes nothing when that conversation turned the reader off', async () => {
    const seen: unknown[] = []
    const fake = fakeHost()
    const runner = new SessionRunner({
      host: fake.host,
      bindings,
      cwdFor: () => '/work',
      newSessionId: () => 's1',
      visionRoute: () => undefined,
      extractor: {
        available: true,
        async resolve(content, route) {
          seen.push(route)
          return [...content]
        },
      },
    })

    await runner.prompt(CHAT, withImage('one'))
    expect(seen).toEqual([undefined])
  })
})

describe('SessionRunner — when the conversation\'s own model can see', () => {
  it('sends the picture, not a description of it', async () => {
    // Extraction is not merely unnecessary here — it is worse. A transcription
    // loses the diagram, the chart, the misaligned layout: everything the
    // model was actually being asked to look at.
    const fake = fakeHost()
    const runner = new SessionRunner({
      host: fake.host,
      bindings,
      cwdFor: () => '/work',
      newSessionId: () => 's1',
      extractor: reader(),
      modelSees: async () => true,
    })

    await runner.prompt(CHAT, withImage('why does this look wrong?'))
    expect(fake.agents.get('s1')?.prompts).toEqual(['why does this look wrong?[image]'])
  })

  it('keeps the model the conversation chose, which is why it can see at all', async () => {
    // Clearing the override here dropped the conversation back to the
    // deployment default — so the check for "this model can see" undid the
    // very choice it had just observed, and the turn failed on the old model.
    const chosen = { provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' }
    const fake = fakeHost()
    const runner = new SessionRunner({
      host: fake.host,
      bindings,
      cwdFor: () => '/work',
      newSessionId: () => 's1',
      chosenRoute: () => chosen,
      visionRoute: () => VISION,
      modelSees: async () => true,
    })

    await runner.prompt(CHAT, withImage('count the people'))
    expect(fake.agents.get('s1')?.routes).toEqual([chosen])
  })

  it('does not move it onto the reader, since it is already where it belongs', async () => {
    const fake = fakeHost()
    const runner = new SessionRunner({
      host: fake.host,
      bindings,
      cwdFor: () => '/work',
      newSessionId: () => 's1',
      visionRoute: () => VISION,
      modelSees: async () => true,
    })

    await runner.prompt(CHAT, withImage('look'))
    expect(fake.agents.get('s1')?.routes).toEqual([undefined])
  })

  it('keeps the chosen model on the next plain turn too', async () => {
    const chosen = { provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' }
    const fake = fakeHost()
    const runner = new SessionRunner({
      host: fake.host,
      bindings,
      cwdFor: () => '/work',
      newSessionId: () => 's1',
      chosenRoute: () => chosen,
      modelSees: async () => true,
    })

    await runner.prompt(CHAT, withImage('count the people'))
    await runner.prompt(CHAT, text('and now the cars'))

    expect(fake.agents.get('s1')?.routes).toEqual([chosen, chosen])
  })

  it('still extracts when the model cannot see', async () => {
    const fake = fakeHost()
    const runner = new SessionRunner({
      host: fake.host,
      bindings,
      cwdFor: () => '/work',
      newSessionId: () => 's1',
      extractor: reader(),
      modelSees: async () => false,
    })

    await runner.prompt(CHAT, withImage('how much?'))
    expect(fake.agents.get('s1')?.prompts[0]).toContain('Contents of the image')
  })

  it('extracts when the question cannot be answered at all', async () => {
    // An unanswerable check must not quietly disable the workaround that
    // keeps a text-only conversation working.
    const fake = fakeHost()
    const runner = new SessionRunner({
      host: fake.host,
      bindings,
      cwdFor: () => '/work',
      newSessionId: () => 's1',
      extractor: reader(),
      modelSees: async () => {
        throw new Error('the catalog is unreachable')
      },
    })

    await runner.prompt(CHAT, withImage('how much?'))
    expect(fake.agents.get('s1')?.prompts[0]).toContain('Contents of the image')
  })
})

describe('SessionRunner — an image read before the conversation sees it', () => {
  it('sends the reading, not the picture', async () => {
    const fake = fakeHost()
    await build(fake.host, ['s1'], () => VISION, reader()).prompt(CHAT, withImage('how much?'))

    expect(fake.agents.get('s1')?.prompts).toEqual([
      'how much?Contents of the image the user sent:\n\nRp 250.000',
    ])
  })

  it('leaves the conversation on its own model, which is the whole point', async () => {
    // The history never holds an image, so the conversation keeps the model it
    // was chosen for — and its tools with it.
    const fake = fakeHost()
    await build(fake.host, ['s1'], () => VISION, reader()).prompt(CHAT, withImage('how much?'))

    expect(fake.agents.get('s1')?.routes).toEqual([undefined])
  })

  it('does not mark the conversation, so later turns stay put too', async () => {
    const fake = fakeHost()
    const runner = build(fake.host, ['s1'], () => VISION, reader())

    await runner.prompt(CHAT, withImage('how much?'))
    await runner.prompt(CHAT, text('and the date?'))

    expect(fake.agents.get('s1')?.routes).toEqual([undefined, undefined])
    expect(bindings.forChat(CHAT)?.hasImages).not.toBe(true)
  })

  it('leaves a text-only prompt alone rather than paying for a reading', async () => {
    const resolve = vi.fn()
    const fake = fakeHost()
    await build(fake.host, ['s1'], () => VISION, {
      available: true,
      resolve,
    }).prompt(CHAT, text('just words'))

    expect(resolve).not.toHaveBeenCalled()
  })

  it('falls back to moving the conversation when no vision model is configured', async () => {
    const fake = fakeHost()
    await build(fake.host, ['s1'], () => VISION, reader({ available: false })).prompt(
      CHAT,
      withImage('look'),
    )

    expect(fake.agents.get('s1')?.prompts).toEqual(['look[image]'])
    expect(fake.agents.get('s1')?.routes).toEqual([VISION])
  })

  it('sends the picture through when the reading itself fails', async () => {
    // A failed reading must not fail the turn: the user still asked something.
    const fake = fakeHost()
    await build(fake.host, ['s1'], () => VISION, reader({ fails: true })).prompt(
      CHAT,
      withImage('look'),
    )

    expect(fake.agents.get('s1')?.prompts).toEqual(['look[image]'])
    expect(fake.agents.get('s1')?.routes).toEqual([VISION])
  })
})

describe('SessionRunner — the model an image turn runs on', () => {
  // These are the fallback path: what happens to a picture that reached the
  // conversation, because nothing could turn it into text first.

  it('moves a turn carrying an image onto the vision model', async () => {
    const fake = fakeHost()
    await build(fake.host, ['s1'], () => VISION).prompt(CHAT, withImage('why this error?'))

    expect(fake.agents.get('s1')?.routes).toEqual([VISION])
  })

  it('keeps the next text turn there too, because the log still holds the image', async () => {
    // Per-turn is not possible: the provider inspects the whole history, so
    // reverting would fail every following turn.
    const fake = fakeHost()
    const runner = build(fake.host, ['s1'], () => VISION)

    await runner.prompt(CHAT, withImage('why this error?'))
    await runner.prompt(CHAT, text('now fix it'))

    expect(fake.agents.get('s1')?.routes).toEqual([VISION, VISION])
  })

  it('leaves an image turn alone when no vision model is configured', async () => {
    const fake = fakeHost()
    await build(fake.host, ['s1']).prompt(CHAT, withImage('look'))

    expect(fake.agents.get('s1')?.routes).toEqual([undefined])
  })

  it('does not move a text turn even when a vision model is configured', async () => {
    const fake = fakeHost()
    await build(fake.host, ['s1'], () => VISION).prompt(CHAT, text('just words'))

    expect(fake.agents.get('s1')?.routes).toEqual([undefined])
  })

  it('reads the setting per prompt, so a change applies to the next turn', async () => {
    const fake = fakeHost()
    const routes = [VISION, { provider: 'other', model: 'newer' }]
    const runner = build(fake.host, ['s1'], () => routes.shift())

    await runner.prompt(CHAT, withImage('one'))
    await runner.prompt(CHAT, withImage('two'))

    expect(fake.agents.get('s1')?.routes).toEqual([VISION, { provider: 'other', model: 'newer' }])
  })
})

describe('SessionRunner — a session that has carried an image', () => {
  it('keeps every later turn on the vision model, however plain its text', async () => {
    // A provider checks the whole request history, so a session whose log
    // holds an image fails on a text-only model forever after.
    const fake = fakeHost()
    const runner = build(fake.host, ['s1'], () => VISION)

    await runner.prompt(CHAT, withImage('why this error?'))
    await runner.prompt(CHAT, text('now fix it'))
    await runner.prompt(CHAT, text('and add a test'))

    expect(fake.agents.get('s1')?.routes).toEqual([VISION, VISION, VISION])
  })

  it('remembers across a restart, since the log outlives the process', async () => {
    const first = fakeHost()
    await build(first.host, ['s1'], () => VISION).prompt(CHAT, withImage('look'))

    const second = fakeHost()
    await build(second.host, ['s9'], () => VISION).prompt(CHAT, text('plain words'))

    expect(second.agents.get('s1')?.routes).toEqual([VISION])
  })

  it('starts clean after /new, so a fresh session is cheap again', async () => {
    const fake = fakeHost()
    const runner = build(fake.host, ['s1', 's2'], () => VISION)

    await runner.prompt(CHAT, withImage('look'))
    await runner.reset(CHAT)
    await runner.prompt(CHAT, text('plain words'))

    expect(fake.agents.get('s2')?.routes).toEqual([undefined])
  })

  it('leaves a conversation that never carried an image alone', async () => {
    const fake = fakeHost()
    const runner = build(fake.host, ['s1'], () => VISION)

    await runner.prompt(CHAT, text('one'))
    await runner.prompt(CHAT, text('two'))

    expect(fake.agents.get('s1')?.routes).toEqual([undefined, undefined])
  })
})
