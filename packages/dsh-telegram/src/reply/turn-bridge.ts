/**
 * Turning the harness's session-event feed into a live Telegram reply.
 *
 * The harness publishes a durable log — `turn/start`, a run of
 * `assistant/chunk` deltas, `assistant/message`, `turn/end` — and every
 * consumer reads the same feed. This bridge subscribes for Telegram-bound
 * sessions only and drives one {@link ReplyStream} per open turn.
 *
 * Only visible model text is forwarded. Reasoning deltas and tool-call deltas
 * stay out of the chat: the first is the model thinking aloud, the second is
 * an argument fragment, and neither is an answer to the person waiting.
 *
 * `assistant/message` is treated as authoritative over the accumulated deltas.
 * A turn cancelled mid-stream still emits it with `interrupted: true`, and it
 * is the only place the finished text is guaranteed complete.
 */

import type { ChatTarget } from '../interact/surface.js'
import type { Logger } from '../harness/types.js'
import { SILENT_LOGGER } from '../harness/types.js'

import { describeToolCall } from './activity.js'
import { RichReplyStream } from './rich-stream.js'
import type { RichChat } from './rich-stream.js'

/** The session-event shapes this bridge reads. */
export type SessionEvent =
  | { readonly type: 'turn/start'; readonly data: { readonly turn: number } }
  | {
      readonly type: 'assistant/chunk'
      readonly data: {
        readonly turn: number
        readonly chunk: { readonly type: string; readonly text?: string }
      }
    }
  | {
      readonly type: 'assistant/message'
      readonly data: {
        readonly turn: number
        readonly message: { readonly content?: readonly { type: string; text?: string }[] }
      }
    }
  | {
      readonly type: 'tool/call'
      readonly data: { readonly turn: number; readonly name: string; readonly arguments?: string }
    }
  | { readonly type: 'tool/result'; readonly data: { readonly turn: number } }
  | {
      readonly type: 'turn/end'
      readonly data: {
        readonly turn: number
        readonly reason?: {
          readonly kind: string
          readonly error?: { message: string; code?: string }
        }
      }
    }
  | { readonly type: string; readonly data?: unknown }

/** Construction options. */
export interface TurnBridgeOptions {
  readonly chat: RichChat
  /** Resolve a session id to its chat, or undefined when it is not a Telegram one. */
  readonly targetOf: (sessionId: string) => ChatTarget | undefined
  /**
   * Whether a conversation can stream through drafts. Only private chats can:
   * `sendRichMessageDraft` takes a private chat id and nothing else.
   */
  readonly canDraft: (target: ChatTarget) => boolean
  readonly throttleMs?: number
  readonly heartbeatMs?: number
  /**
   * Called when a turn ends in failure.
   *
   * A failed turn produced no reply, so without this the conversation simply
   * goes quiet — which reads as a broken bot rather than as a refused request.
   */
  readonly onFailure?: (sessionId: string, failure: { message: string; code?: string }) => void
  /**
   * Keeps Telegram's own indicator alive from the moment a turn opens until it
   * has something to show. Absent leaves the chat quiet until the reply lands.
   */
  readonly typing?: { hold(target: ChatTarget): () => void }
  readonly logger?: Logger
}

/** One turn being streamed. */
interface ActiveTurn {
  readonly turn: number
  readonly stream: RichReplyStream
  /** Stops the typing indicator standing in until the reply appears. */
  readonly release: () => void
  /** Authoritative text from `assistant/message`, when it has arrived. */
  finalText?: string
}

export class TurnBridge {
  private readonly active = new Map<string, ActiveTurn>()
  private readonly logger: Logger

  constructor(private readonly options: TurnBridgeOptions) {
    this.logger = options.logger ?? SILENT_LOGGER
  }

  /**
   * Consume one session event.
   *
   * @param sessionId - the session the event belongs to.
   * @param event - the event from the harness feed.
   */
  async handle(sessionId: string, event: SessionEvent): Promise<void> {
    try {
      switch (event.type) {
        case 'turn/start':
          return await this.onTurnStart(sessionId, event as { data: { turn: number } })
        case 'assistant/chunk':
          return await this.onChunk(sessionId, event as never)
        case 'assistant/message':
          return this.onMessage(sessionId, event as never)
        case 'tool/call':
          return await this.onToolCall(sessionId, event as never)
        case 'tool/result':
          return await this.onToolResult(sessionId, event as never)
        case 'turn/end':
          return await this.onTurnEnd(sessionId, event as { data: { turn: number } })
        default:
          return
      }
    } catch (error) {
      this.logger.warn('[dsh-telegram] failed to stream a turn', error)
    }
  }

  /** Whether a turn is currently streaming for a session. */
  isStreaming(sessionId: string): boolean {
    return this.active.has(sessionId)
  }

  /** Close every open stream — the plugin is unloading mid-turn. */
  async dispose(): Promise<void> {
    const entries = [...this.active.values()]
    this.active.clear()
    for (const entry of entries) entry.release()
    await Promise.all(entries.map((entry) => entry.stream.finish().catch(() => undefined)))
  }

