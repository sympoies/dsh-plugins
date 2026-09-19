import { describe, expect, it } from 'vitest'

import { installModelSelection } from '../src/harness/model-selection.js'
import type { AgentContextLike, MutableSelection } from '../src/harness/model-selection.js'

/**
 * These pin a contract this plugin reproduces rather than imports.
 *
 * The harness exports `installModelSelection`, but a plugin cannot reach it:
 * under pnpm's isolated layout it resolves only its own dependencies, and the
 * dynamic import that once stood here failed every time — which is how the
 * vision-model setting came to do nothing while looking like it worked.
 *
 * So the coupling is to two event names and their payloads, and these tests
 * are what make a drift in either fail loudly instead of silently.
 */
function fakeAgentContext() {
  const listeners = new Map<string, Function>()
  const disposed: string[] = []

  const ctx = {
    on(event: string, listener: Function) {
      listeners.set(event, listener)
      return () => void disposed.push(event)
    },
  } as unknown as AgentContextLike

  return {
    ctx,
    listeners,
    disposed,
    /** Drive one prompt assembly, as the harness would. */
    assemble: (assembled: Record<string, unknown>) =>
      (listeners.get('system-prompt/assemble') as Function)(undefined, undefined, async () => assembled),
    /** Drive one model request, as the harness would. */
    request: (resolved: Record<string, unknown>) =>
      (listeners.get('agent/request') as Function)(undefined, async () => resolved),
  }
}

const ROUTE = { provider: 'xiaomi', model: 'mimo-v2.5' }

describe('installModelSelection — what it hooks', () => {
  it('registers on both the events the route depends on', () => {
    const agent = fakeAgentContext()
    installModelSelection(agent.ctx, {})

    expect([...agent.listeners.keys()].sort()).toEqual([
      'agent/request',
      'system-prompt/assemble',
    ])
  })

  it('removes both listeners when disposed', () => {
    const agent = fakeAgentContext()
    installModelSelection(agent.ctx, {})()

    expect(agent.disposed.sort()).toEqual(['agent/request', 'system-prompt/assemble'])
  })
})

describe('installModelSelection — with no override', () => {
  it('leaves the assembly untouched', async () => {
    const agent = fakeAgentContext()
    installModelSelection(agent.ctx, {})

    const assembled = await agent.assemble({ variables: { provider: 'deepseek', model: 'flash' } })
    expect(assembled).toEqual({ variables: { provider: 'deepseek', model: 'flash' } })
  })

  it('leaves the request on the agent\'s own route', async () => {
    const agent = fakeAgentContext()
    installModelSelection(agent.ctx, {})

    await agent.assemble({})
    const request = await agent.request({ provider: 'deepseek', model: 'flash' })
    expect(request).toEqual({ provider: 'deepseek', model: 'flash' })
  })
})

describe('installModelSelection — with an override', () => {
  it('rewrites the prompt variables, which is what {{model}} reads', async () => {
    // A turn whose variables still name the old model fails prompt assembly.
    const agent = fakeAgentContext()
    installModelSelection(agent.ctx, { current: ROUTE })

    const assembled = (await agent.assemble({
      variables: { provider: 'deepseek', model: 'flash', other: 'kept' },
    })) as { variables: Record<string, unknown> }

    expect(assembled.variables).toEqual({ provider: 'xiaomi', model: 'mimo-v2.5', other: 'kept' })
  })

  it('routes the request to the override — the part that decides the model', async () => {
    const agent = fakeAgentContext()
    installModelSelection(agent.ctx, { current: ROUTE })

    await agent.assemble({})
    const request = (await agent.request({ provider: 'deepseek', model: 'flash' })) as {
      provider: string
      model: string
    }

    expect(request.provider).toBe('xiaomi')
    expect(request.model).toBe('mimo-v2.5')
  })

  it('drops an effort inherited from the model it replaced', async () => {
    // An effort one model offers, another may not.
    const agent = fakeAgentContext()
    installModelSelection(agent.ctx, { current: ROUTE })

    await agent.assemble({})
    const request = (await agent.request({
      provider: 'deepseek',
      model: 'flash',
      reasoningEffort: 'high',
    })) as Record<string, unknown>

    expect(request.reasoningEffort).toBeUndefined()
  })

  it('applies an effort the override names', async () => {
    const agent = fakeAgentContext()
    installModelSelection(agent.ctx, { current: { ...ROUTE, reasoningEffort: 'low' } })

    await agent.assemble({})
    const request = (await agent.request({ provider: 'deepseek', model: 'flash' })) as Record<
      string,
      unknown
    >

    expect(request.reasoningEffort).toBe('low')
  })

  it('keeps everything else the request carried', async () => {
    const agent = fakeAgentContext()
    installModelSelection(agent.ctx, { current: ROUTE })

    await agent.assemble({})
    const request = (await agent.request({
      provider: 'deepseek',
      model: 'flash',
      maxTokens: 4096,
    })) as Record<string, unknown>

    expect(request.maxTokens).toBe(4096)
  })
})

describe('installModelSelection — assembly and request agree', () => {
  it('routes on what assembly used, not on a later change', async () => {
    // Both halves of one step must agree, or a step is assembled for one model
    // and sent to another.
    const selection: MutableSelection = { current: ROUTE }
    const agent = fakeAgentContext()
    installModelSelection(agent.ctx, selection)

    await agent.assemble({})
    selection.current = { provider: 'other', model: 'changed-midway' }

    const request = (await agent.request({ provider: 'deepseek', model: 'flash' })) as {
      model: string
    }
    expect(request.model).toBe('mimo-v2.5')
  })

  it('picks up a change at the next assembly', async () => {
    const selection: MutableSelection = { current: undefined }
    const agent = fakeAgentContext()
    installModelSelection(agent.ctx, selection)

    selection.current = ROUTE
    await agent.assemble({})

    const request = (await agent.request({ provider: 'deepseek', model: 'flash' })) as {
      model: string
    }
    expect(request.model).toBe('mimo-v2.5')
  })

  it('reverts when the override is dropped', async () => {
    const selection: MutableSelection = { current: ROUTE }
    const agent = fakeAgentContext()
    installModelSelection(agent.ctx, selection)

    await agent.assemble({})
    selection.current = undefined
    await agent.assemble({})

    const request = await agent.request({ provider: 'deepseek', model: 'flash' })
    expect(request).toEqual({ provider: 'deepseek', model: 'flash' })
  })
})
