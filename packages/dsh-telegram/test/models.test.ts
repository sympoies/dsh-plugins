import { describe, expect, it } from 'vitest'

import { effortsFor, formatRoute, listCatalog, matchEffort, matchRoute } from '../src/session/models.js'
import type { CatalogProvider } from '../src/session/models.js'

const CATALOG: CatalogProvider[] = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }],
  },
  { id: 'xiaomi', models: [{ id: 'mimo-v2.5' }, { id: 'deepseek-v4-pro' }] },
]

/** A catalog service, optionally with one provider that cannot be read. */
function catalog(options: { broken?: string; empty?: string; noReasoning?: boolean } = {}) {
  return {
    listProviders: () => CATALOG.map(({ id, name }) => ({ id, ...(name ? { name } : {}) })),
    async listModels(provider: string) {
      if (provider === options.broken) throw new Error('no api key')
      if (provider === options.empty) return []
      return CATALOG.find((entry) => entry.id === provider)?.models ?? []
    },
    async resolveModelInfo(provider: string, _model: string) {
      if (provider === options.broken) throw new Error('no api key')
      if (options.noReasoning) return {}
      return {
        reasoning: {
          efforts: [{ id: 'low' }, { id: 'medium', name: 'Balanced' }, { id: 'high' }],
          defaultEffort: 'medium',
        },
      }
    },
  }
}

const ROUTE = { provider: 'xiaomi', model: 'mimo-v2.5' }

describe('listCatalog', () => {
  it('lists every configured provider with its models', async () => {
    const listed = await listCatalog(catalog())
    expect(listed.map((entry) => entry.id)).toEqual(['deepseek-official', 'xiaomi'])
  })

  it('skips a provider whose catalog cannot be read', async () => {
    // One bad key should not hide every other model.
    const listed = await listCatalog(catalog({ broken: 'xiaomi' }))
    expect(listed.map((entry) => entry.id)).toEqual(['deepseek-official'])
  })

  it('drops a provider that advertises nothing', async () => {
    const listed = await listCatalog(catalog({ empty: 'xiaomi' }))
    expect(listed.map((entry) => entry.id)).toEqual(['deepseek-official'])
  })
})

describe('matchRoute — what a user types', () => {
  it('takes a fully qualified route', () => {
    expect(matchRoute('xiaomi/mimo-v2.5', CATALOG)).toEqual({
      kind: 'route',
      route: { provider: 'xiaomi', model: 'mimo-v2.5' },
    })
  })

  it('takes a bare model id when only one provider offers it', () => {
    // What anyone types first, and unambiguous often enough to support.
    expect(matchRoute('mimo-v2.5', CATALOG)).toEqual({
      kind: 'route',
      route: { provider: 'xiaomi', model: 'mimo-v2.5' },
    })
  })

  it('matches a bare id regardless of case', () => {
    expect(matchRoute('MiMo-v2.5', CATALOG)).toMatchObject({ kind: 'route' })
  })

  it('refuses to guess when several providers offer the same id', () => {
    const matched = matchRoute('deepseek-v4-pro', CATALOG)
    expect(matched.kind).toBe('ambiguous')
    expect((matched as { candidates: string[] }).candidates).toEqual([
      'deepseek-official/deepseek-v4-pro',
      'xiaomi/deepseek-v4-pro',
    ])
  })

  it('takes a route on a configured provider even when the catalog does not list it', () => {
    // A catalog can lag behind a model the provider actually serves; refusing
    // would make this stricter than the web UI's own picker.
    expect(matchRoute('xiaomi/mimo-v3-preview', CATALOG)).toEqual({
      kind: 'route',
      route: { provider: 'xiaomi', model: 'mimo-v3-preview' },
    })
  })

  it('refuses a provider that is not configured at all', () => {
    expect(matchRoute('openai/gpt-5', CATALOG).kind).toBe('unknown')
  })

  it('refuses a model nobody offers', () => {
    expect(matchRoute('imaginary-model', CATALOG).kind).toBe('unknown')
  })

  it('refuses empty input', () => {
    expect(matchRoute('   ', CATALOG).kind).toBe('unknown')
  })

  it('keeps a model id that contains slashes, as a router-style provider has', () => {
    const routed = matchRoute('xiaomi/openai/gpt-5', CATALOG)
    expect(routed).toEqual({ kind: 'route', route: { provider: 'xiaomi', model: 'openai/gpt-5' } })
  })
})

describe('effortsFor', () => {
  it('reads what the model itself offers', async () => {
    // low/medium/high is one provider's vocabulary, not everyone's; offering
    // an effort a model lacks would fail the turn rather than the command.
    const reasoning = await effortsFor(catalog(), ROUTE)
    expect(reasoning?.efforts.map((option) => option.id)).toEqual(['low', 'medium', 'high'])
    expect(reasoning?.defaultEffort).toBe('medium')
  })

  it('says nothing for a model that offers no choice', async () => {
    expect(await effortsFor(catalog({ noReasoning: true }), ROUTE)).toBeUndefined()
  })

  it('says nothing when the catalog cannot be read', async () => {
    expect(await effortsFor(catalog({ broken: 'xiaomi' }), ROUTE)).toBeUndefined()
  })

  it('says nothing without a route to ask about', async () => {
    expect(await effortsFor(catalog(), undefined)).toBeUndefined()
  })
})

describe('matchEffort', () => {
  const EFFORTS = [{ id: 'low' }, { id: 'medium', name: 'Balanced' }, { id: 'high' }]

  it('takes an effort id', () => {
    expect(matchEffort('high', EFFORTS)).toBe('high')
  })

  it('does not care about case', () => {
    expect(matchEffort('HIGH', EFFORTS)).toBe('high')
  })

  it('takes the display name, which is what a person reads off the list', () => {
    expect(matchEffort('Balanced', EFFORTS)).toBe('medium')
  })

  it('refuses one the model does not offer', () => {
    expect(matchEffort('maximum', EFFORTS)).toBeUndefined()
    expect(matchEffort('  ', EFFORTS)).toBeUndefined()
  })

  it('refuses everything when the model offers nothing', () => {
    expect(matchEffort('high', [])).toBeUndefined()
  })
})

describe('formatRoute', () => {
  it('renders a route the way it is typed back in', () => {
    expect(formatRoute({ provider: 'xiaomi', model: 'mimo-v2.5' })).toBe('xiaomi/mimo-v2.5')
  })

  it('names the absence of one in words, not as an empty string', () => {
    expect(formatRoute(undefined)).toBe('the deployment default')
  })
})
