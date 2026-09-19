import { describe, expect, it } from 'vitest'

import { TurnBridge } from '../src/reply/turn-bridge.js'
import type { SessionEvent } from '../src/reply/turn-bridge.js'
import { canStreamTo } from '../src/reply/rich-stream.js'
import { describeToolCall, thinkingBlock } from '../src/reply/activity.js'
import type { RichChat } from '../src/reply/rich-stream.js'

/** A Bot API stand-in recording every rich call the bridge makes. */
function fakeChat() {
  const drafts: { draftId: number; markdown: string }[] = []
  const sent: string[] = []
  let nextId = 0

  const chat: RichChat = {
    async sendRichMessage(options) {
      sent.push(options.markdown)
      return { messageId: (nextId += 1) }
    },
    async sendRichMessageDraft(options) {
      drafts.push({ draftId: options.draftId, markdown: options.markdown })
    },
  }

  return {
    chat,
    drafts,
    sent,
    /** Nothing is posted before the reply now, so these stay empty. */
    placeholders: [] as string[],
    edits: [] as { messageId: number; markdown: string }[],
    /** The newest draft frame — what the user is watching mid-turn. */
    frame: () => drafts[drafts.length - 1]?.markdown,
    /** The finished reply. */
    final: () => sent[sent.length - 1],
  }
}

function build(options: { bound?: boolean; group?: boolean } = {}) {
  const chat = fakeChat()
  /** Every hold taken, and whether it has been let go. */
  const holds: { released: boolean }[] = []

  const bridge = new TurnBridge({
    chat: chat.chat,
    targetOf: (sessionId) =>
      options.bound === false || sessionId !== 'S' ? undefined : { chatId: '42' },
    canDraft: () => options.group !== true,
    throttleMs: 0,
    placeholder: '…',
    heartbeatMs: 0,
    typing: {
      hold() {
        const entry = { released: false }
        holds.push(entry)
        return () => void (entry.released = true)
      },
    },
  })

  return {
    bridge,
    chat,
    holds,
    /** Whether the chat is showing "typing…" right now. */
    typing: () => holds.some((entry) => !entry.released),
  }
}

const start: SessionEvent = { type: 'turn/start', data: { turn: 1 } }
const end: SessionEvent = { type: 'turn/end', data: { turn: 1 } }

const delta = (text: string, turn = 1): SessionEvent => ({
  type: 'assistant/chunk',
  data: { turn, chunk: { type: 'text-delta', text } },
})

describe('TurnBridge — streaming a turn', () => {
  it('sends nothing when the turn opens, since there is nothing to say yet', async () => {
    // An ellipsis posted here tells the user only that their message arrived,
    // which they already know. Telegram's own indicator covers this stretch.
    const { bridge, chat, typing } = build()
    await bridge.handle('S', start)

    expect(chat.drafts).toHaveLength(0)
    expect(chat.placeholders).toHaveLength(0)
    expect(typing()).toBe(true)
  })

  it('stops the indicator once the first frame is showing', async () => {
    const { bridge, typing } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', delta('Hello'))

    expect(typing()).toBe(false)
  })

  it('stops the indicator when a turn ends having shown nothing', async () => {
    // Otherwise a turn that answers with silence leaves the chat typing until
    // the backstop expires.
    const { bridge, typing } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', end)

    expect(typing()).toBe(false)
  })

  it('streams markdown verbatim, for Telegram to render', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', delta('Hello '))
    await bridge.handle('S', delta('**world**'))

    expect(chat.frame()).toBe('Hello **world**')
  })

  it('keeps one draft id for the turn, so frames animate together', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', delta('a'))
    await bridge.handle('S', delta('b'))

    expect(new Set(chat.drafts.map((d) => d.draftId)).size).toBe(1)
    expect(chat.drafts[0]?.draftId).not.toBe(0)
  })

  it('gives a later turn its own draft id, so it does not animate out of the last', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', delta('first'))
    await bridge.handle('S', end)
    await bridge.handle('S', { type: 'turn/start', data: { turn: 2 } })
    await bridge.handle('S', delta('second', 2))

    const ids = new Set(chat.drafts.map((d) => d.draftId))
    expect(ids.size).toBe(2)
  })

  it('persists the reply when the turn ends, since a draft is ephemeral', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', delta('done'))
    await bridge.handle('S', end)

    expect(chat.sent).toEqual(['done'])
    expect(bridge.isStreaming('S')).toBe(false)
  })

  it('prefers the assembled assistant message over the accumulated deltas', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', delta('partial'))
    await bridge.handle('S', {
      type: 'assistant/message',
      data: { turn: 1, message: { content: [{ type: 'text', text: 'the complete answer' }] } },
    })
    await bridge.handle('S', end)

    expect(chat.final()).toBe('the complete answer')
  })
})

