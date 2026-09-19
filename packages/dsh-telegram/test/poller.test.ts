import { describe, expect, it, vi } from 'vitest'

import { UpdatePoller } from '../src/telegram/poller.js'
import type { TelegramUpdate } from '../src/telegram/types.js'

const update = (id: number): TelegramUpdate => ({ update_id: id })

/**
 * Build a poller over a scripted sequence of poll results, stopping the loop
 * once the script runs out so `run()` always terminates.
 */
function build(script: (TelegramUpdate[] | Error)[], onUpdate?: (u: TelegramUpdate) => Promise<void>) {
  const controller = new AbortController()
  const queue = [...script]
  const offsets: number[] = []
  const handled: number[] = []

  const poller = new UpdatePoller({
    source: {
      async getUpdates(offset) {
        offsets.push(offset)
        const next = queue.shift()
        if (next === undefined) {
          controller.abort()
          return []
        }
        if (next instanceof Error) throw next
        return next
      },
    },
    onUpdate:
      onUpdate ??
      (async (u) => {
        handled.push(u.update_id)
      }),
    sleep: async () => undefined,
  })

  return { poller, controller, offsets, handled }
}

describe('UpdatePoller — acknowledging', () => {
  it('starts from offset zero', async () => {
    const { poller, controller, offsets } = build([[]])
    await poller.run(controller.signal)
    expect(offsets[0]).toBe(0)
  })

  it('acknowledges past the last handled update', async () => {
    const { poller, controller, offsets } = build([[update(10), update(11)], []])
    await poller.run(controller.signal)

    expect(offsets[1]).toBe(12)
    expect(poller.acknowledged).toBe(12)
  })

  it('hands every update to the handler in order', async () => {
    const { poller, controller, handled } = build([[update(1), update(2), update(3)]])
    await poller.run(controller.signal)
    expect(handled).toEqual([1, 2, 3])
  })

  it('never moves the offset backwards', async () => {
    const { poller, controller } = build([[update(10)], [update(4)], []])
    await poller.run(controller.signal)
    expect(poller.acknowledged).toBe(11)
  })

  it('leaves a failed update unacknowledged so Telegram redelivers it', async () => {
    let seen = 0
    const { poller, controller, offsets } = build([[update(5), update(6)], []], async () => {
      seen += 1
      if (seen === 1) throw new Error('handler blew up')
    })

    await poller.run(controller.signal)
    // The first update was never acknowledged, so the offset stays at 0.
    expect(offsets[1]).toBe(0)
  })
})

describe('UpdatePoller — reconnecting', () => {
  it('retries after a failed poll', async () => {
    const { poller, controller, offsets } = build([new Error('network down'), [update(1)], []])
    await poller.run(controller.signal)
    expect(offsets.length).toBeGreaterThan(2)
  })

  it('backs off further on each consecutive failure', async () => {
    const delays: number[] = []
    const controller = new AbortController()
    const queue: (TelegramUpdate[] | Error)[] = [
      new Error('a'),
      new Error('b'),
      new Error('c'),
    ]

    const poller = new UpdatePoller({
      source: {
        async getUpdates() {
          const next = queue.shift()
          if (next === undefined) {
            controller.abort()
            return []
          }
          throw next
        },
      },
      onUpdate: async () => undefined,
      baseDelayMs: 100,
      sleep: async (ms) => void delays.push(ms),
    })

    await poller.run(controller.signal)
    expect(delays).toEqual([100, 200, 400])
  })

  it('caps the backoff so a long outage keeps retrying', async () => {
    const delays: number[] = []
    const controller = new AbortController()
    let failures = 0

    const poller = new UpdatePoller({
      source: {
        async getUpdates() {
          failures += 1
          if (failures > 12) {
            controller.abort()
            return []
          }
          throw new Error('still down')
        },
      },
      onUpdate: async () => undefined,
      baseDelayMs: 1000,
      maxDelayMs: 5000,
      sleep: async (ms) => void delays.push(ms),
    })

    await poller.run(controller.signal)
    expect(Math.max(...delays)).toBe(5000)
  })

  it('reports the first success after a failure', async () => {
    const onConnected = vi.fn()
    const controller = new AbortController()
    const queue: (TelegramUpdate[] | Error)[] = [new Error('down'), [], []]

    const poller = new UpdatePoller({
      source: {
        async getUpdates() {
          const next = queue.shift()
          if (next === undefined) {
            controller.abort()
            return []
          }
          if (next instanceof Error) throw next
          return next
        },
      },
      onUpdate: async () => undefined,
      onConnected,
      sleep: async () => undefined,
    })

    await poller.run(controller.signal)
    expect(onConnected).toHaveBeenCalledOnce()
  })
})

describe('UpdatePoller — stopping', () => {
  it('returns immediately when the signal is already aborted', async () => {
    const { poller, controller, offsets } = build([[update(1)]])
    controller.abort()
    await poller.run(controller.signal)
    expect(offsets).toHaveLength(0)
  })

  it('stops mid-batch when the signal aborts', async () => {
    const controller = new AbortController()
    const handled: number[] = []

    const poller = new UpdatePoller({
      source: {
        async getUpdates() {
          return [update(1), update(2), update(3)]
        },
      },
      onUpdate: async (u) => {
        handled.push(u.update_id)
        controller.abort()
      },
      sleep: async () => undefined,
    })

    await poller.run(controller.signal)
    expect(handled).toEqual([1])
  })

  it('does not retry after the signal aborts during a poll', async () => {
    const controller = new AbortController()
    let calls = 0

    const poller = new UpdatePoller({
      source: {
        async getUpdates() {
          calls += 1
          controller.abort()
          throw new Error('aborted')
        },
      },
      onUpdate: async () => undefined,
      sleep: async () => undefined,
    })

    await poller.run(controller.signal)
    expect(calls).toBe(1)
  })
})
