/**
 * The conversations a chat has had, so one can be picked up again.
 *
 * `/new` is otherwise a one-way door: the harness keeps every session's log,
 * but the binding that named it is replaced, and from a phone there is no
 * other way back. Someone who starts a fresh conversation to ask one quick
 * thing loses the one they were in the middle of.
 *
 * Kept by this plugin rather than read from the harness's own session index,
 * because the question is "which conversations happened in THIS chat" — a
 * Telegram fact the harness does not record. The index would also mix in every
 * session from the web UI, which is not what anyone means by "my
 * conversations" when they ask from Telegram.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { ChatTarget } from '../interact/surface.js'

/** How many conversations to remember per chat. */
const KEEP = 20

/** Longest label kept; a first message can be a whole stack trace. */
const MAX_LABEL = 60

/** One past conversation. */
export interface PastSession {
  readonly sessionId: string
  readonly startedAt: number
  readonly cwd: string
  /** The opening words, so the list is readable at a glance. */
  readonly label?: string
}

export class ChatHistory {
  private entries = new Map<string, PastSession[]>()

  private constructor(private readonly file: string) {}

  /**
   * Load the history, or start empty when there is nothing readable yet.
   *
   * @param file - absolute path to the JSON document.
   */
  static async open(file: string): Promise<ChatHistory> {
    const history = new ChatHistory(file)
    history.entries = await read(file)
    return history
  }

  /** What this chat has talked to, newest first. */
  forChat(target: ChatTarget): readonly PastSession[] {
    return this.entries.get(keyOf(target)) ?? []
  }

  /**
   * Record a conversation, or refresh the label of one already known.
   *
   * @param target - the conversation's chat.
   * @param session - the session, and what it opened with.
   */
  async remember(target: ChatTarget, session: PastSession): Promise<void> {
    const key = keyOf(target)
    const existing = this.entries.get(key) ?? []

    const label = session.label === undefined ? undefined : clip(session.label)
    const known = existing.find((entry) => entry.sessionId === session.sessionId)

    // A session already at the head with the same label is the common case —
    // every message after the first — and rewriting the file for it would turn
    // one conversation into a stream of disk writes.
    if (known?.label === label && existing[0]?.sessionId === session.sessionId) return

    // A label is only taken once: the opening words identify a conversation,
    // and replacing them with the latest message would make the list churn.
    const kept = known?.label ?? label

    const entry: PastSession = {
      sessionId: session.sessionId,
      startedAt: known?.startedAt ?? session.startedAt,
      cwd: session.cwd,
      ...(kept === undefined ? {} : { label: kept }),
    }

    const next = new Map(this.entries)
    next.set(key, [entry, ...existing.filter((item) => item.sessionId !== entry.sessionId)].slice(0, KEEP))

    this.entries = next
    await this.persist()
  }

  /** Forget one conversation — its log is gone, or it could not be resumed. */
  async forget(target: ChatTarget, sessionId: string): Promise<void> {
    const key = keyOf(target)
    const existing = this.entries.get(key)
    if (!existing?.some((entry) => entry.sessionId === sessionId)) return

    const next = new Map(this.entries)
    next.set(key, existing.filter((entry) => entry.sessionId !== sessionId))

    this.entries = next
    await this.persist()
  }

  /** Write the document atomically, so a crash cannot leave a half file. */
  private async persist(): Promise<void> {
    const document = Object.fromEntries(this.entries)
    const temporary = `${this.file}.${process.pid}.tmp`

    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(temporary, `${JSON.stringify(document, undefined, 2)}\n`, 'utf8')
    await rename(temporary, this.file)
  }
}

/** Cut a label to length, marking that it was cut. */
export function clip(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  if (line.length <= MAX_LABEL) return line
  return `${line.slice(0, MAX_LABEL - 1)}…`
}

/** The durable key for one conversation; a forum topic is its own conversation. */
function keyOf(target: ChatTarget): string {
  return target.threadId === undefined ? target.chatId : `${target.chatId}#${target.threadId}`
}

/** Read the document, keeping only entries with a usable shape. */
async function read(file: string): Promise<Map<string, PastSession[]>> {
  const entries = new Map<string, PastSession[]>()

  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return entries
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return entries

  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue

    const sessions = value.filter(
      (entry): entry is PastSession =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as PastSession).sessionId === 'string' &&
        typeof (entry as PastSession).startedAt === 'number' &&
        typeof (entry as PastSession).cwd === 'string',
    )

    if (sessions.length > 0) entries.set(key, sessions.slice(0, KEEP))
  }

  return entries
}
