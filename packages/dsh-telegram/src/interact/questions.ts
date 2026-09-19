/**
 * Answering the agent's questions from Telegram.
 *
 * This is the half of the plugin that has no equivalent in the existing
 * channel bridge. When the agent calls `ask_user_question`, the harness blocks
 * the tool call on `ctx.userQuestions.ask()` and waits for the single
 * registered UI provider to return an answer. Until now that provider was
 * always the browser, so a conversation held entirely in Telegram would stall
 * on the first question with no way to answer it.
 *
 * This provider renders each question as a message with an inline keyboard,
 * parks the promise, and resolves it when a button is pressed — minutes later,
 * in a different HTTP request, possibly on a different device.
 *
 * Two details are load-bearing:
 *
 * - **Delegation.** The harness allows exactly one provider. When the browser
 *   already registered one, this provider takes over and forwards every
 *   question that does not belong to a Telegram-bound session back to it, so
 *   installing this plugin never takes the web UI's questions away.
 * - **Multi-select re-parks.** A toggle is not an answer, so each press settles
 *   its waiter and opens a fresh one for the redrawn keyboard. The token
 *   changes every round, which also makes a stale button inert.
 */

import { escapeHtml } from '../render/escape.js'
import { clamp, escapeWithin } from '../render/clamp.js'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
  UserQuestionProvider,
  UserQuestionRequest,
} from '../harness/types.js'
import type { InlineButton, InlineKeyboard } from '../telegram/types.js'

import type { ChatSurface, ChatTarget } from './surface.js'
import type { PendingRegistry } from './pending.js'

/** Prefix marking callback data as belonging to a question. */
const KIND = 'q'

/** Index reserved for the "answer in your own words" button. */
const OTHER_INDEX = -1

/** Index reserved for the multi-select "Done" button. */
const DONE_INDEX = -2

/** Telegram truncates long button labels awkwardly; do it deliberately instead. */
const MAX_BUTTON_LABEL = 48

/**
 * Budgets for the model-authored parts of a prompt. Together with the option
 * cap below they keep the assembled message inside Telegram's 4096-character
 * limit, so a verbose question can never become a question nobody is shown.
 */
const HEADER_BUDGET = 120
const QUESTION_BUDGET = 1200
const DESCRIPTION_BUDGET = 220
/** Descriptions rendered in the body; the rest are still selectable buttons. */
const MAX_DESCRIBED_OPTIONS = 8

/** Thrown when the agent abandons a question before the user answers it. */
export class QuestionCancelledError extends Error {
  constructor() {
    super('ask_user_question was cancelled before the user answered')
    this.name = 'QuestionCancelledError'
  }
}

/** Thrown when a question arrives for a session with nowhere to ask it. */
export class NoChatError extends Error {
  constructor(sessionId: string) {
    super(`no telegram chat is bound to session '${sessionId}'`)
    this.name = 'NoChatError'
  }
}

/** What one button press means. */
interface Press {
  readonly token: string
  readonly index: number
}

/** Everything the provider needs from the rest of the plugin. */
export interface QuestionProviderOptions {
  /** Where prompts are posted and revised. */
  readonly surface: ChatSurface
  /** Parked waiters, shared with the update dispatcher that routes presses. */
  readonly pending: PendingRegistry<unknown>
  /** Resolve a session id to its Telegram chat, or undefined when unbound. */
  readonly targetOf: (sessionId: string) => ChatTarget | undefined
  /** Read the next plain-text message in a chat — the "Other" answer path. */
  readonly readText: (target: ChatTarget, signal?: AbortSignal) => Promise<string | undefined>
  /** The provider registered before this one; receives every non-Telegram question. */
  readonly fallback?: UserQuestionProvider
}

export class TelegramQuestionProvider implements UserQuestionProvider {
  /**
   * Where non-Telegram questions go. Settable after construction because the
   * incumbent provider is only knowable at the moment this one displaces it.
   */
  private fallback: UserQuestionProvider | undefined