describe('TurnBridge — what it filters out', () => {
  it('ignores sessions that are not bound to a chat', async () => {
    const { bridge, chat } = build({ bound: false })
    await bridge.handle('S', start)
    await bridge.handle('S', delta('text'))

    expect(chat.drafts).toHaveLength(0)
    expect(chat.sent).toHaveLength(0)
  })

  it('keeps the model\'s reasoning out of the chat', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', {
      type: 'assistant/chunk',
      data: { turn: 1, chunk: { type: 'reasoning-delta', text: 'let me think' } },
    })

    expect(chat.drafts.slice(1)).toHaveLength(0)
  })

  it('keeps tool-call fragments out of the chat', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', {
      type: 'assistant/chunk',
      data: { turn: 1, chunk: { type: 'tool-call-delta', text: '{"path":' } },
    })

    expect(chat.drafts.slice(1)).toHaveLength(0)
  })

  it('ignores events for a turn other than the open one', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', delta('from another turn', 9))

    expect(chat.drafts.slice(1)).toHaveLength(0)
  })

  it('ignores deltas with no open turn at all', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', delta('orphan'))
    expect(chat.drafts).toHaveLength(0)
  })

  it('ignores event types it does not consume', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', { type: 'tool/result', data: {} })
    expect(chat.drafts.slice(1)).toHaveLength(0)
  })
})

describe('TurnBridge — lifecycle', () => {
  it('closes a stranded turn when a new one opens', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', delta('first turn'))
    await bridge.handle('S', { type: 'turn/start', data: { turn: 2 } })

    // The stranded turn was persisted rather than left as an expiring draft.
    expect(chat.sent).toEqual(['first turn'])
    expect(bridge.isStreaming('S')).toBe(true)
  })

  it('closes open streams on dispose', async () => {
    const { bridge } = build()
    await bridge.handle('S', start)
    await bridge.dispose()
    expect(bridge.isStreaming('S')).toBe(false)
  })

  it('survives a chat failure without throwing at the harness', async () => {
    const bridge = new TurnBridge({
      chat: {
        sendRichMessage: async () => {
          throw new Error('telegram is down')
        },
        sendRichMessageDraft: async () => {
          throw new Error('telegram is down')
        },
        sendMessage: async () => {
          throw new Error('telegram is down')
        },
        editRichMessage: async () => undefined,
      },
      targetOf: () => ({ chatId: '42' }),
      canDraft: () => true,
      throttleMs: 0,
      heartbeatMs: 0,
    })

    await expect(bridge.handle('S', start)).resolves.toBeUndefined()
    await expect(bridge.handle('S', delta('text'))).resolves.toBeUndefined()
  })
})


describe('TurnBridge — groups, which have no draft api', () => {
  it('posts nothing while it works, so the room gets no orphan ellipsis', async () => {
    // The placeholder used to be a real message here, and a turn that produced
    // no text left it in the room forever.
    const { bridge, chat, typing } = build({ group: true })
    await bridge.handle('S', start)

    expect(chat.drafts).toHaveLength(0)
    expect(chat.placeholders).toHaveLength(0)
    expect(typing()).toBe(true)
  })

  it('does not stream, because there is nothing to stream into', async () => {
    const { bridge, chat } = build({ group: true })
    await bridge.handle('S', start)
    await bridge.handle('S', delta('working'))

    expect(chat.drafts).toHaveLength(0)
    expect(chat.edits).toHaveLength(0)
  })

  it('sends the finished reply as its first and only message', async () => {
    const { bridge, chat, typing } = build({ group: true })
    await bridge.handle('S', start)
    await bridge.handle('S', delta('the answer'))
    await bridge.handle('S', end)

    expect(chat.sent).toEqual(['the answer'])
    expect(chat.edits).toHaveLength(0)
    expect(typing()).toBe(false)
  })
})

