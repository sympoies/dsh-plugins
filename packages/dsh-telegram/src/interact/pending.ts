/**
 * Waiters keyed by a short token.
 *
 * Every interactive prompt this plugin sends — a question, an approval — is a
 * promise the agent is blocked on, parked here until a button press arrives
 * minutes later in a completely separate HTTP request. The token is the only
 * thing that survives that round trip: it travels inside Telegram's
 * `callback_data`, which is capped at 64 bytes and shares that space with a
 * kind prefix and an option index. Hence short tokens rather than UUIDs.
 *
 * Settling is first-claimant-wins. A user can press two buttons before the
 * first press is acknowledged, a signal can abort mid-press, and the plugin
 * can unload underneath both — so the registry removes the entry before
 * resolving, and every later claim is a no-op rather than a double-resolve.
 */

import { randomUUID } from 'node:crypto'

/** A registered waiter: the token to route presses by, and its settlement. */
export interface PendingWaiter<T> {
  /** Short id carried in `callback_data`. */
  readonly token: string
  /** Resolves with the settled value, or `undefined` when cancelled. */
  readonly promise: Promise<T | undefined>
}

/** Options for one waiter. */
export interface OpenOptions {
  /** Cancels the waiter when it aborts (the agent gave up, the turn ended). */
  readonly signal?: AbortSignal
  /** Runs on cancellation only — never after an answer. Used to retire the keyboard. */
  readonly onCancel?: () => void
}

/** One parked waiter's internal state. */
interface Entry<T> {
  settle: (value: T | undefined) => void
  detach: () => void
  onCancel: (() => void) | undefined
}

export class PendingRegistry<T> {
  private readonly entries = new Map<string, Entry<T>>()

  /**
   * Park a new waiter.
   *
   * @param options - cancellation signal and cleanup hook.
   * @returns the routing token and the promise the caller awaits.
   */
  open(options: OpenOptions): PendingWaiter<T> {
    const token = this.mintToken()

    let settle: (value: T | undefined) => void = () => undefined
    const promise = new Promise<T | undefined>((resolve) => {
      settle = resolve
    })

    const onAbort = () => this.cancel(token)
    const entry: Entry<T> = {
      settle,
      detach: () => options.signal?.removeEventListener('abort', onAbort),
      onCancel: options.onCancel,
    }
    this.entries.set(token, entry)

    if (options.signal?.aborted) this.cancel(token)
    else options.signal?.addEventListener('abort', onAbort, { once: true })

    return { token, promise }
  }

  /**
   * Deliver an answer.
   *
   * @param token - the token from the pressed button.
   * @param value - the answer to resolve with.
   * @returns whether this call was the one that settled the waiter.
   */
  settle(token: string, value: T): boolean {
    const entry = this.entries.get(token)
    if (!entry) return false

    this.entries.delete(token)
    entry.detach()
    entry.settle(value)
    return true
  }

  /** Whether a token still routes to an open waiter. */
  has(token: string): boolean {
    return this.entries.has(token)
  }

  /** Cancel one waiter, resolving it with `undefined` and running its hook. */
  cancel(token: string): boolean {
    const entry = this.entries.get(token)
    if (!entry) return false

    this.entries.delete(token)
    entry.detach()
    entry.settle(undefined)
    entry.onCancel?.()
    return true
  }

  /** Cancel every open waiter — the plugin is unloading. */
  dispose(): void {
    for (const token of [...this.entries.keys()]) this.cancel(token)
  }

  /** A short, collision-free token drawn from a UUID's entropy. */
  private mintToken(): string {
    for (;;) {
      const token = randomUUID().replace(/-/g, '').slice(0, 12)
      if (!this.entries.has(token)) return token
    }
  }
}
