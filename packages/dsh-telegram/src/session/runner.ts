/**
 * One harness session per Telegram conversation.
 *
 * The lifecycle has three states and the transitions between them are the
 * whole job: a conversation with no session yet, one whose session is loaded
 * in this process, and one whose session exists only in the durable log
 * because the harness has restarted since.
 *
 * The third case is why `resume` exists and why a failed resume is not fatal.
 * A session log can be pruned, moved, or written by an incompatible version;
 * when it can no longer be loaded, the user gets a fresh conversation and a
 * note, which is far better than a bot that answers every message with the
 * same load error.
 *
 * The agent host is injected rather than reached for directly, so this logic
 * is exercised without a running harness.
 */

import { randomUUID } from 'node:crypto'

import type { ChatTarget } from '../interact/surface.js'
import type { PromptPart } from '../media/collect.js'
import type { ModelRoute } from '../harness/model-selection.js'
import type { AgentRunner } from '../router.js'
import type { Logger } from '../harness/types.js'
import { SILENT_LOGGER } from '../harness/types.js'

import { escapeHtml } from '../render/escape.js'

import type { BindingStore } from './bindings.js'

/** The first words of a prompt, for labelling the conversation in a list. */
function firstText(content: readonly PromptPart[]): string | undefined {
  const said = content.find((part) => part.type === 'text')
  return said?.type === 'text' && said.text.trim() !== '' ? said.text : undefined
}

/** Whether a prompt carries an image, which changes a conversation for good. */
function carriesImage(content: readonly PromptPart[]): boolean {
  return content.some((part) => part.type === 'image')
}

/** One line of a conversation's description. */
export interface StatusRow {
  readonly label: string
  readonly value: string
}

/** A live agent this plugin drives. */
export interface RunningAgent {
  readonly sessionId: string
  /** Queue a user message and wake the driver. */
  followup(content: readonly PromptPart[]): void
  /**
   * Route the next step onto another model, or back to the agent's own.
   *
   * @param route - the override, or undefined to drop it.
   * @returns whether the agent accepts an override at all; a borrowed agent,
   *   or a harness that offers no selection seam, does not.
   */
  useModel(route: ModelRoute | undefined): boolean
  /** Cancel the in-flight turn and any queued work. */
  cancel(reason: string): void
  /** Stop the agent and release its session. */
  dispose(): Promise<void>
}

/** Creating and loading agents — the harness surface, narrowed. */
export interface AgentHost {
  /** The agent for a session if it is already loaded in this process. */
  live(sessionId: string): RunningAgent | undefined
  /**
   * Start a new session and agent under `sessionId`.
   *
   * @param route - forces the model rather than taking the deployment's
   *   default. Used by the throwaway session an image is read in, which has to
   *   run somewhere that can see.
   */
  create(sessionId: string, cwd: string, route?: ModelRoute): Promise<RunningAgent>
  /** Load a persisted session; undefined when it can no longer be loaded. */
  resume(sessionId: string): Promise<RunningAgent | undefined>
}

/** Something that can replace an image in a prompt with what it says. */
export interface PromptResolver {
  /** Whether reading is possible at all right now. */
  readonly available: boolean
  resolve(content: readonly PromptPart[], route: ModelRoute | undefined): Promise<PromptPart[]>
}

/** Construction options. */
export interface SessionRunnerOptions {
  readonly host: AgentHost
  readonly bindings: BindingStore
  /**
   * The directory a conversation's next session opens in.
   *
   * Per conversation rather than one value, because `/cd` is per chat — and
   * read late, so a change reaches the next session rather than the next
   * restart. A session's own cwd never moves: the sandbox derives its writable
   * root from it and the harness calls that root immutable, which is why
   * changing directory starts a fresh conversation.
   */
  readonly cwdFor: (target: ChatTarget) => string
  /** Session id factory; injected so tests can assert on stable ids. */
  readonly newSessionId?: () => string
  /**
   * Puts a session on the conversation's permission preset.
   *
   * Applied to a resumed session as well as a new one: the preset is a
   * property of the surface the conversation arrives over, and a session that
   * outlived a restart is still that conversation.
   */
  readonly permission?: { apply(target: ChatTarget, sessionId: string): void }
  /**
   * Remembers which conversations this chat has had, so `/sessions` can offer
   * one back. Absent makes `/new` the one-way door it used to be.
   */
  readonly history?: {
    remember(
      target: ChatTarget,
      session: { sessionId: string; startedAt: number; cwd: string; label?: string },
    ): Promise<void>
  }
  /**
   * Reads an image with a vision model so the conversation receives text.
   *
   * This is what keeps a conversation on its own model: a provider inspects
   * the whole request history, so an image that reaches the conversation binds
   * it to a model that can see for as long as it lives.
   */
  readonly extractor?: PromptResolver
  /**
   * Whether the model this conversation runs on reads images itself.
   *
   * When it does, extraction is not merely unnecessary — it is worse. The
   * conversation would receive a transcription instead of the picture, so a
   * diagram, a chart or a misaligned layout becomes scattered words, and the
   * model never gets to look at the thing it was asked about.
   *
   * The indirection exists because a provider inspects the whole request
   * history: an image left in a conversation binds it to a model that can see.
   * When that model IS the one the conversation chose, there is nothing to be
   * stuck on and nothing to work around.
   */
  readonly modelSees?: (target: ChatTarget) => Promise<boolean>
  /**
   * The model this conversation reads images with.
   *
   * Per conversation because `/vision` is, and read late so a change lands on
   * the next such turn. It is also what a conversation moves onto when the
   * picture could not be read and had to go through as it was.
   */
  readonly visionRoute?: (target: ChatTarget) => ModelRoute | undefined
  /**
   * The model this conversation chose, if it chose one.
   *
   * Read per prompt rather than at session creation, because the harness reads
   * a mutable selection while assembling each step — which is what lets
   * `/model` take effect on the very next message rather than the next `/new`.
   */
  readonly chosenRoute?: (target: ChatTarget) => ModelRoute | undefined
  readonly logger?: Logger
}