  constructor(private readonly options: QuestionProviderOptions) {
    this.fallback = options.fallback
  }

  /**
   * Point delegation at the provider this one displaced.
   *
   * @param provider - the incumbent, which keeps answering its own sessions.
   */
  setFallback(provider: UserQuestionProvider | undefined): void {
    this.fallback = provider
  }

  /**
   * Ask the human, one question at a time.
   *
   * @param request - the questions, the owning agent, and the agent's signal.
   * @returns the answers, in request order.
   * @throws {NoChatError} when the session has no Telegram chat and no
   *   provider to delegate to.
   * @throws {QuestionCancelledError} when the agent gives up first.
   */
  async ask(request: UserQuestionRequest): Promise<AskUserQuestionAnswer> {
    const sessionId = request.agent?.session.id ?? request.agent?.id
    const target = sessionId === undefined ? undefined : this.options.targetOf(sessionId)

    if (!target) {
      if (this.fallback) return this.fallback.ask(request)
      throw new NoChatError(sessionId ?? '<unknown>')
    }

    const answers: AskUserQuestionAnswerItem[] = []
    for (const question of request.questions) {
      answers.push(await this.askOne(question, target, request.signal))
    }
    return { answers }
  }

  /**
   * Route one button press.
   *
   * @param data - raw `callback_data` from the update.
   * @returns whether the press belonged to an open question.
   */
  handleCallback(data: string | undefined): boolean {
    const press = decodeCallback(data)
    if (!press) return false
    return this.options.pending.settle(press.token, press)
  }

  /** Ask one question and hold the chat open until it is answered. */
  private async askOne(
    question: AskUserQuestionItem,
    target: ChatTarget,
    signal: AbortSignal | undefined,
  ): Promise<AskUserQuestionAnswerItem> {
    if (question.detail !== undefined) {
      // Agent-authored markdown — a plan, a diff — so Telegram renders it.
      await this.options.surface.sendMarkdown(target, question.detail)
    }

    const options = question.options ?? []
    if (options.length === 0) return this.askFreeText(question, target, signal)

    let selected: number[] = []
    let messageId: number | undefined

    for (;;) {
      const waiter = this.options.pending.open({
        ...(signal ? { signal } : {}),
        onCancel: () => void this.retire(target, messageId, question, 'Cancelled.'),
      })

      const html = renderPrompt(question, selected)
      const keyboard = buildKeyboard(question, selected, waiter.token)

      if (messageId === undefined) messageId = await this.options.surface.send(target, html, keyboard)
      else await this.options.surface.edit(target, messageId, html, keyboard)

      const press = (await waiter.promise) as Press | undefined
      if (!press) throw new QuestionCancelledError()

      if (press.index === OTHER_INDEX) {
        const custom = await this.options.readText(target, signal)
        if (custom === undefined) throw new QuestionCancelledError()
        await this.retire(target, messageId, question, `Answered: ${clamp(custom, 200)}`)
        return { id: question.id, selected: [], custom }
      }

      if (press.index === DONE_INDEX) {
        const labels = selected.map((index) => options[index]?.label ?? '')
        await this.retire(target, messageId, question, summary(labels))
        return { id: question.id, selected: labels }
      }

      if (!question.multiSelect) {
        const label = options[press.index]?.label
        if (label === undefined) continue
        await this.retire(target, messageId, question, summary([label]))
        return { id: question.id, selected: [label] }
      }

      selected = toggle(selected, press.index)
    }
  }

  /** A question with no options is an open one: read the user's next message. */
  private async askFreeText(
    question: AskUserQuestionItem,
    target: ChatTarget,
    signal: AbortSignal | undefined,
  ): Promise<AskUserQuestionAnswerItem> {
    await this.options.surface.send(target, renderPrompt(question, []))
    const custom = await this.options.readText(target, signal)
    if (custom === undefined) throw new QuestionCancelledError()
    return { id: question.id, selected: [], custom }
  }

