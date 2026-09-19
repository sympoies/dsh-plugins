import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

import { beforeAll, describe, expect, it, vi } from 'vitest'

const run = promisify(execFile)

/**
 * The browser half is the one part of this plugin coupled to a harness format
 * that is not published — the lazy-CJS factory envelope. These tests pin that
 * contract: if a harness upgrade changes it, the failure lands here with a
 * name that says what broke, rather than as a blank Settings page.
 */

let bundle: string

beforeAll(async () => {
  await run('node', ['build.client.mjs'], { cwd: process.cwd() })
  bundle = await readFile('lib/client.js', 'utf8')
}, 60_000)

describe('client bundle — registration envelope', () => {
  it('registers with the shell module loader rather than running on load', () => {
    expect(bundle.startsWith('window.__ModuleLoader__.load({')).toBe(true)
  })

  it('registers under the package name, which is how the shell resolves it', () => {
    expect(bundle).toContain('id: "@sympoies/dsh-telegram"')
  })

  it('exposes the factory a require, so materialization stays lazy', () => {
    expect(bundle).toContain('factory: (require) =>')
  })

  it('returns module exports from the factory', () => {
    expect(bundle).toContain('return module.exports;')
  })
})

describe('client bundle — externals', () => {
  it('does not bundle a second React, which would break every hook', () => {
    expect(bundle).toContain('require("react")')
    // A bundled React would carry its internals; a required one names nothing.
    expect(bundle).not.toContain('__SECRET_INTERNALS_DO_NOT_USE')
  })

  it('requires nothing the shell does not seed', () => {
    const required = [...bundle.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1])
    const seeded = new Set([
      'react',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'react-dom',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-settings',
    ])
    for (const specifier of required) expect(seeded.has(specifier as string)).toBe(true)
  })
})

/** Materialize the bundle exactly as the shell does, then read its exports. */
function materializeWith(bundle: string): Record<string, unknown> {
  let registered: { id: string; factory: (require: (id: string) => unknown) => unknown } | undefined
  const loader = { load: (entry: never) => void (registered = entry) }

  // eslint-disable-next-line no-new-func -- this is the shell's own execution model.
  new Function('window', bundle)({ __ModuleLoader__: loader })
  if (!registered) throw new Error('the bundle registered no module')

  const stub = (id: string) => {
    if (id === 'react') return { useState: () => [], useEffect: () => undefined }
    if (id === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: null }
    throw new Error(`unexpected require: ${id}`)
  }

  return registered.factory(stub) as Record<string, unknown>
}

describe('client bundle — what the factory produces', () => {
  /** Materialize the bundle exactly as the shell does, then read its exports. */
  function materialize(): { apply?: (ctx: unknown) => void } {
    let registered: { id: string; factory: (require: (id: string) => unknown) => unknown } | undefined
    const loader = { load: (entry: never) => void (registered = entry) }

    // eslint-disable-next-line no-new-func -- this is the shell's own execution model.
    new Function('window', bundle)({ __ModuleLoader__: loader })
    expect(registered).toBeDefined()

    const stub = (id: string) => {
      if (id === 'react') return { useState: () => [], useEffect: () => undefined }
      if (id === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: null }
      throw new Error(`unexpected require: ${id}`)
    }

    return (registered as NonNullable<typeof registered>).factory(stub) as { apply?: (ctx: unknown) => void }
  }

  it('registers exactly one module when the script runs', () => {
    expect(() => materialize()).not.toThrow()
  })

  it('exports the apply the cordis loader calls', () => {
    expect(typeof materialize().apply).toBe('function')
  })

  it('claims a seat in the settings navigation', () => {
    const registerSlot = vi.fn()
    const inject = vi.fn((_name: string, effect: () => unknown) => void effect())

    materialize().apply?.({
      effect: (callback: () => void) => callback(),
      locale: { register: vi.fn(), bind: () => (key: string) => key },
      settingsScope: { bind: () => ({ getSnapshot: () => ({}), subscribe: () => () => undefined }) },
      slots: { register: registerSlot, inject },
      get: () => ({ api: { credentials: {}, llm: {} } }),
    })

    expect(inject).toHaveBeenCalledWith('settings.section', expect.any(Function))
    expect(registerSlot).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'settings.section', id: 'telegram' }),
      expect.any(Function),
    )
  })

  it('binds the same settings namespace the host half registers', () => {
    const bind = vi.fn(() => ({ getSnapshot: () => ({}), subscribe: () => () => undefined }))

    materialize().apply?.({
      effect: (callback: () => void) => callback(),
      locale: { register: vi.fn(), bind: () => (key: string) => key },
      settingsScope: { bind },
      slots: { register: vi.fn(), inject: (_n: string, e: () => unknown) => void e() },
      get: () => ({ api: { credentials: {}, llm: {} } }),
    })

    expect(bind).toHaveBeenCalledWith({ namespace: 'telegram' })
  })

  it('registers its locales under that namespace too', () => {
    const register = vi.fn()

    materialize().apply?.({
      effect: (callback: () => void) => callback(),
      locale: { register, bind: () => (key: string) => key },
      settingsScope: { bind: () => ({ getSnapshot: () => ({}), subscribe: () => () => undefined }) },
      slots: { register: vi.fn(), inject: (_n: string, e: () => unknown) => void e() },
      get: () => ({ api: { credentials: {}, llm: {} } }),
    })

    expect(register).toHaveBeenCalledWith('telegram', expect.objectContaining({ en: expect.anything() }))
  })
})

