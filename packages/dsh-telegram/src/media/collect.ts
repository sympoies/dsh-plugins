/**
 * Fetching a message's media and turning it into prompt content.
 *
 * Downloading is the part that can go wrong in ordinary ways — a file above
 * the bot download limit, a network drop, an image the harness refuses — and
 * none of them should cost the user their message. So every failure becomes a
 * note in the prompt saying what could not be read, and the text the user
 * typed alongside it still reaches the agent.
 */

import type { TelegramMessage } from '../telegram/types.js'
import type { Logger } from '../harness/types.js'
import { SILENT_LOGGER } from '../harness/types.js'

import { describeMedia, isStorableImage } from './intake.js'
import { describeSize, isTooLarge, orderBySuitability } from './limits.js'
import type { ImageCandidate, ImageLimits } from './limits.js'
import type { VisionCheck } from './vision.js'

/** A durable image reference, as the harness attachment seam returns it. */
export interface ImageRef {
  readonly attachmentId: unknown
  readonly mediaType: string
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
}

/** One piece of a prompt. */
export type PromptPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly attachment: ImageRef }

/** Downloading bytes from Telegram. */
export interface MediaSource {
  getFile(fileId: string): Promise<{ file_path?: string; file_size?: number }>
  downloadFile(filePath: string, signal?: AbortSignal): Promise<Uint8Array>
}

/** The harness attachment seam, narrowed to what this needs. */
export interface AttachmentStore {
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<ImageRef>
  /**
   * The seam's own limits, where it publishes them.
   *
   * Read rather than configured a second time: the operator sets this on the
   * attachment plugin, and a copy on this side would silently drift out of
   * step with the number that actually decides.
   */
  readonly imageLimits?: ImageLimits
}

/** What the caller knows about the turn these attachments are for. */
export interface CollectionContext {
  /**
   * Whether the model this turn will run on accepts images itself.
   *
   * Decided per conversation, because `/model` is per conversation: judging
   * the deployment default would refuse an image on a chat that had switched
   * to a model which can see.
   */
  readonly modelSees?: boolean
}

/** What a message's attachments became, plus anything the user should be told. */
export interface CollectedMedia {
  /** Content for the agent, in the order the model should read it. */
  readonly parts: PromptPart[]
  /**
   * A line for the chat, when something the user sent could not be used. The
   * agent's prompt says so too, but the person who sent it should not have to
   * wait for a reply to learn their screenshot went nowhere.
   */
  readonly notice?: string
}

/** Construction options. */
export interface MediaCollectorOptions {
  readonly source: MediaSource
  /** Absent on a deployment with no attachment seam; images are then declined. */
  readonly attachments?: AttachmentStore
  /**
   * Whether the model can read an image at all. Absent skips the check and
   * lets the provider be the authority, which is the older behaviour.
   */
  readonly vision?: VisionCheck
  /**
   * Whether an image can be read even where no model accepts one — OCR.
   *
   * Consulted before refusing, because a refusal here happens before the
   * download and so takes the picture away from whatever could have read it.
   */
  readonly canReadWithoutModel?: () => Promise<boolean>
  /** Refuse anything larger, before downloading it. */
  readonly maxBytes: number
  /** Truncate an inlined text file to this many characters. */
  readonly maxTextChars: number
  /**
   * Strip anything secret from a refusal before it is written down.
   *
   * A refusal quotes the failure that caused it, and lands in two durable
   * places at once: the chat, and the session log the agent carries forward.
   * The API client already redacts its own errors, so this is the second lock
   * rather than the first — but this sink is the one that persists.
   */
  readonly redact?: (text: string) => string
  readonly logger?: Logger
}

export class MediaCollector {
  private readonly logger: Logger

  constructor(private readonly options: MediaCollectorOptions) {
    this.logger = options.logger ?? SILENT_LOGGER
  }