  /** Open a reply for a turn in a Telegram-bound session. */
  private async onTurnStart(sessionId: string, event: { data: { turn: number } }): Promise<void> {
    const target = this.options.targetOf(sessionId)
    if (!target) return

    // A previous turn that never closed would otherwise leak its stream.
    await this.closeActive(sessionId)

    // Taken before the stream exists, because the gap this covers starts here:
    // a turn can think, or sit in a tool call, long before it writes anything.
    const release = this.options.typing?.hold(target) ?? (() => undefined)

    const stream = new RichReplyStream({
      chat: this.options.chat,
      target,
      canDraft: this.options.canDraft(target),
      // The indicator is a stand-in, so it stops the moment there is something
      // real in its place.
      onVisible: release,
      // Stable for the turn, so Telegram animates one growing preview rather
      // than replacing it. Non-zero is required.
      draftId: draftIdFor(sessionId, event.data.turn),
      ...(this.options.throttleMs !== undefined ? { throttleMs: this.options.throttleMs } : {}),
      ...(this.options.heartbeatMs !== undefined ? { heartbeatMs: this.options.heartbeatMs } : {}),
      logger: this.logger,
    })

    this.active.set(sessionId, { turn: event.data.turn, stream, release })
    await stream.start()
  }

  /** Forward one visible text delta. */
  private async onChunk(
    sessionId: string,
    event: { data: { turn: number; chunk: { type: string; text?: string } } },
  ): Promise<void> {
    const entry = this.active.get(sessionId)
    if (!entry || entry.turn !== event.data.turn) return
    if (event.data.chunk.type !== 'text-delta') return

    await entry.stream.append(event.data.chunk.text ?? '')
  }

  /**
   * Say which tool is running.
   *
   * These events were previously dropped along with the reasoning deltas, on
   * the grounds that neither is an answer. That is true of the content and
   * wrong about the need: during a long tool call it is the only sign the
   * agent is alive.
   */
  private async onToolCall(
    sessionId: string,
    event: { data: { turn: number; name: string; arguments?: string } },
  ): Promise<void> {
    const entry = this.active.get(sessionId)
    if (!entry || entry.turn !== event.data.turn) return

    await entry.stream.showActivity(describeToolCall(event.data.name, event.data.arguments))
  }

  /** Clear the activity line once the tool has answered. */
  private async onToolResult(
    sessionId: string,
    event: { data: { turn: number } },
  ): Promise<void> {
    const entry = this.active.get(sessionId)
    if (!entry || entry.turn !== event.data.turn) return

    await entry.stream.showActivity(undefined)
  }

  /** Record the authoritative text for the turn. */
  private onMessage(
    sessionId: string,
    event: { data: { turn: number; message: { content?: readonly { type: string; text?: string }[] } } },
  ): void {
    const entry = this.active.get(sessionId)
    if (!entry || entry.turn !== event.data.turn) return

    const text = (event.data.message.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('')

    if (text !== '') entry.finalText = text
  }

  /** Deliver the finished reply, or say why there is none. */
  private async onTurnEnd(
    sessionId: string,
    event: {
      data: {
        turn: number
        reason?: { kind: string; error?: { message: string; code?: string } }
      }
    },
  ): Promise<void> {
    const entry = this.active.get(sessionId)
    if (!entry || entry.turn !== event.data.turn) return

    this.active.delete(sessionId)
    entry.release()

    const reason = event.data.reason
    if (reason?.kind === 'error') {
      const failure = reason.error ?? { message: 'the turn failed' }
      // Whatever streamed is kept: a turn can fail after saying something
      // useful, and discarding it would lose the only answer there was.
      await entry.stream.fail(new Error(failure.message))
      this.options.onFailure?.(sessionId, failure)
      return
    }

    await entry.stream.finish(entry.finalText)
  }

  /** Finish a stream left open by a turn that never ended. */
  private async closeActive(sessionId: string): Promise<void> {
    const entry = this.active.get(sessionId)
    if (!entry) return

    this.active.delete(sessionId)
    entry.release()
    await entry.stream.finish(entry.finalText).catch(() => undefined)
  }
}

/**
 * A draft id for one turn of one session.
 *
 * Telegram animates frames sharing an id, so it must be stable across a turn
 * and different between turns — otherwise a new reply would animate out of the
 * previous one. Derived rather than counted so a restart mid-conversation
 * cannot collide with an id already in flight.
 */
function draftIdFor(sessionId: string, turn: number): number {
  let hash = 0
  for (let index = 0; index < sessionId.length; index += 1) {
    hash = (hash * 31 + sessionId.charCodeAt(index)) | 0
  }
  // Non-zero and inside the safe integer range Telegram accepts.
  return Math.abs(hash % 1_000_000_000) * 1000 + (turn % 1000) + 1
}