/** Module-scope materializer for the injection tests. */
function materializeModule(): Record<string, unknown> {
  return materializeWith(bundle)
}

describe('client bundle — service injection', () => {
  it('names every service it reads, which is what cordis enforces', () => {
    const module = materializeModule() as { inject?: string[] }
    const declared = new Set(module.inject ?? [])

    /**
     * A context that refuses an undeclared service exactly the way cordis
     * does — "cannot get property X without inject". Reproducing that rule
     * here is the only way a stubbed test can catch a missing declaration;
     * a permissive stub passes and the real shell fails to apply the entry.
     */
    const services: Record<string, unknown> = {
      slots: { register: () => undefined, inject: (_n: string, e: () => unknown) => void e() },
      locale: { register: () => undefined, bind: () => (key: string) => key },
      settingsScope: {
        bind: () => ({ getSnapshot: () => ({}), subscribe: () => () => undefined }),
      },
    }

    // Context METHODS are always available; only services need declaring.
    const methods: Record<string, unknown> = {
      effect: (callback: () => void) => callback(),
      get: () => ({ api: { credentials: {}, llm: {} } }),
      on: () => () => undefined,
    }

    const ctx = new Proxy(
      {},
      {
        get(_target, property: string) {
          if (property in methods) return methods[property]
          if (!declared.has(property)) {
            throw new Error(`cannot get property "${property}" without inject`)
          }
          return services[property]
        },
      },
    )

    expect(() => (module as { apply?: (c: unknown) => void }).apply?.(ctx)).not.toThrow()
  })

  it('declares a plugin name, as the loader reports it', () => {
    expect((materializeModule() as { name?: string }).name).toBe('@sympoies/dsh-telegram')
  })

  it('does not over-declare services it never reads', () => {
    const declared = (materializeModule() as { inject?: string[] }).inject ?? []
    for (const service of declared) {
      // A declared service that is never read makes the entry wait — or fail —
      // on something the plugin does not actually need.
      expect(bundle).toContain(`ctx.${service}`)
    }
  })
})

describe('client bundle — translations', () => {
  /** Load the dictionary the bundle ships. */
  async function dictionaries(): Promise<Record<string, Record<string, string>>> {
    const { locales } = (await import('../src/client/locale.js')) as {
      locales: Record<string, Record<string, string>>
    }
    return locales
  }

  it('files its strings under the shell\'s locale tags', async () => {
    // The shell selects by `en`, not BCP 47. A dictionary under `en-US`
    // matches nothing and every label renders as its own key.
    expect(Object.keys(await dictionaries())).toEqual(['en'])
  })

  it('leaves no string empty, which would render as a blank control', async () => {
    const locales = await dictionaries()
    for (const [tag, dictionary] of Object.entries(locales)) {
      for (const [key, text] of Object.entries(dictionary)) {
        expect(text.trim(), `${tag}.${key}`).not.toBe('')
      }
    }
  })

  it('registers the dictionary the shell can actually read', () => {
    const register = vi.fn()

    ;(materializeModule() as { apply?: (c: unknown) => void }).apply?.({
      effect: (callback: () => void) => callback(),
      locale: { register, bind: () => (key: string) => key },
      settingsScope: { bind: () => ({ getSnapshot: () => ({}), subscribe: () => () => undefined }) },
      slots: { register: vi.fn(), inject: (_n: string, e: () => unknown) => void e() },
      get: () => ({ api: { credentials: {}, llm: {} } }),
    })

    const [, dictionary] = register.mock.calls[0] as [string, Record<string, unknown>]
    expect(Object.keys(dictionary)).toEqual(['en'])
  })
})
