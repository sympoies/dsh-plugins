/**
 * Reading an image with one model so another can use what it says.
 *
 * A provider inspects the whole request history for images, so an image left
 * in a conversation binds that conversation to a model that can see — for
 * good. That costs more than the picture is usually worth: the conversation
 * loses the model it was chosen for, and the tools configured around it.
 *
 * So the image never enters the conversation. It goes to a throwaway session
 * on the vision model, whose reply — the transcription, the description — is
 * what the conversation receives, as ordinary text. The conversation's history
 * stays free of images, so it keeps its own model and never becomes stuck.
 *
 * The throwaway session is disposed either way. It exists for one turn.
 */

import type { PromptPart } from './collect.js'
import type { ModelRoute } from '../harness/model-selection.js'
import type { Logger } from '../harness/types.js'
import { SILENT_LOGGER } from '../harness/types.js'
import { labelOcr } from './ocr.js'

/** What the vision model is asked to do with the picture. */
const INSTRUCTION =
  'Read this image for someone who cannot see it. Transcribe every piece of ' +
  'text it contains, exactly, including numbers, dates, names and amounts. ' +
  'Then describe briefly what the image is. Reply with only that — no ' +
  'preamble, no offer of further help.'

/** How long one extraction may take before the conversation moves on without it. */
const DEFAULT_TIMEOUT_MS = 120_000

/** A live agent driven for exactly one turn. */
export interface ExtractionAgent {
  readonly sessionId: string
  followup(content: readonly PromptPart[]): void
  dispose(): Promise<void>
}

/** Creating the throwaway agent the extraction runs on. */
export interface ExtractionHost {
  create(sessionId: string, cwd: string, route: ModelRoute): Promise<ExtractionAgent>
}

/** The session-event shapes an extraction watches for. */
export interface ExtractionEvent {
  readonly type: string
  readonly data?: unknown
}

/** Reading an image's text without a model, when there is no model. */
export interface FallbackReader {
  available(): Promise<boolean>
  read(data: Uint8Array): Promise<string | undefined>
}

/** Fetching the bytes back for a stored attachment. */
export interface AttachmentReader {
  readImage(ref: unknown): Promise<{ data: Uint8Array }>
}

/** Construction options. */
export interface VisionExtractorOptions {
  readonly host: ExtractionHost
  readonly cwd: string
  /**
   * Whether any vision model is configured anywhere.
   *
   * Only decides {@link VisionExtractor.available}; which model a particular
   * conversation reads with is passed to `resolve`, because `/vision` makes
   * that a per-conversation answer.
   */
  readonly visionModel: () => ModelRoute | undefined
  /**
   * OCR, for when no vision model is configured or the one configured could
   * not be reached. Strictly a fallback: it reads text and does not see, so a
   * model that can look is always preferred.
   */
  readonly fallback?: FallbackReader
  /** Reads a stored image back, which the fallback needs and the model does not. */
  readonly attachments?: AttachmentReader
  readonly newSessionId?: () => string
  readonly timeoutMs?: number
  readonly logger?: Logger
}

/** One extraction waiting on its session. */
interface Pending {
  /** The last thing the model said; the reading, once the turn ends well. */
  text: string
  settle: (text: string | undefined) => void
}

export class VisionExtractor {
  private readonly pending = new Map<string, Pending>()
  private readonly logger: Logger
  private counter = 0

  constructor(private readonly options: VisionExtractorOptions) {
    this.logger = options.logger ?? SILENT_LOGGER
  }

  /**
   * Whether an image can be read at all right now.
   *
   * Optimistic about the fallback: probing Tesseract spawns a process, and
   * this is consulted on the path of every message. A fallback that turns out
   * to be absent simply reads nothing, which is the same outcome as saying so
   * here would have been.
   */
  get available(): boolean {
    return this.options.visionModel() !== undefined || this.options.fallback !== undefined
  }

  /**
   * Replace image parts with what a vision model reads in them.
   *
   * @param content - the prompt as the user sent it.
   * @returns the same prompt with each image replaced by its reading, or the
   *   original content when there is nothing to read or no model to read it.
   */
  async resolve(
    content: readonly PromptPart[],
    route: ModelRoute | undefined = this.options.visionModel(),
  ): Promise<PromptPart[]> {
    const images = content.filter((part) => part.type === 'image')
    if (images.length === 0) return [...content]

    // A route is no longer required: without one there is still OCR, and
    // without either the prompt says so rather than carrying an image that
    // nothing downstream can use.
    if (route === undefined && this.options.fallback === undefined) return [...content]

    const said = content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)

