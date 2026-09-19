/**
 * Routing one incoming Telegram update.
 *
 * Every update arrives here and leaves as exactly one of: a refusal, a
 * command, an answer to a pending prompt, a button press, or a prompt for the
 * agent. The order those are tried in is the whole design:
 *
 * 1. **Access first.** Nothing else runs for a user who is not allowed, so no
 *    unauthorised text ever reaches the agent, not even as a command.
 * 2. **Pending prompts before commands.** If a question is waiting for typed
 *    input, that is what the user is answering — routing it to the agent as a
 *    new prompt would strand the question forever.
 * 3. **Commands before prompts.** Otherwise `/new` would be a message asking
 *    the agent about the word "new".
 *
 * Failures are reported into the chat rather than thrown: an update handler
 * that throws would abort the long-poll loop and take the bot offline.
 */

import { COMMANDS, helpText, parseCommand } from './commands.js'
import { AlbumBuffer, captionOf } from './telegram/albums.js'
import { addressesBot, isGroupChat, stripMention } from './telegram/addressing.js'
import { escapeHtml } from './render/escape.js'
import type { AccessPolicy } from './access.js'
import type { ChatTarget } from './interact/surface.js'
import type { TextCapture } from './interact/text-capture.js'
import type { Logger } from './harness/types.js'
import { SILENT_LOGGER } from './harness/types.js'
import type { MediaCollector, PromptPart } from './media/collect.js'
import type { TelegramMessage, TelegramUpdate } from './telegram/types.js'
import type { StatusRow } from './session/runner.js'

/** What the router needs to drive a conversation's agent. */
export interface AgentRunner {
  /** Deliver a prompt, starting or resuming the chat's session as needed. */
  prompt(target: ChatTarget, content: readonly PromptPart[]): Promise<void>
  /** Forget the current session so the next prompt opens a fresh one. */
  reset(target: ChatTarget): Promise<void>
  /** Cancel the in-flight turn; resolves to whether anything was running. */
  stop(target: ChatTarget): Promise<boolean>
  /** What this conversation is, as rows the caller renders. */
  status(target: ChatTarget): Promise<StatusRow[]>
}

/** The bits of the Bot API the router itself uses. */
export interface RouterChat {
  sendMessage(options: { chatId: string; html: string; threadId?: number }): Promise<unknown>
  answerCallbackQuery(id: string, text?: string): Promise<void>
  /**
   * Post markdown for Telegram to render. Absent on a deployment below Bot API
   * 10.1, where a table would arrive as pipes and dashes.
   */
  sendRichMessage?(options: {
    chatId: string
    markdown: string
    threadId?: number
  }): Promise<{ messageId: number }>
}

/**
 * The conversation's working directory, and how to change it.
 *
 * Narrowed to what the router needs so `/cd` is testable without a filesystem:
 * `inspect` is the only call that touches disk.
 */
export interface WorkspaceControl {
  /** The directory this conversation's next session will open in. */
  current(target: ChatTarget): string
  /** Work out which directory an argument names; undefined when it names none. */
  resolve(input: string, current: string): string | undefined
  /** What is actually at that path. */
  inspect(directory: string): Promise<'directory' | 'file' | 'missing' | 'denied'>
  /** Remember it for this conversation. */
  set(target: ChatTarget, directory: string): Promise<void>
}

/**
 * The conversation's model, and how to change it.
 *
 * Narrowed to what the router needs, so `/model` is testable without a
 * provider catalog behind it.
 */
export interface ModelControl {
  /**
   * What lies underneath this conversation's choice, when it has made one.
   *
   * Two surfaces show related state — this command and the settings page —
   * and neither used to admit the other existed. Saying which layer is
   * answering is what stops the page looking like it is lying.
   */
  origin?(target: ChatTarget): string | undefined
  /** The route in force, rendered the way it is typed back in. */
  describe(target: ChatTarget): string
  /** Every configured provider and model, as Telegram HTML. */
  list(): Promise<string>
  /** Take a user's words and, when they name one model, adopt it. */
  choose(
    target: ChatTarget,
    input: string,
  ): Promise<
    | { kind: 'route'; route: string }
    | { kind: 'ambiguous'; candidates: readonly string[] }
    | { kind: 'unknown' }
  >
  /** Return the conversation to the deployment's own model. */
  clear(target: ChatTarget): Promise<void>
}

