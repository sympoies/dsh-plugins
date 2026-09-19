/**
 * Picking up a conversation that `/new` left behind.
 *
 * The harness keeps every session's log, but the binding naming the current
 * one is replaced, so from a phone `/new` is a one-way door: someone who
 * starts a fresh conversation to ask one quick thing loses the one they were
 * in the middle of.
 *
 * Offered as buttons rather than as `/resume 3`, for the same reason the
 * recovery offer is: the list is already on screen, and asking someone to read
 * an index off it and type a number back is asking them to do a computer's
 * job. It also means there is nothing to mistype.
 */

import { escapeHtml } from '../render/escape.js'
import type { ChatSurface, ChatTarget } from '../interact/surface.js'
import type { PendingRegistry } from '../interact/pending.js'
import type { Logger } from '../harness/types.js'
import { SILENT_LOGGER } from '../harness/types.js'

import type { ChatHistory, PastSession } from './history.js'

/** Prefix marking callback data as belonging to a session picker. */
const KIND = 's'

/** How many to offer; Telegram keyboards get unusable long before this. */
const OFFER = 8

/** Everything the picker needs from the rest of the plugin. */
export interface SessionPickerOptions {
  readonly surface: ChatSurface
  readonly pending: PendingRegistry<unknown>
  readonly history: ChatHistory
  /** The session this conversation is on now, so it is not offered to itself. */
  readonly currentSession: (target: ChatTarget) => string | undefined
  /** Point the conversation at an existing session. */
  readonly adopt: (target: ChatTarget, sessionId: string) => Promise<void>
  readonly logger?: Logger
}

export class SessionPicker {
  private readonly logger: Logger

  constructor(private readonly options: SessionPickerOptions) {
    this.logger = options.logger ?? SILENT_LOGGER
  }

  /**
   * Offer this chat's earlier conversations.
   *
   * @param target - the conversation asking.
   */
  async offer(target: ChatTarget): Promise<void> {
    const current = this.options.currentSession(target)
    const past = this.options
      .history.forChat(target)
      .filter((entry) => entry.sessionId !== current)
      .slice(0, OFFER)

    if (past.length === 0) {
      await this.say(
        target,
        current === undefined
          ? 'No conversations yet — send a message to start one.'
          : 'This is the only conversation in this chat so far.',
      )
      return
    }

    const waiter = this.options.pending.open({})
    const keyboard = past.map((entry, index) => [
      {
        text: labelOf(entry),
        callbackData: `${KIND}:${waiter.token}:${index}`,
      },
    ])

    await this.say(
      target,
      [
        '<b>Earlier conversations</b>',
        '',
        'Pick one to carry on with. The one you are in now stays where it is.',
      ].join('\n'),
      keyboard,
    )

    const pressed = await waiter.promise
    if (typeof pressed !== 'string') return

    const index = Number.parseInt(pressed, 10)
    const chosen = past[index]
    if (!chosen) return

    try {
      await this.options.adopt(target, chosen.sessionId)
      await this.say(
        target,
        `↩️ Back in <b>${escapeHtml(labelOf(chosen))}</b>.\n\n` +
          `<code>${escapeHtml(chosen.cwd)}</code>`,
      )
    } catch (error) {
      this.logger.error('[dsh-telegram] could not adopt an earlier session', error)
      await this.say(target, '⚠️ That conversation could not be reopened.')
    }
  }

  /**
   * Route one button press.
   *
   * @param data - raw `callback_data` from the update.
   * @returns whether the press belonged to an open picker.
   */
  handleCallback(data: string | undefined): boolean {
    if (data === undefined) return false

    const parts = data.split(':')
    if (parts.length !== 3 || parts[0] !== KIND) return false

    const token = parts[1] as string
    const index = parts[2] as string
    if (token === '' || !/^\d+$/.test(index)) return false

    return this.options.pending.settle(token, index)
  }

  /** Post one message, swallowing delivery failures. */
  private async say(
    target: ChatTarget,
    html: string,
    keyboard?: { text: string; callbackData: string }[][],
  ): Promise<void> {
    try {
      await this.options.surface.send(target, html, keyboard)
    } catch (error) {
      this.logger.warn('[dsh-telegram] could not offer the session list', error)
    }
  }
}

/** A button label: what the conversation opened with, or when it started. */
function labelOf(entry: PastSession): string {
  if (entry.label !== undefined && entry.label !== '') return entry.label
  return new Date(entry.startedAt).toISOString().slice(0, 16).replace('T', ' ')
}