  /**
   * Turn one message into the parts a prompt is built from.
   *
   * @param message - the incoming message.
   * @param caption - the text the user typed, if any.
   * @returns text and image parts, in the order the model should read them.
   */
  async collect(
    message: TelegramMessage,
    caption: string | undefined,
    context: CollectionContext = {},
  ): Promise<CollectedMedia> {
    const item = describeMedia(message)
    const said = caption?.trim()

    if (!item) {
      return { parts: said ? [{ type: 'text', text: said }] : [] }
    }

    if (item.kind === 'unsupported') {
      const what = item.describedAs ?? 'a file'
      return this.declined(said, `${what}, which cannot be read`, `I can't read ${what}.`)
    }

    if (item.size !== undefined && item.size > this.options.maxBytes) {
      const limit = Math.floor(this.options.maxBytes / 1024 / 1024)
      return this.declined(
        said,
        `a file of ${item.size} bytes, above the size limit`,
        `That file is too large — the limit is ${limit} MB.`,
      )
    }

    if (item.kind === 'image') {
      // Skipped when anything can read the picture: the conversation's own
      // model, a vision model behind it, or OCR. The refusal exists to replace
      // a failed turn with a useful sentence, and with any of those in place it
      // would instead throw away an image that was going to be read.
      const readable =
        context.modelSees === true || (await this.options.canReadWithoutModel?.()) === true
      const refusal = readable ? undefined : await this.imageRefusal()
      if (refusal) return this.declined(said, refusal.forAgent, refusal.forUser)
    }

    try {
      if (item.kind === 'text') {
        const bytes = await this.download(item.fileId)
        const text = decodeText(bytes, this.options.maxTextChars)
        const name = item.name ?? 'attachment'
        return {
          parts: [
            { type: 'text', text: `${said ? `${said}\n\n` : ''}File \`${name}\`:\n\n${text}` },
          ],
        }
      }

      if (!this.options.attachments) {
        return this.declined(
          said,
          'an image, but this deployment stores none',
          'This deployment cannot store images.',
        )
      }
      if (!isStorableImage(item.mediaType)) {
        const type = item.mediaType ?? 'unknown'
        return this.declined(
          said,
          `an image of type ${type}, which cannot be stored`,
          `Images of type ${type} cannot be stored. PNG, JPEG, WebP and GIF work.`,
        )
      }

      const stored = await this.storeImage(item)
      if (!stored) {
        // Reached only when every size Telegram offered was still refused,
        // which in practice means a file sent uncompressed: there is one size
        // and it is the full-resolution original.
        const limits = this.options.attachments.imageLimits
        const explanation =
          describeSize(largest(item.candidates), limits) ??
          'That image is larger than this harness stores.'
        return this.declined(
          said,
          'an image too large for this harness to store, so it was left out',
          `${explanation} Sending it as a photo rather than as a file lets Telegram offer a smaller copy.`,
        )
      }

      // Text first: it is what the user asked, and the image is its subject.
      const parts: PromptPart[] = []
      if (said) parts.push({ type: 'text', text: said })
      parts.push({ type: 'image', attachment: stored })
      return { parts }
    } catch (error) {
      this.logger.warn('[dsh-telegram] could not read an attachment', error)
      const reason = error instanceof Error ? error.message : String(error)
      return this.declined(
        said,
        `a file that could not be read: ${reason}`,
        `That file could not be read: ${reason}`,
      )
    }
  }

  /**
   * Turn a whole album into one prompt.
   *
   * Each part is collected on its own — the same path a single photo takes, so
   * refusals and size limits behave identically — and the results are then
   * laid out as one message would have been: what the user said, then every
   * image, then anything that could not be read.
   *
   * @param messages - the album's parts, in the order they were sent.
   * @param caption - the one caption the album carries.
   */
  async collectAll(
    messages: readonly TelegramMessage[],
    caption: string | undefined,
    context: CollectionContext = {},
  ): Promise<CollectedMedia> {
    if (messages.length === 0) return { parts: [] }
    if (messages.length === 1) {
      return await this.collect(messages[0] as TelegramMessage, caption, context)
    }

    // Sequential rather than parallel: each part downloads bytes and commits
    // them, and a dozen at once is a burst of traffic and disk for no gain
    // when the user is waiting on the whole set anyway.
    const collected: CollectedMedia[] = []
    for (const message of messages) {
      collected.push(await this.collect(message, undefined, context))
    }

    const said = caption?.trim()
    const images = collected.flatMap((item) => item.parts.filter((part) => part.type === 'image'))
    const notes = collected.flatMap((item) =>
      item.parts.filter((part): part is { type: 'text'; text: string } => part.type === 'text'),
    )
    const notices = collected.map((item) => item.notice).filter((notice) => notice !== undefined)

    const parts: PromptPart[] = []
    if (said) parts.push({ type: 'text', text: said })
    parts.push(...images)
    // After the images, because a note explains what is missing from them.
    parts.push(...notes)

    return {
      parts,
      // One line however many parts failed the same way: three identical
      // refusals in a row say nothing the first did not.
      ...(notices.length > 0 ? { notice: [...new Set(notices)].join('\n') } : {}),
    }
  }