    const read = route === undefined ? undefined : await this.read(images, route)
    if (read !== undefined) {
      // The user's own words first: the image is what they are asking about.
      return [
        ...said.map((text) => ({ type: 'text' as const, text })),
        { type: 'text' as const, text: `Contents of the image the user sent:\n\n${read}` },
      ]
    }

    // Reached either because nothing was configured to look, or because what
    // was configured could not be reached. Both are cases where reading the
    // text beats returning nothing at all.
    const scanned = await this.scan(images)
    if (scanned !== undefined) {
      return [...said.map((text) => ({ type: 'text' as const, text })), { type: 'text' as const, text: scanned }]
    }

    return [
      ...said.map((text) => ({ type: 'text' as const, text })),
      {
        type: 'text' as const,
        text:
          route === undefined
            ? '(The user sent an image, but nothing here can read one. Configure a vision model in Settings → Telegram, or install tesseract.)'
            : `(The user sent an image, but it could not be read by ${route.model}.)`,
      },
    ]
  }

  /**
   * Read every image's text with the fallback.
   *
   * The bytes come back from the attachment store rather than being kept
   * around: the model path never needs them, and holding every image in memory
   * against the chance that a model call fails would be a strange thing to pay
   * for on every message.
   *
   * @returns the readings joined, or undefined when there were none.
   */
  private async scan(images: readonly PromptPart[]): Promise<string | undefined> {
    const { fallback, attachments } = this.options
    if (!fallback || !attachments) return undefined
    if (!(await fallback.available())) return undefined

    const readings: string[] = []
    for (const image of images) {
      if (image.type !== 'image') continue

      try {
        const stored = await attachments.readImage(image.attachment)
        const text = await fallback.read(stored.data)
        if (text !== undefined) readings.push(text)
      } catch (error) {
        this.logger.warn('[dsh-telegram] could not read a stored image back', error)
      }
    }

    if (readings.length === 0) return undefined

    return labelOcr(
      readings.length === 1
        ? (readings[0] as string)
        : readings.map((text, index) => `--- image ${index + 1} ---\n${text}`).join('\n\n'),
    )
  }

  /**
   * Consume one session event.
   *
   * @returns whether it belonged to an extraction, so the caller knows not to
   *   treat it as a conversation of its own.
   */
  handle(sessionId: string, event: ExtractionEvent): boolean {
    const entry = this.pending.get(sessionId)
    if (!entry) return false

    if (event.type === 'assistant/message') {
      const message = (
        event.data as { message?: { content?: readonly { type: string; text?: string }[] } }
      )?.message
      const text = (message?.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('')
        .trim()
      if (text !== '') entry.text = text
    }

    if (event.type === 'turn/end') {
      const reason = (
        event.data as { reason?: { kind?: string; error?: { message?: string } } }
      )?.reason
      if (reason?.kind === 'error') {
        this.logger.warn(
          `[dsh-telegram] the vision model could not read the image: ${
            reason.error?.message ?? 'the turn failed'
          }`,
        )
        entry.settle(undefined)
        return true
      }

      entry.settle(entry.text === '' ? undefined : entry.text)
    }

    return true
  }

  /** Abandon every extraction in flight — the plugin is unloading. */
  dispose(): void {
    for (const entry of [...this.pending.values()]) entry.settle(undefined)
  }

  /** Run one throwaway turn and return what the model said. */
  private async read(
    images: readonly PromptPart[],
    route: ModelRoute,
  ): Promise<string | undefined> {
    const sessionId = this.nextSessionId()

    let agent: ExtractionAgent
    try {
      agent = await this.options.host.create(sessionId, this.options.cwd, route)
    } catch (error) {
      this.logger.warn('[dsh-telegram] could not open a session to read the image', error)
      return undefined
    }

    try {
      const settled = new Promise<string | undefined>((resolve) => {
        const timer = setTimeout(() => {
          this.pending.delete(sessionId)
          this.logger.warn('[dsh-telegram] reading the image timed out')
          resolve(undefined)
        }, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

        this.pending.set(sessionId, {
          text: '',
          settle: (text) => {
            clearTimeout(timer)
            this.pending.delete(sessionId)
            resolve(text)
          },
        })
      })

      agent.followup([{ type: 'text', text: INSTRUCTION }, ...images])
      return await settled
    } finally {
      // One turn is its whole life; leaving it loaded would keep a second
      // model warm for every picture anyone sends.
      await agent.dispose().catch((error: unknown) => {
        this.logger.warn('[dsh-telegram] could not dispose the reading session', error)
      })
    }
  }

  /** A session id no conversation can collide with. */
  private nextSessionId(): string {
    if (this.options.newSessionId) return this.options.newSessionId()
    this.counter += 1
    return `tg-vision-${Date.now()}-${this.counter}`
  }
}