/** The conversation's reasoning effort, and how to change it. */
export interface EffortControl {
  /**
   * What lies underneath this conversation's choice, when it has made one.
   *
   * Two surfaces show related state — this command and the settings page —
   * and neither used to admit the other existed. Saying which layer is
   * answering is what stops the page looking like it is lying.
   */
  origin?(target: ChatTarget): string | undefined
  /** The effort in force, in words. */
  describe(target: ChatTarget): string
  /** The model it belongs to, for naming it in a refusal. */
  model(target: ChatTarget): string
  /** What that model offers; empty when it offers no choice. */
  options(target: ChatTarget): Promise<readonly string[]>
  /** Adopt one, or undefined when the words name none. */
  choose(target: ChatTarget, input: string): Promise<string | undefined>
  /** Return the conversation to the model's own default. */
  clear(target: ChatTarget): Promise<void>
}

/**
 * A parenthetical naming the layer beneath this conversation's choice.
 *
 * Empty when the conversation is simply following the deployment, because
 * there is then only one answer and pointing at it would be noise.
 */
function originNote(
  control: { origin?(target: ChatTarget): string | undefined },
  target: ChatTarget,
): string {
  const note = control.origin?.(target)
  return note === undefined ? '' : `\n<i>${escapeHtml(note)}</i>`
}

/** Words that mean "no reader at all", as anyone would type them. */
const OFF_WORDS = new Set(['off', 'none', 'no', 'disable', 'disabled'])

/** The model that reads images for this conversation, and how to change it. */
export interface VisionControl {
  /**
   * What lies underneath this conversation's choice, when it has made one.
   *
   * Two surfaces show related state — this command and the settings page —
   * and neither used to admit the other existed. Saying which layer is
   * answering is what stops the page looking like it is lying.
   */
  origin?(target: ChatTarget): string | undefined
  /** The reader in force, in words. */
  describe(target: ChatTarget): string
  /** Adopt one, or say why the words named none. */
  choose(
    target: ChatTarget,
    input: string,
  ): Promise<
    | { kind: 'route'; route: string }
    | { kind: 'ambiguous'; candidates: readonly string[] }
    | { kind: 'unknown' }
  >
  /** Read images with nothing — the conversation's own model must cope. */
  disable(target: ChatTarget): Promise<void>
  /** Return the conversation to whatever the deployment configured. */
  clear(target: ChatTarget): Promise<void>
}

/** What the agent may do here, and how to change it. */
export interface PermissionControlSeam {
  /**
   * What lies underneath this conversation's choice, when it has made one.
   *
   * Two surfaces show related state — this command and the settings page —
   * and neither used to admit the other existed. Saying which layer is
   * answering is what stops the page looking like it is lying.
   */
  origin?(target: ChatTarget): string | undefined
  /** The preset in force, in words. */
  describe(target: ChatTarget): string
  /** Every preset the deployment defines. */
  options(): readonly string[]
  /** Adopt one, or undefined when the words name none. */
  choose(target: ChatTarget, input: string): Promise<string | undefined>
  /** Return the conversation to the deployment's own preset. */
  clear(target: ChatTarget): Promise<void>
}

/** What `/diag` reports. */
export interface DiagnosticsSource {
  report(): Promise<{
    /** Connection facts, as rows. */
    readonly status: readonly StatusRow[]
    /**
     * Which harness services this deployment actually composed.
     *
     * The most useful line in the report: a seam that is absent explains a
     * whole class of "why does it not do that" without anyone having to guess.
     */
    readonly seams: readonly { readonly name: string; readonly present: boolean }[]
    readonly failures: readonly { at: string; level: string; message: string }[]
  }>
}

/** Capturing the screen and putting it in the chat. */
export interface ScreenControl {
  /**
   * Take one and send it.
   *
   * @returns undefined on success, or a sentence saying what went wrong.
   */
  send(target: ChatTarget): Promise<string | undefined>
}

/** Shows that a conversation is being worked on, until released. */
export interface TypingHold {
  hold(target: ChatTarget): () => void
}

/**
 * Render the conversation's facts as a markdown table.
 *
 * Pipes inside a value would split a cell and shift every column after it, so
 * they are escaped — a working directory can contain one, and a model id from
 * a router-style provider routinely does.
 */
function statusTable(rows: readonly StatusRow[]): string {
  const body = rows
    .map((row) => `| ${escapeCell(row.label)} | ${escapeCell(row.value)} |`)
    .join('\n')
  return `| | |\n| --- | --- |\n${body}`
}

/** Keep a value inside its own cell. */
function escapeCell(value: string): string {
  return value.split('|').join('\\|').replace(/\r?\n/g, ' ')
}