  /**
   * Store an image, stepping down through Telegram's smaller renderings.
   *
   * The seam refuses anything over its per-side limit, and the largest size of
   * a phone screenshot is always over it — 1179×2556 against a limit of 2000.
   * The largest size that fits is tried first, and a rejection falls through
   * to the next, because the limit belongs to the harness and may not be the
   * number read here.
   *
   * @returns the stored reference, or undefined when no size was accepted.
   */
  private async storeImage(item: {
    fileId: string
    mediaType?: string
    name?: string
    candidates?: readonly ImageCandidate[]
  }): Promise<ImageRef | undefined> {
    const store = this.options.attachments
    if (!store) return undefined

    const candidates = item.candidates ?? [{ fileId: item.fileId }]
    const ordered = orderBySuitability(candidates, store.imageLimits)

    for (const candidate of ordered) {
      try {
        const bytes = await this.download(candidate.fileId)
        return await store.saveImage({
          data: bytes,
          mediaType: item.mediaType as string,
          ...(item.name !== undefined ? { name: item.name } : {}),
        })
      } catch (error) {
        // Only a size refusal is worth another download; a malformed file or a
        // failed write would fail identically however small the image was.
        if (!isTooLarge(error)) throw error
        this.logger.debug('[dsh-telegram] image refused as too large; trying a smaller size', error)
      }
    }

    // Exhausted rather than thrown: the seam's own wording — "Image exceeds
    // the configured per-side pixel limit" — tells the user nothing they can
    // act on, and the caller has something better to say.
    return undefined
  }

  /**
   * Why an image must not be sent on the current route, if it must not.
   *
   * A model with no image input rejects the entire request, so this refusal
   * replaces a failed turn with a sentence naming what would have worked.
   */
  private async imageRefusal(): Promise<{ forAgent: string; forUser: string } | undefined> {
    const vision = this.options.vision
    if (!vision) return undefined
    if ((await vision.verdict()) !== 'no') return undefined

    const model = vision.currentModel() ?? 'the current model'
    const alternatives = await vision.alternatives()
    const suggestion =
      alternatives.length > 0
        ? ` These accept images: ${alternatives.join(', ')}.`
        : ' No configured model accepts images.'

    return {
      forAgent: `an image, which the model ${model} cannot read, so it was left out`,
      forUser: `${model} can't read images.${suggestion} Change it in Settings → Models.`,
    }
  }

  /** Keep the caption, tell the agent what was left out, and tell the user why. */
  private declined(said: string | undefined, forAgent: string, forUser: string): CollectedMedia {
    // Applied here rather than at each call site: every refusal in this class
    // funnels through this method, so one guard covers all of them and a
    // refusal added later cannot forget it.
    const clean = this.options.redact ?? ((text: string) => text)
    return {
      parts: [{ type: 'text', text: clean(note(said, `The user sent ${forAgent}.`)) }],
      notice: clean(forUser),
    }
  }

  /** Resolve a file id and pull its bytes, refusing anything oversized. */
  private async download(fileId: string): Promise<Uint8Array> {
    const file = await this.options.source.getFile(fileId)
    if (!file.file_path) throw new Error('telegram returned no download path')
    if (file.file_size !== undefined && file.file_size > this.options.maxBytes) {
      throw new Error(`file is ${file.file_size} bytes, above the size limit`)
    }
    return await this.options.source.downloadFile(file.file_path)
  }
}

/** The biggest size offered, for a refusal that can name what was sent. */
function largest(candidates: readonly ImageCandidate[] | undefined): ImageCandidate | undefined {
  if (!candidates || candidates.length === 0) return undefined
  return candidates.reduce((biggest, candidate) =>
    (candidate.width ?? 0) * (candidate.height ?? 0) > (biggest.width ?? 0) * (biggest.height ?? 0)
      ? candidate
      : biggest,
  )
}

/** Keep what the user said, and add why their file did not come through. */
function note(said: string | undefined, explanation: string): string {
  return said ? `${said}\n\n(${explanation})` : `(${explanation})`
}

/** Decode file bytes as text, replacing what is not valid UTF-8. */
function decodeText(bytes: Uint8Array, maxChars: number): string {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n… (truncated at ${maxChars} characters)`
}