describe('canStreamTo', () => {
  it('streams to a private chat when streaming is on', () => {
    expect(canStreamTo('562660734', true)).toBe(true)
  })

  it('does not stream when the operator switched it off', () => {
    // The switch used to be read as "which throttle to use", so turning it off
    // changed nothing at all.
    expect(canStreamTo('562660734', false)).toBe(false)
  })

  it('does not stream to a group even when streaming is on', () => {
    // Groups carry negative ids and have no draft API.
    expect(canStreamTo('-1001234567890', true)).toBe(false)
  })

  it('does not stream to a group with streaming off either', () => {
    expect(canStreamTo('-1001234567890', false)).toBe(false)
  })
})

describe('describeToolCall', () => {
  it('names the tool when its arguments say nothing useful', () => {
    expect(describeToolCall('todo_write', '{}')).toBe('todo_write')
  })

  it('shows the command a shell tool is about to run', () => {
    expect(describeToolCall('bash', '{"command":"npm test"}')).toBe('bash: npm test')
  })

  it('shows the file a read touches', () => {
    expect(describeToolCall('read', '{"file_path":"src/index.ts"}')).toBe('read: src/index.ts')
  })

  it('survives arguments that are still streaming in, and so are not json', () => {
    // Tool arguments arrive as deltas, so mid-call they are routinely partial.
    expect(describeToolCall('bash', '{"command":"npm te')).toBe('bash')
  })

  it('survives absent arguments', () => {
    expect(describeToolCall('bash', undefined)).toBe('bash')
  })

  it('keeps the line to one line, even for a multi-line command', () => {
    expect(describeToolCall('bash', '{"command":"one\\ntwo\\nthree"}')).toBe('bash: one')
  })

  it('clips a command too long to read at a glance', () => {
    const long = describeToolCall('bash', JSON.stringify({ command: 'x'.repeat(300) }))
    expect(long.length).toBeLessThanOrEqual(80)
    expect(long).toMatch(/…$/)
  })

  it('escapes markup, since a command is not markup', () => {
    expect(describeToolCall('bash', '{"command":"echo <b> && true"}')).toContain('&lt;b&gt;')
  })
})

describe('thinkingBlock', () => {
  it('wraps an activity line in the tag Telegram renders as thinking', () => {
    expect(thinkingBlock('bash: npm test')).toBe('<tg-thinking>bash: npm test</tg-thinking>')
  })

  it('produces nothing when there is no activity', () => {
    expect(thinkingBlock(undefined)).toBe('')
    expect(thinkingBlock('')).toBe('')
  })
})

