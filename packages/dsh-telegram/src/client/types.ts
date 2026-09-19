/**
 * Structural mirrors of the harness browser runtime.
 *
 * Declared rather than imported for the same reason as the host-side mirrors:
 * these packages are supplied by the web shell at runtime and are marked
 * external in the client bundle, so depending on them at build time would
 * mean shipping a second copy of types the shell already owns — and pinning a
 * version this plugin has no say over.
 *
 * Sources mirrored:
 * - `@deepseek-ai/dsh-client-runtime`     — `ctx.slots`
 * - `@deepseek-ai/dsh-client-ui-settings` — `ctx.settingsScope`
 * - `@deepseek-ai/dsh-client-locale`      — `ctx.locale`
 * - `@deepseek-ai/dsh-api-remotes`        — the credentials wire
 */

import type { ComponentType } from 'react'

/** One namespace's client-side state. */
export interface SettingsSnapshot<T> {
  /** `loading` before the first section, `unavailable` when this client gets none. */
  readonly status: 'loading' | 'ready' | 'unavailable'
  /** The resolved section: schema defaults, then composition base, then user layer. */
  readonly value: T | undefined
  /** What a field reverts to once its override is cleared. */
  readonly base: unknown
  /** The raw user layer. A field's PRESENCE here marks it overridden. */
  readonly user: unknown
  /** Revision fencing the next write. */
  readonly revision: number | undefined
  /** Whether the host document accepts writes at all. */
  readonly writable: boolean
  /** `memory` means a remote browser whose preferences stay process-local. */
  readonly mode: 'host' | 'memory'
}

/** Reactive handle over one settings namespace. */
export interface SettingsScope<T> {
  getSnapshot(): SettingsSnapshot<T>
  subscribe(listener: () => void): () => void
  /**
   * Write one TOP-LEVEL field. The wire carries a single-element path, so a
   * nested value is written by setting its whole parent object.
   */
  set(field: string, value: unknown): Promise<void>
  /** Clear one top-level field's override, so it re-inherits the composed value. */
  unset(field: string): Promise<void>
}

/** How a slot entry describes itself to the shell. */
export interface SlotSpec {
  readonly name: string
  readonly id: string
  readonly order?: number
  readonly label?: () => string
  readonly locale?: string
}

/** The browser context this plugin's half binds to. */
export interface ClientContext {
  slots: {
    register(spec: SlotSpec, component: ComponentType<never>): () => void
    /** Install an effect for each lifetime of a declared slot. */
    inject(name: string, effect: () => () => void): void
  }
  locale: {
    register(namespace: string, locales: Record<string, unknown>): void
    bind(namespace: string): (key: string, params?: Record<string, unknown>) => string
  }
  settingsScope: {
    bind<T>(spec: { namespace: string; decode?: (section: unknown) => T | undefined }): SettingsScope<T>
  }
  /**
   * Service lookup. The wire face lives on the connection service as
   * `connection.api` — `ctx.remote` carries the forwarded-event face instead,
   * and reaching for it here would leave the token control silently inert.
   */
  get(key: 'connection'): { api: CredentialsRemote } | undefined
  effect(callback: () => (() => void) | void, label?: string): () => void
}

/**
 * Every remote call answers with an envelope, not the payload.
 *
 * A refusal the host reasoned about — an absent provider, a rejected value —
 * arrives as a resolved `ok: false`, not a rejection. Reading the payload
 * straight off the answer silently yields undefined for every field, which
 * reads as "nothing is configured and nothing is writable".
 */
export type RemoteAnswer<T> = {
  result: { ok: true; value: T } | { ok: false; error: { message: string } }
}

/** What the host knows about one credential reference. Never its value. */
export interface CredentialInfo {
  readonly configured: boolean
  /** Where it comes from: `env` shadows the managed file and cannot be written. */
  readonly source?: string
  readonly writable: boolean
}

/** One model the host has configured, as the catalog reports it. */
export interface CatalogModel {
  readonly id: string
  readonly name?: string
  readonly description?: string
}

/** Models grouped by the provider serving them. */
export interface CatalogGroup {
  readonly id: string
  readonly name?: string
  readonly models: readonly CatalogModel[]
}

/** The host calls this page makes. */
export interface CredentialsRemote {
  /**
   * The configured model catalog.
   *
   * It carries no modality information, so this page cannot tell which models
   * accept images; the host checks that when an image is actually sent.
   */
  llm: {
    models(payload: Record<string, never>): Promise<
      RemoteAnswer<{ groups: readonly CatalogGroup[] }>
    >
  }
  credentials: {
    describe(payload: {
      refs: string[]
    }): Promise<RemoteAnswer<{ credentials: Record<string, CredentialInfo> }>>
    set(payload: { ref: string; value: string }): Promise<RemoteAnswer<unknown>>
    unset(payload: { ref: string }): Promise<RemoteAnswer<unknown>>
  }
}
