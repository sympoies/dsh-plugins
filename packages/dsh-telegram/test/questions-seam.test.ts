import { describe, expect, it, vi } from 'vitest'

import { installQuestionProvider } from '../src/harness/questions-seam.js'
import type { UserQuestionProvider, UserQuestionService } from '../src/harness/types.js'

/** A stand-in for ctx.userQuestions with the real single-provider rule. */
function fakeService(): UserQuestionService {
  return {
    provider: undefined,
    registerProvider(provider) {
      if (this.provider !== undefined) throw new Error('DUPLICATE_PROVIDER')
      this.provider = provider
      return () => {
        this.provider = undefined
      }
    },
  }
}

const ours: UserQuestionProvider = { ask: async () => ({ answers: [] }) }

describe('installQuestionProvider — empty slot', () => {
  it('registers directly when nothing is installed', () => {
    const service = fakeService()
    installQuestionProvider(service, () => ours)
    expect(service.provider).toBe(ours)
  })

  it('reports no incumbent', () => {
    const seam = installQuestionProvider(fakeService(), () => ours)
    expect(seam.previous).toBeUndefined()
  })

  it('clears the slot again on restore', () => {
    const service = fakeService()
    installQuestionProvider(service, () => ours).restore()
    expect(service.provider).toBeUndefined()
  })
})

describe('installQuestionProvider — taking over from the web UI', () => {
  it('installs itself even though a provider is already registered', () => {
    const service = fakeService()
    const web: UserQuestionProvider = { ask: async () => ({ answers: [] }) }
    service.registerProvider(web)

    installQuestionProvider(service, () => ours)
    expect(service.provider).toBe(ours)
  })

  it('hands the incumbent to the builder so it can be delegated to', () => {
    const service = fakeService()
    const web: UserQuestionProvider = { ask: async () => ({ answers: [] }) }
    service.registerProvider(web)

    const build = vi.fn(() => ours)
    installQuestionProvider(service, build)
    expect(build).toHaveBeenCalledWith(web)
  })

  it('reports the incumbent it displaced', () => {
    const service = fakeService()
    const web: UserQuestionProvider = { ask: async () => ({ answers: [] }) }
    service.registerProvider(web)

    expect(installQuestionProvider(service, () => ours).previous).toBe(web)
  })

  it('puts the web provider back on restore, so unloading changes nothing', () => {
    const service = fakeService()
    const web: UserQuestionProvider = { ask: async () => ({ answers: [] }) }
    service.registerProvider(web)

    installQuestionProvider(service, () => ours).restore()
    expect(service.provider).toBe(web)
  })
})