export class SessionRunner implements AgentRunner {
  private readonly logger: Logger
  private readonly newSessionId: () => string
  /** Serialises work per conversation, so two fast messages cannot both create. */
  private readonly chains = new Map<string, Promise<unknown>>()

  constructor(private readonly options: SessionRunnerOptions) {
    this.logger = options.logger ?? SILENT_LOGGER
    this.newSessionId = options.newSessionId ?? (() => `tg-${randomUUID()}`)
  }

  /**
   * Deliver a prompt, opening or resuming the conversation's session first.
   *
   * @param target - the conversation the prompt came from.
   * @param text - what the user typed.
   */
  async prompt(target: ChatTarget, content: readonly PromptPart[]): Promise<void> {
    if (content.length === 0) return

    // Asked once and used three times: whether to read the picture elsewhere,
    // whether to refuse it, and whether to move the conversation off its own
    // model. A model that can look wants none of that done for it.
    const sees = (await this.options.modelSees?.(target).catch(() => false)) === true

    // Resolved before the conversation's agent is touched at all, and outside
    // the serialisation: reading an image takes a model call, and holding the
    // conversation's queue for it would stall every later message behind it.
    const resolved = sees ? [...content] : await this.resolve(target, content)
    if (resolved.length === 0) return

    await this.serialize(target, async () => {
      const agent = await this.agentFor(target)

      // Only reached when an image survived resolution. Set before the prompt:
      // the harness reads the selection while assembling each step, so the
      // override must be in place by the time the turn runs.
      agent.useModel(this.routeFor(target, resolved, sees))

      // Recorded BEFORE the turn runs, because from this point the session's
      // log carries an image and every later turn must be routed for it.
      if (carriesImage(resolved)) await this.options.bindings.markImages(target)

      // Recorded with the prompt rather than at creation, because the opening
      // words are what make the conversation recognisable in a list.
      await this.options.history
        ?.remember(target, {
          sessionId: agent.sessionId,
          startedAt: Date.now(),
          cwd: this.options.cwdFor(target),
          ...(firstText(resolved) === undefined ? {} : { label: firstText(resolved) as string }),
        })
        .catch(() => undefined)

      agent.followup(resolved)
    })
  }

  /**
   * Turn images into text, where there is anything able to do it.
   *
   * A failure here is not the turn's failure: the picture simply goes through
   * as it is, and the conversation moves to a model that can see it.
   */
  private async resolve(
    target: ChatTarget,
    content: readonly PromptPart[],
  ): Promise<PromptPart[]> {
    const extractor = this.options.extractor
    if (!extractor?.available || !carriesImage(content)) return [...content]

    try {
      return await extractor.resolve(content, this.options.visionRoute?.(target))
    } catch (error) {
      this.logger.warn('[dsh-telegram] could not read an image; sending it as it is', error)
      return [...content]
    }
  }

  /**
   * Which model this conversation's next step must run on.
   *
   * Not a per-turn choice, though it looks like one. A provider checks the
   * WHOLE request history for images, so once a session's log carries one,
   * every later turn — however plain its own text — fails on a model that
   * cannot see. The override therefore sticks to the conversation from the
   * first image until it is reset with `/new`.
   */
  private routeFor(
    target: ChatTarget,
    content: readonly PromptPart[],
    sees: boolean,
  ): ModelRoute | undefined {
    // The conversation's own choice always applies. Dropping it here is what
    // made a model chosen with `/model` fall back to the deployment default —
    // and since that choice is the whole reason the model could see, the check
    // for "it can see" was undoing the thing it had just observed.
    const chosen = this.options.chosenRoute?.(target)
    if (sees) return chosen

    const carried = this.options.bindings.forChat(target)?.hasImages === true

    // An image outranks the conversation's own choice: a model that cannot see
    // fails the whole request, so this is not a preference to honour.
    if (carriesImage(content) || carried) return this.options.visionRoute?.(target) ?? chosen

    return chosen
  }