describe('TurnBridge — showing what the agent is doing', () => {
  const toolCall = (name: string, args: string): SessionEvent => ({
    type: 'tool/call',
    data: { turn: 1, name, arguments: args },
  })

  it('shows the running tool above the reply', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', toolCall('bash', '{"command":"npm test"}'))

    expect(chat.frame()).toContain('<tg-thinking>bash: npm test</tg-thinking>')
  })

  it('updates the line as the agent moves to the next tool', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', toolCall('read', '{"file_path":"a.ts"}'))
    await bridge.handle('S', toolCall('bash', '{"command":"npm test"}'))

    expect(chat.frame()).toContain('bash: npm test')
    expect(chat.frame()).not.toContain('a.ts')
  })

  it('leaves the finished tool on screen rather than replacing it with less', async () => {
    // Telegram refuses an empty draft, so clearing the line with nothing to
    // put in its place used to mean drawing an ellipsis — trading the last
    // thing that happened for a frame that says nothing.
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', toolCall('bash', '{"command":"npm test"}'))
    await bridge.handle('S', { type: 'tool/result', data: { turn: 1 } })

    expect(chat.frame()).toContain('bash: npm test')
    expect(chat.drafts).toHaveLength(1)
  })

  it('clears the line as soon as there is text to replace it with', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', toolCall('bash', '{"command":"npm test"}'))
    await bridge.handle('S', { type: 'tool/result', data: { turn: 1 } })
    await bridge.handle('S', delta('All 42 passed'))

    expect(chat.frame()).not.toContain('tg-thinking')
    expect(chat.frame()).toContain('All 42 passed')
  })

  it('draws nothing at all when there is nothing to draw', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', { type: 'tool/result', data: { turn: 1 } })

    expect(chat.drafts).toHaveLength(0)
  })

  it('keeps the reply text alongside the activity line', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', delta('Here is what I found'))
    await bridge.handle('S', toolCall('bash', '{"command":"npm test"}'))

    expect(chat.frame()).toContain('Here is what I found')
    expect(chat.frame()).toContain('tg-thinking')
  })

  it('never puts the activity line in the persisted reply', async () => {
    // The block is accepted only in a draft, and the finished reply should
    // carry the answer rather than the scaffolding that produced it.
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', toolCall('bash', '{"command":"npm test"}'))
    await bridge.handle('S', delta('done'))
    await bridge.handle('S', end)

    expect(chat.sent).toEqual(['done'])
  })

  it('ignores tool events from another turn', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', {
      type: 'tool/call',
      data: { turn: 9, name: 'bash', arguments: '{}' },
    })

    expect(chat.drafts).toHaveLength(0)
  })

  it('shows nothing in a group, which has no draft to show it in', async () => {
    const { bridge, chat } = build({ group: true })
    await bridge.handle('S', start)
    await bridge.handle('S', toolCall('bash', '{"command":"npm test"}'))

    expect(chat.drafts).toHaveLength(0)
  })
})

describe('TurnBridge — a turn that failed', () => {
  const failed = (message: string, code?: string): SessionEvent => ({
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'error', error: { message, ...(code ? { code } : {}) } } },
  })

  it('says what failed, rather than going quiet', async () => {
    // A failed turn produces no reply, so silence reads as a broken bot.
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', failed('the model refused'))

    expect(chat.final()).toContain('the model refused')
  })

  it('keeps whatever had already streamed', async () => {
    const { bridge, chat } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', delta('Here is what I found'))
    await bridge.handle('S', failed('then it broke'))

    expect(chat.final()).toContain('Here is what I found')
    expect(chat.final()).toContain('then it broke')
  })

  it('hands the failure on, so recovery can be offered', async () => {
    const failures: { message: string; code?: string }[] = []
    const chat = fakeChat()
    const bridge = new TurnBridge({
      chat: chat.chat,
      targetOf: () => ({ chatId: '42' }),
      canDraft: () => true,
      throttleMs: 0,
      heartbeatMs: 0,
      onFailure: (_sessionId, failure) => failures.push(failure),
    })

    await bridge.handle('S', start)
    await bridge.handle('S', failed('no image input', 'UNSUPPORTED_CONTENT'))

    expect(failures).toEqual([{ message: 'no image input', code: 'UNSUPPORTED_CONTENT' }])
  })

  it('reports nothing for a turn that completed', async () => {
    const failures: unknown[] = []
    const chat = fakeChat()
    const bridge = new TurnBridge({
      chat: chat.chat,
      targetOf: () => ({ chatId: '42' }),
      canDraft: () => true,
      throttleMs: 0,
      heartbeatMs: 0,
      onFailure: (_s, failure) => failures.push(failure),
    })

    await bridge.handle('S', start)
    await bridge.handle('S', delta('done'))
    await bridge.handle('S', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

    expect(failures).toHaveLength(0)
    expect(chat.sent).toEqual(['done'])
  })

  it('closes the stream, so the next turn starts clean', async () => {
    const { bridge } = build()
    await bridge.handle('S', start)
    await bridge.handle('S', failed('broke'))
    expect(bridge.isStreaming('S')).toBe(false)
  })
})