/** Routes callback data to whichever feature owns it. */
export interface CallbackHandler {
  handleCallback(data: string | undefined): boolean
}

/** Construction options. */
export interface UpdateRouterOptions {
  readonly chat: RouterChat
  readonly access: AccessPolicy
  readonly questions: CallbackHandler
  readonly approvals: CallbackHandler
  /** Owns the button that starts a fresh conversation after a stuck turn. */
  readonly recovery?: CallbackHandler
  /**
   * Keeps Telegram's own indicator alive while the bot works. Absent simply
   * leaves the chat quiet until the reply arrives.
   */
  readonly typing?: TypingHold
  /** Absent leaves every conversation in the configured directory. */
  readonly workspace?: WorkspaceControl
  /** Absent leaves every conversation on the deployment's model. */
  readonly models?: ModelControl
  /**
   * Whether this conversation's model accepts images itself. Absent decides
   * refusals the way they were decided before any model could see.
   */
  readonly modelSees?: (target: ChatTarget) => Promise<boolean>
  /** Offers this chat's earlier conversations. Absent makes `/new` one-way. */
  readonly sessions?: CallbackHandler & { offer(target: ChatTarget): Promise<void> }
  /** Absent leaves every conversation on the model's own reasoning effort. */
  readonly effort?: EffortControl
  /** Absent leaves every conversation on the deployment's permission preset. */
  readonly permission?: PermissionControlSeam
  /** Absent leaves every conversation on the deployment's image reader. */
  readonly vision?: VisionControl
  /** Takes and sends a picture of the screen. Absent means screenshots are off. */
  readonly screen?: ScreenControl
  /** What the plugin can see about itself, for `/diag`. */
  readonly diagnostics?: DiagnosticsSource
  readonly textCapture: TextCapture
  readonly runner: AgentRunner
  /**
   * How long to wait for the rest of an album. Injected so tests need no clock.
   */
  readonly albumWindowMs?: number
  /**
   * Turns a message's attachments into prompt content. Absent leaves the bot
   * text-only, which is what it was before media was wired up.
   */
  readonly media?: MediaCollector
  /**
   * This bot's own user id, so a reply to something it said is recognised as
   * addressing it. A group conversation continues that way rather than by
   * @mentioning the bot on every line.
   */
  readonly botId?: number
  /**
   * Whether a group message must address the bot to be answered. Off makes the
   * bot answer every allowlisted message in the room, which is the older
   * behaviour and rarely what anyone wants.
   */
  readonly requireAddressing?: boolean
  /** This bot's username, so `/cmd@other_bot` is left alone in groups. */
  readonly botUsername?: string
  /**
   * Strips secrets from anything posted back into a chat. Agent failures are
   * reported to the user verbatim, and an error raised deep in a provider can
   * quote a credential it was given.
   */
  readonly redact?: (text: string) => string
  readonly logger?: Logger
}

export class UpdateRouter {
  /**
   * Albums still arriving, if this deployment reads attachments at all.
   *
   * Owned here rather than injected because its whole job is to defer part of
   * this class's own work back to it.
   */
  private readonly albums: AlbumBuffer | undefined

  private readonly logger: Logger

  constructor(private readonly options: UpdateRouterOptions) {
    this.logger = options.logger ?? SILENT_LOGGER
    this.albums = options.media
      ? new AlbumBuffer({
          deliver: (messages) => void this.onAlbum(messages),
          ...(options.albumWindowMs === undefined ? {} : { windowMs: options.albumWindowMs }),
        })
      : undefined
  }

  /** Stop waiting on albums still arriving — the plugin is unloading. */
  dispose(): void {
    this.albums?.dispose()
  }

  /**
   * Handle one update. Never throws: a thrown handler would stop the poll loop.
   *
   * @param update - one raw update from `getUpdates`.
   */
  async handle(update: TelegramUpdate): Promise<void> {
    try {
      if (update.callback_query) return await this.onCallback(update.callback_query)
      const message = update.message ?? update.edited_message
      if (message) return await this.onMessage(message)
    } catch (error) {
      this.logger.error('[dsh-telegram] update handling failed', error)
    }
  }

  /** A button press: acknowledge first, then route it. */
  private async onCallback(query: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
    // Telegram spins the button until this lands, so acknowledge before any
    // slow work the press unblocks.
    await this.options.chat.answerCallbackQuery(query.id)

    if (this.options.access.check(query.from.id) !== 'allowed') return

    const routed =
      this.options.questions.handleCallback(query.data) ||
      this.options.approvals.handleCallback(query.data) ||
      (this.options.recovery?.handleCallback(query.data) ?? false) ||
      (this.options.sessions?.handleCallback(query.data) ?? false)

    if (!routed) {
      this.logger.debug('[dsh-telegram] ignoring a stale or unknown button press')
    }
  }

