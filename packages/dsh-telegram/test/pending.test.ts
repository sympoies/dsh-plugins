import { describe, expect, it } from 'vitest'

import { PendingRegistry } from '../src/interact/pending.js'

describe('PendingRegistry', () => {
  it('hands out a token short enough for Telegram callback data', () => {
    const registry = new PendingRegistry<string>()
    const { token } = registry.open({})
    // Telegram caps callback_data at 64 bytes and the token shares it with a
    // kind prefix and an option index.
    expect(token.length).toBeLessThanOrEqual(16)
    expect(token).toMatch(/^[a-z0-9]+$/)
  })

  it('hands out a different token each time', () => {
    const registry = new PendingRegistry<string>()
    const tokens = new Set(Array.from({ length: 200 }, () => registry.open({}).token))
    expect(tokens.size).toBe(200)
  })

  it('resolves the waiter with the settled value', async () => {
    const registry = new PendingRegistry<string>()
    const { token, promise } = registry.open({})
    expect(registry.settle(token, 'yes')).toBe(true)
    await expect(promise).resolves.toBe('yes')
  })

  it('lets only the first claimant settle', async () => {
    const registry = new PendingRegistry<string>()
    const { token, promise } = registry.open({})
    registry.settle(token, 'first')
    expect(registry.settle(token, 'second')).toBe(false)
    await expect(promise).resolves.toBe('first')
  })

  it('reports an unknown token as unsettled', () => {
    const registry = new PendingRegistry<string>()
    expect(registry.settle('nope', 'x')).toBe(false)
  })

  it('knows which tokens are still open', () => {
    const registry = new PendingRegistry<string>()
    const { token } = registry.open({})
    expect(registry.has(token)).toBe(true)
    registry.settle(token, 'x')
    expect(registry.has(token)).toBe(false)
  })

  it('cancels a waiter when its signal aborts', async () => {
    const registry = new PendingRegistry<string>()
    const controller = new AbortController()
    const { promise } = registry.open({ signal: controller.signal })
    controller.abort()
    await expect(promise).resolves.toBeUndefined()
  })

  it('cancels immediately for an already-aborted signal', async () => {
    const registry = new PendingRegistry<string>()
    const controller = new AbortController()
    controller.abort()
    const { promise } = registry.open({ signal: controller.signal })
    await expect(promise).resolves.toBeUndefined()
  })

  it('runs the cancel hook so a stale keyboard can be cleaned up', async () => {
    const registry = new PendingRegistry<string>()
    const controller = new AbortController()
    let cancelled = false
    registry.open({ signal: controller.signal, onCancel: () => void (cancelled = true) })
    controller.abort()
    await Promise.resolve()
    expect(cancelled).toBe(true)
  })

  it('does not run the cancel hook when the waiter was answered', async () => {
    const registry = new PendingRegistry<string>()
    let cancelled = false
    const { token } = registry.open({ onCancel: () => void (cancelled = true) })
    registry.settle(token, 'answered')
    expect(cancelled).toBe(false)
  })

  it('cancels every open waiter on dispose', async () => {
    const registry = new PendingRegistry<string>()
    const a = registry.open({})
    const b = registry.open({})
    registry.dispose()
    await expect(a.promise).resolves.toBeUndefined()
    await expect(b.promise).resolves.toBeUndefined()
    expect(registry.has(a.token)).toBe(false)
  })
})