  /**
   * Point a conversation at a session it had before.
   *
   * The session is not loaded here: the next message resumes it through the
   * ordinary path, which is also the path that handles a log that can no
   * longer be read.
   *
   * @param target - the conversation.
   * @param sessionId - a session this chat had earlier.
   */
  async adopt(target: ChatTarget, sessionId: string): Promise<void> {
    await this.serialize(target, async () => {
      const binding = this.options.bindings.forChat(target)
      if (binding?.sessionId === sessionId) return

      // Released rather than disposed: the conversation being left is one the
      // user may well come back to, and disposing would end it.
      await this.options.bindings.bind(target, sessionId)
    })
  }

  /**
   * Forget the conversation's session so the next prompt opens a new one.
   *
   * @param target - the conversation to reset.
   */
  async reset(target: ChatTarget): Promise<void> {
    await this.serialize(target, async () => {
      const binding = this.options.bindings.forChat(target)
      if (!binding) return

      const live = this.options.host.live(binding.sessionId)
      if (live) await live.dispose().catch((error: unknown) => {
        this.logger.warn('[dsh-telegram] could not dispose the previous agent', error)
      })

      await this.options.bindings.unbind(target)
    })
  }

  /**
   * Cancel whatever the conversation's agent is doing.
   *
   * @returns whether there was a loaded agent to cancel.
   */
  async stop(target: ChatTarget): Promise<boolean> {
    const binding = this.options.bindings.forChat(target)
    if (!binding) return false

    const live = this.options.host.live(binding.sessionId)
    if (!live) return false

    live.cancel('stopped from Telegram')
    return true
  }

  /**
   * Describe the conversation as rows, for the caller to render.
   *
   * Rows rather than finished markup, because the caller adds its own — the
   * model, the effort, what the agent may do — and stitching those onto a
   * rendered string would mean parsing it back apart.
   */
  async status(target: ChatTarget): Promise<StatusRow[]> {
    const directory = this.options.cwdFor(target)
    const binding = this.options.bindings.forChat(target)

    // Worth naming the directory even with no conversation: it is what the
    // next message opens in, and `/cd` before the first message is reasonable.
    if (!binding) {
      return [
        { label: 'Session', value: 'none yet — send a message to start one' },
        { label: 'Directory', value: directory },
      ]
    }

    const live = this.options.host.live(binding.sessionId) !== undefined
    return [
      { label: 'Session', value: binding.sessionId },
      { label: 'Directory', value: directory },
      { label: 'State', value: live ? 'loaded' : 'idle, resumes on your next message' },
      {
        label: 'Since',
        value: new Date(binding.createdAt).toISOString().replace('T', ' ').slice(0, 16),
      },
    ]
  }

  /**
   * The agent for a conversation: loaded, resumed, or freshly created.
   *
   * A binding whose session cannot be resumed is replaced rather than
   * reported: the user's next message should work.
   */
  private async agentFor(target: ChatTarget): Promise<RunningAgent> {
    const binding = this.options.bindings.forChat(target)

    if (binding) {
      const live = this.options.host.live(binding.sessionId)
      if (live) return live

      const resumed = await this.options.host.resume(binding.sessionId).catch((error: unknown) => {
        this.logger.warn(`[dsh-telegram] could not resume '${binding.sessionId}'`, error)
        return undefined
      })
      if (resumed) {
        this.options.permission?.apply(target, resumed.sessionId)
        return resumed
      }

      this.logger.warn(
        `[dsh-telegram] session '${binding.sessionId}' is gone; starting a fresh conversation`,
      )
      await this.options.bindings.unbind(target)
    }

    const sessionId = this.newSessionId()
    const cwd = this.options.cwdFor(target)
    const agent = await this.options.host.create(sessionId, cwd)

    // After creation, because the harness pins an initial permission before
    // publishing the session; switching afterwards is the supported path.
    this.options.permission?.apply(target, sessionId)

    await this.options.bindings.bind(target, sessionId)
    await this.options.history
      ?.remember(target, { sessionId, startedAt: Date.now(), cwd })
      .catch((error: unknown) => {
        // Losing the entry costs a way back to this conversation, not the
        // conversation itself.
        this.logger.warn('[dsh-telegram] could not record the conversation', error)
      })

    return agent
  }

  /**
   * Run one conversation's work after its previous work.
   *
   * Two messages arriving in the same poll batch would otherwise both see no
   * binding and both create a session, orphaning the first.
   */
  private serialize<T>(target: ChatTarget, task: () => Promise<T>): Promise<T> {
    const key = target.threadId === undefined ? target.chatId : `${target.chatId}#${target.threadId}`
    const previous = this.chains.get(key) ?? Promise.resolve()
    const next = previous.then(task, task)

    this.chains.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }
}