  /** An incoming message: access, pending prompt, command, then prompt. */
  private async onMessage(message: TelegramMessage): Promise<void> {
    const target = targetOf(message)
    const userId = message.from?.id
    if (userId === undefined) return

    const raw = message.text ?? message.caption
    const decision = this.options.access.check(userId)

    if (decision !== 'allowed') return await this.onUnauthorized(target, userId, raw, decision)

    // Asked after access and before anything else: a group is a room where
    // people talk to each other, and a bot that answers every line is one
    // nobody keeps around. Silence is the whole response — a message that was
    // not for us deserves no reply, not even a refusal.
    if (this.options.requireAddressing && !addressesBot(message, this.options.botUsername, this.options.botId)) {
      return
    }

    // The @mention is addressing, not content. Left in, every prompt from a
    // group would open with the bot's own name, which the model reads as part
    // of the question.
    const text =
      raw !== undefined && isGroupChat(message)
        ? stripMention(raw, this.options.botUsername) || undefined
        : raw

    const carriesMedia = hasMedia(message)

    // A waiting question wants typed words, and a command is never a file, so
    // both checks look at plain text only.
    if (text !== undefined && !carriesMedia) {
      if (this.options.textCapture.deliver(target, text)) return

      const command = parseCommand(text, this.options.botUsername)
      if (command) return await this.onCommand(target, userId, command.name, command.args)
    }

    if (!carriesMedia) {
      if (text === undefined) {
        return await this.say(target, 'I can read text, images, and text files.')
      }
      return await this.runPrompt(target, [{ type: 'text', text }])
    }

    if (!this.options.media) {
      return await this.say(target, 'This bot is not set up to read attachments.')
    }

    // An album arrives as several updates sharing one id, with the caption on
    // exactly one of them. Held rather than answered, and delivered as a whole
    // once it stops growing — otherwise three screenshots become three turns,
    // two of them with no question attached.
    if (this.albums?.offer(message) === true) return

    // Held across the whole of it. Downloading a large file, retrying one that
    // failed, and reading an image on a vision model all outlast Telegram's
    // five-second action several times over, and none of them show anything in
    // the chat while they run.
    const release = this.options.typing?.hold(target)
    try {
      const collected = await this.options.media.collect(message, text, {
        modelSees: await this.modelSees(target),
      })
      // Said first: the user should not have to wait for a reply to learn that
      // what they attached went nowhere.
      if (collected.notice) await this.say(target, escapeHtml(collected.notice))
      await this.runPrompt(target, collected.parts)
    } finally {
      release?.()
    }
  }

  /**
   * Handle a whole album as one message.
   *
   * Access and addressing were already decided for each part as it arrived, so
   * what is left is the part a single photo would have taken.
   *
   * @param messages - the album's parts, in the order they were sent.
   */
  private async onAlbum(messages: TelegramMessage[]): Promise<void> {
    const first = messages[0]
    if (!first || !this.options.media) return

    const target = targetOf(first)
    const caption = captionOf(messages)
    const release = this.options.typing?.hold(target)

    try {
      const collected = await this.options.media.collectAll(messages, caption, {
        modelSees: await this.modelSees(target),
      })
      if (collected.notice) await this.say(target, escapeHtml(collected.notice))
      await this.runPrompt(target, collected.parts)
    } catch (error) {
      this.logger.error('[dsh-telegram] could not read an album', error)
      await this.say(target, '⚠️ Those files could not be read.')
    } finally {
      release?.()
    }
  }

  /**
   * A user who may not drive the agent. An unclaimed bot still accepts
   * `/claim`, because that is the only way it ever becomes usable.
   */
  private async onUnauthorized(
    target: ChatTarget,
    userId: number,
    text: string | undefined,
    decision: 'denied' | 'unclaimed',
  ): Promise<void> {
    const command = text === undefined ? undefined : parseCommand(text, this.options.botUsername)

    if (decision === 'unclaimed' && command?.name === 'claim') {
      const claimed = await this.options.access.claim(userId, command.args)
      return await this.say(
        target,
        claimed
          ? '✅ Claimed. This bot now answers to you alone.'
          : '❌ That claim code is not right.',
      )
    }

    if (decision === 'unclaimed') {
      return await this.say(
        target,
        'This bot has no owner yet.\nRun <code>/claim &lt;code&gt;</code> with the code printed in the harness console.',
      )
    }

    this.logger.warn(`[dsh-telegram] refused a message from user ${userId}`)
    await this.say(target, '⛔ You are not allowed to use this bot.')
  }