  /** Replace a prompt with its outcome and take the buttons away. */
  private async retire(
    target: ChatTarget,
    messageId: number | undefined,
    question: AskUserQuestionItem,
    outcome: string,
  ): Promise<void> {
    if (messageId === undefined) return
    const html = `${renderPrompt(question, [])}\n\n<b>${escapeWithin(outcome, 400)}</b>`
    await this.options.surface.edit(target, messageId, html, []).catch(() => undefined)
  }
}

/**
 * Decode `callback_data` produced by this module.
 *
 * @param data - raw callback data, from an untrusted update.
 * @returns the press, or undefined when the data belongs elsewhere or is malformed.
 */
export function decodeCallback(data: string | undefined): Press | undefined {
  if (data === undefined) return undefined

  const parts = data.split(':')
  if (parts.length !== 3 || parts[0] !== KIND) return undefined

  const token = parts[1] as string
  const index = Number(parts[2])
  if (token === '' || !Number.isInteger(index)) return undefined

  return { token, index }
}

/** Add or remove an index, preserving the order options were chosen in. */
function toggle(selected: readonly number[], index: number): number[] {
  return selected.includes(index)
    ? selected.filter((value) => value !== index)
    : [...selected, index]
}

/** The question itself: header, prompt, and any option descriptions. */
function renderPrompt(question: AskUserQuestionItem, selected: readonly number[]): string {
  const lines: string[] = []

  if (question.header) lines.push(`<b>${escapeWithin(question.header, HEADER_BUDGET)}</b>`)
  lines.push(escapeWithin(question.question, QUESTION_BUDGET))

  const described = (question.options ?? [])
    .filter((option) => option.description)
    .slice(0, MAX_DESCRIBED_OPTIONS)

  if (described.length > 0) {
    lines.push('')
    for (const option of described) {
      lines.push(
        `• <b>${escapeWithin(option.label, MAX_BUTTON_LABEL * 2)}</b> — ` +
          `${escapeWithin(option.description as string, DESCRIPTION_BUDGET)}`,
      )
    }
  }

  if (question.multiSelect) {
    lines.push('')
    lines.push(`<i>Pick any number, then press Done (${selected.length} selected).</i>`)
  }

  return lines.join('\n')
}

/** Buttons for one question: the options, plus Done and Other where they apply. */
function buildKeyboard(
  question: AskUserQuestionItem,
  selected: readonly number[],
  token: string,
): InlineKeyboard {
  const approve = question.intent?.approve
  const rows: InlineButton[][] = (question.options ?? []).map((option, index) => [
    {
      text: label(option.label, {
        checked: question.multiSelect === true && selected.includes(index),
        approving: approve !== undefined && option.label === approve,
      }),
      callbackData: `${KIND}:${token}:${index}`,
    },
  ])

  if (question.multiSelect) {
    rows.push([{ text: '✅ Done', callbackData: `${KIND}:${token}:${DONE_INDEX}` }])
  } else {
    rows.push([{ text: '✏️ Other…', callbackData: `${KIND}:${token}:${OTHER_INDEX}` }])
  }

  return rows
}

/** One button label: trimmed to length, marked as chosen or as the approval. */
function label(text: string, marks: { checked: boolean; approving: boolean }): string {
  const trimmed = text.length > MAX_BUTTON_LABEL ? `${text.slice(0, MAX_BUTTON_LABEL - 1)}…` : text
  if (marks.checked) return `✅ ${trimmed}`
  if (marks.approving) return `👍 ${trimmed}`
  return trimmed
}

/** Human summary of what was chosen, for the retired prompt. */
function summary(labels: readonly string[]): string {
  return labels.length === 0 ? 'Answered: nothing selected' : `Answered: ${labels.join(', ')}`
}