  /** Run one command. */
  private async onCommand(
    target: ChatTarget,
    userId: number,
    name: string,
    args: string,
  ): Promise<void> {
    switch (name) {
      case 'start':
        return await this.say(
          target,
          `👋 Connected to DeepSeek Harness.\nSend a message to talk to the agent.\n\n${helpText()}`,
        )

      case 'help':
        return await this.say(target, helpText())

      case 'claim':
        return await this.say(target, 'This bot is already claimed.')

      case 'whoami':
        return await this.say(target, `Your Telegram user id is <code>${userId}</code>.`)

      case 'new':
        await this.options.runner.reset(target)
        return await this.say(target, '🆕 Started a fresh conversation.')

      case 'cd':
        return await this.onChangeDirectory(target, args)

      case 'model':
        return await this.onModel(target, args)

      case 'effort':
        return await this.onEffort(target, args)

      case 'vision':
        return await this.onVision(target, args)

      case 'permission':
        return await this.onPermission(target, args)

      case 'diag':
        return await this.onDiagnostics(target)

      case 'screenshot':
        return await this.onScreenshot(target)

      case 'sessions':
        if (!this.options.sessions) {
          return await this.say(target, 'This deployment does not keep a conversation list.')
        }
        return await this.options.sessions.offer(target)

      case 'stop': {
        const stopped = await this.options.runner.stop(target)
        return await this.say(target, stopped ? '🛑 Stopped.' : 'Nothing was running.')
      }

      case 'status':
        return await this.describeConversation(target)

      default:
        // Unreachable: parseCommand only returns names present in COMMANDS.
        return await this.say(target, `Unknown command. Try ${Object.keys(COMMANDS).join(', ')}.`)
    }
  }

  /** Hand a prompt to the agent, reporting a failure into the chat. */
  private async runPrompt(target: ChatTarget, content: readonly PromptPart[]): Promise<void> {
    // A prompt is not instant even without attachments: it may wait behind the
    // conversation's previous message, and an image in it is read before the
    // conversation ever sees it.
    const release = this.options.typing?.hold(target)
    try {
      await this.options.runner.prompt(target, content)
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error)
      const reason = this.options.redact?.(raw) ?? raw
      this.logger.error('[dsh-telegram] prompt failed', error)
      await this.say(target, `⚠️ ${escapeHtml(reason)}`)
    } finally {
      release?.()
    }
  }

  /**
   * Report what this plugin can see about itself.
   *
   * Exists because several profiles compose no log sink at all, so a plugin
   * that only logs its failures is silent about them. Every fault found here
   * so far was found by someone noticing odd behaviour in a chat and asking —
   * the seam list in particular would have shown at a glance that Telegram
   * agents were joining no preset, and therefore had almost no tools.
   *
   * @param target - the conversation asking.
   */
  private async onDiagnostics(target: ChatTarget): Promise<void> {
    const diagnostics = this.options.diagnostics
    if (!diagnostics) {
      return await this.say(target, 'This deployment keeps no diagnostics.')
    }

    const report = await diagnostics.report()
    const seams = report.seams
      .map((seam) => `| ${escapeCell(seam.name)} | ${seam.present ? '✅' : '❌'} |`)
      .join('\n')

    const failures =
      report.failures.length === 0
        ? '_Nothing has gone wrong since the last restart._'
        : report.failures
            .map(
              (failure) =>
                `- \`${failure.at.replace('T', ' ').slice(0, 19)}\` ` +
                `${failure.level === 'error' ? '🔴' : '🟠'} ${failure.message}`,
            )
            .join('\n')

    const markdown = [
      '**Connection**',
      '',
      `| | |\n| --- | --- |\n${report.status
        .map((row) => `| ${escapeCell(row.label)} | ${escapeCell(row.value)} |`)
        .join('\n')}`,
      '',
      '**Harness seams**',
      '',
      `| | |\n| --- | --- |\n${seams}`,
      '',
      `**Recent failures** (${report.failures.length})`,
      '',
      failures,
    ].join('\n')

    if (this.options.chat.sendRichMessage) {
      try {
        await this.options.chat.sendRichMessage({
          chatId: target.chatId,
          markdown,
          ...(target.threadId !== undefined ? { threadId: target.threadId } : {}),
        })
        return
      } catch (error) {
        this.logger.warn('[dsh-telegram] could not send the diagnostics', error)
      }
    }

    await this.say(
      target,
      report.status
        .map((row) => `<b>${escapeHtml(row.label)}</b> <code>${escapeHtml(row.value)}</code>`)
        .join('\n'),
    )
  }

  /**
   * Send a picture of the screen the harness is running on.
   *
   * @param target - the conversation to send it to.
   */
  private async onScreenshot(target: ChatTarget): Promise<void> {
    const screen = this.options.screen
    if (!screen) {
      return await this.say(
        target,
        'Screenshots are off. Turn them on in Settings → Telegram → Screen.',
      )
    }

    const release = this.options.typing?.hold(target)
    try {
      const failure = await screen.send(target)
      if (failure !== undefined) await this.say(target, `⚠️ ${escapeHtml(failure)}`)
    } catch (error) {
      this.logger.error('[dsh-telegram] could not take a screenshot', error)
      await this.say(target, '⚠️ The screenshot could not be taken.')
    } finally {
      release?.()
    }
  }

  /**
   * Everything about this conversation worth knowing in one message.
   *
   * The settings live behind four commands, and having to run all four to
   * answer "what am I actually talking to right now" is four commands too
   * many — especially the permission line, which is the one worth being sure
   * about before asking for something destructive.
   *
   * @param target - the conversation.
   */
  private async describeConversation(target: ChatTarget): Promise<void> {
    const rows = [...(await this.options.runner.status(target))]

    const models = this.options.models
    if (models) rows.push({ label: 'Model', value: models.describe(target) })

    const effort = this.options.effort
    if (effort) rows.push({ label: 'Effort', value: effort.describe(target) })

    const vision = this.options.vision
    if (vision) rows.push({ label: 'Reads images', value: vision.describe(target) })

    const permission = this.options.permission
    if (permission) rows.push({ label: 'Permission', value: permission.describe(target) })

    // Sent as markdown so Telegram draws it as a real table — since Bot API
    // 10.1 it parses these itself, which is the same path an agent's own
    // tables take. A deployment without the rich send falls back to lines.
    if (this.options.chat.sendRichMessage) {
      try {
        // Called as a method, not through a saved reference. Detaching it
        // loses `this`, and the client's own `this.call(...)` then throws —
        // which the catch below turns into a silent fall back to lines.
        await this.options.chat.sendRichMessage({
          chatId: target.chatId,
          markdown: statusTable(rows),
          ...(target.threadId !== undefined ? { threadId: target.threadId } : {}),
        })
        return
      } catch (error) {
        this.logger.warn('[dsh-telegram] could not send the status table', error)
      }
    }

    await this.say(
      target,
      rows
        .map((row) => `<b>${escapeHtml(row.label)}</b> <code>${escapeHtml(row.value)}</code>`)
        .join('\n'),
    )
  }

  /**
   * Show or change how hard the model thinks before answering.
   *
   * The options come from the model itself: `low`/`medium`/`high` is one
   * provider's vocabulary rather than everyone's, and offering an effort a
   * model does not have would fail the turn instead of the command.
   *
   * @param target - the conversation.
   * @param args - what followed `/effort`.
   */
  private async onEffort(target: ChatTarget, args: string): Promise<void> {
    const effort = this.options.effort
    if (!effort) {
      return await this.say(target, 'This deployment does not allow changing the effort.')
    }

    const wanted = args.trim()
    const offered = await effort.options(target)

    if (offered.length === 0) {
      return await this.say(
        target,
        `<code>${escapeHtml(effort.model(target))}</code> offers no reasoning effort to choose.`,
      )
    }

    if (wanted === '') {
      const list = offered.map((option) => `• <code>${escapeHtml(option)}</code>`).join('\n')
      return await this.say(
        target,
        `🎚 <code>${escapeHtml(effort.describe(target))}</code>` +
          originNote(effort, target) +
          `\n\n${list}\n\nChange it with <code>/effort high</code>.`,
      )
    }

    if (wanted.toLowerCase() === 'default') {
      await effort.clear(target)
      return await this.say(target, `🎚 Back to <code>${escapeHtml(effort.describe(target))}</code>.`)
    }

    const chosen = await effort.choose(target, wanted)
    if (chosen === undefined) {
      return await this.say(
        target,
        `⚠️ <code>${escapeHtml(effort.model(target))}</code> has no effort called ` +
          `<code>${escapeHtml(wanted)}</code>. It offers: ${offered.join(', ')}.`,
      )
    }

    return await this.say(
      target,
      `🎚 Thinking <code>${escapeHtml(chosen)}</code> from your next message.`,
    )
  }

  /**
   * Show or change which model reads images for this conversation.
   *
   * `off` is a real answer rather than the absence of one: a conversation
   * whose own model can see wants no reader at all, and saying so has to
   * outrank whatever the deployment configured.
   *
   * @param target - the conversation.
   * @param args - what followed `/vision`.
   */
  private async onVision(target: ChatTarget, args: string): Promise<void> {
    const vision = this.options.vision
    if (!vision) {
      return await this.say(target, 'This deployment does not allow changing the image reader.')
    }

    const wanted = args.trim()

    if (wanted === '') {
      return await this.say(
        target,
        `👁 <code>${escapeHtml(vision.describe(target))}</code>` +
          originNote(vision, target) +
          '\n\nSee what is configured with <code>/model list</code>, change it with ' +
          '<code>/vision provider/model</code>, or turn it off with ' +
          '<code>/vision off</code>.',
      )
    }

    if (OFF_WORDS.has(wanted.toLowerCase())) {
      await vision.disable(target)
      return await this.say(
        target,
        `👁 <code>${escapeHtml(vision.describe(target))}</code>` +
          originNote(vision, target) +
          '\n\nImages now go to the conversation itself, which needs a model that reads them.',
      )
    }

    if (wanted.toLowerCase() === 'default') {
      await vision.clear(target)
      return await this.say(target, `👁 Back to <code>${escapeHtml(vision.describe(target))}</code>.`)
    }

    const chosen = await vision.choose(target, wanted)
    switch (chosen.kind) {
      case 'route':
        return await this.say(target, `👁 Images now read by <code>${escapeHtml(chosen.route)}</code>.`)
      case 'ambiguous':
        return await this.say(
          target,
          `Several providers offer that. Name one:\n${chosen.candidates
            .map((candidate) => `• <code>${escapeHtml(candidate)}</code>`)
            .join('\n')}`,
        )
      default:
        return await this.say(
          target,
          `⚠️ No configured model called <code>${escapeHtml(wanted)}</code>. ` +
            'Try <code>/model list</code>.',
        )
    }
  }

  /**
   * Show or change what the agent is allowed to do here.
   *
   * Applied to the conversation in flight as well as recorded, because the
   * point of tightening it is usually the turn about to run.
   *
   * @param target - the conversation.
   * @param args - what followed `/permission`.
   */
  private async onPermission(target: ChatTarget, args: string): Promise<void> {
    const permission = this.options.permission
    if (!permission) {
      return await this.say(target, 'This deployment does not allow changing permissions.')
    }

    const wanted = args.trim()
    const offered = permission.options()

    if (wanted === '') {
      const list = offered.map((option) => `• <code>${escapeHtml(option)}</code>`).join('\n')
      return await this.say(
        target,
        `🔐 <code>${escapeHtml(permission.describe(target))}</code>` +
          originNote(permission, target) +
          `\n\n${list}\n\nChange it with <code>/permission read-only</code>.`,
      )
    }

    if (wanted.toLowerCase() === 'default') {
      await permission.clear(target)
      return await this.say(
        target,
        `🔐 Back to <code>${escapeHtml(permission.describe(target))}</code>.`,
      )
    }

    const chosen = await permission.choose(target, wanted)
    if (chosen === undefined) {
      return await this.say(
        target,
        `⚠️ No permission preset called <code>${escapeHtml(wanted)}</code>. ` +
          `This deployment offers: ${offered.join(', ')}.`,
      )
    }

    return await this.say(target, `🔐 Now <code>${escapeHtml(chosen)}</code>.`)
  }

  /**
   * Show, list, or change the model this conversation talks to.
   *
   * No reset here, unlike `/cd`: the harness reads a mutable selection while
   * assembling each step, so a model change lands on the very next message and
   * the conversation carries on.
   *
   * @param target - the conversation.
   * @param args - what followed `/model`.
   */
  private async onModel(target: ChatTarget, args: string): Promise<void> {
    const models = this.options.models
    if (!models) {
      return await this.say(target, 'This deployment does not allow changing the model.')
    }

    const wanted = args.trim()

    if (wanted === '') {
      return await this.say(
        target,
        `🧠 <code>${escapeHtml(models.describe(target))}</code>` +
          originNote(models, target) +
          '\n\nSee them with <code>/model list</code>, or change it with ' +
          '<code>/model provider/model</code>.',
      )
    }

    if (wanted.toLowerCase() === 'default') {
      await models.clear(target)
      return await this.say(target, `🧠 Back to <code>${escapeHtml(models.describe(target))}</code>.`)
    }

    if (wanted.toLowerCase() === 'list') return await this.say(target, await models.list())

    const chosen = await models.choose(target, wanted)
    switch (chosen.kind) {
      case 'route':
        return await this.say(
          target,
          `🧠 Now talking to <code>${escapeHtml(chosen.route)}</code>.\n\n` +
            'It applies from your next message; this conversation carries on.',
        )
      case 'ambiguous':
        return await this.say(
          target,
          `Several providers offer that. Name one:\n${chosen.candidates
            .map((candidate) => `• <code>${escapeHtml(candidate)}</code>`)
            .join('\n')}`,
        )
      default:
        return await this.say(
          target,
          `⚠️ No configured model called <code>${escapeHtml(wanted)}</code>. ` +
            'Try <code>/model list</code>.',
        )
    }
  }

  /**
   * Show or change the conversation's working directory.
   *
   * Changing it necessarily starts a fresh conversation: the sandbox derives
   * its writable root from the session's cwd, and that root is fixed when the
   * session opens. Rather than fail a move the user reasonably expects to
   * work, the reset is done for them and said out loud.
   *
   * @param target - the conversation.
   * @param args - what followed `/cd`; empty means "tell me where I am".
   */
  private async onChangeDirectory(target: ChatTarget, args: string): Promise<void> {
    const workspace = this.options.workspace
    const current = workspace?.current(target)

    if (!workspace || current === undefined) {
      return await this.say(target, 'This deployment does not allow changing directory.')
    }

    if (args.trim() === '') {
      return await this.say(
        target,
        `📁 <code>${escapeHtml(current)}</code>\n\nChange it with <code>/cd ~/projects/app</code>.`,
      )
    }

    const wanted = workspace.resolve(args, current)
    if (wanted === undefined) {
      return await this.say(target, 'Give me a directory: <code>/cd ~/projects/app</code>')
    }

    if (wanted === current) {
      return await this.say(target, `Already in <code>${escapeHtml(wanted)}</code>.`)
    }

    const verdict = await workspace.inspect(wanted)
    if (verdict !== 'directory') {
      const why =
        verdict === 'file'
          ? 'that is a file, not a directory'
          : verdict === 'denied'
            ? 'it cannot be read'
            : 'no such directory'
      return await this.say(target, `⚠️ Cannot use <code>${escapeHtml(wanted)}</code> — ${why}.`)
    }

    try {
      await workspace.set(target, wanted)
    } catch (error) {
      this.logger.error('[dsh-telegram] could not record the working directory', error)
      return await this.say(target, '⚠️ The directory could not be saved.')
    }

    // After the directory is recorded, so a failed reset still leaves the
    // choice in place for the next message rather than losing it silently.
    await this.options.runner.reset(target)
    return await this.say(
      target,
      `📁 Now working in <code>${escapeHtml(wanted)}</code>.\n\n` +
        '🆕 Started a fresh conversation — a session keeps the directory it opened in.',
    )
  }

  /**
   * Whether this conversation's own model reads images.
   *
   * Never fatal: an unanswerable question here means the refusal is decided
   * the way it was before there was a model that could see.
   */
  private async modelSees(target: ChatTarget): Promise<boolean> {
    try {
      return (await this.options.modelSees?.(target)) === true
    } catch {
      return false
    }
  }

  /** Send one plain notice into a conversation, swallowing delivery failures. */
  private async say(target: ChatTarget, html: string): Promise<void> {
    try {
      await this.options.chat.sendMessage({
        chatId: target.chatId,
        html,
        ...(target.threadId !== undefined ? { threadId: target.threadId } : {}),
      })
    } catch (error) {
      this.logger.warn('[dsh-telegram] could not deliver a notice', error)
    }
  }
}

/** Whether a message carries anything beyond its text. */
function hasMedia(message: TelegramMessage): boolean {
  return Boolean(
    message.photo || message.document || message.voice || message.audio || message.video,
  )
}

/** The conversation a message belongs to. */
function targetOf(message: TelegramMessage): ChatTarget {
  return {
    chatId: String(message.chat.id),
    ...(message.message_thread_id !== undefined ? { threadId: message.message_thread_id } : {}),
  }
}
