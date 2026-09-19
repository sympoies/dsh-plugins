import { describe, expect, it, vi } from 'vitest'

import { AlbumBuffer, captionOf } from '../src/telegram/albums.js'
import type { TelegramMessage } from '../src/telegram/types.js'

/** One part of an album, or a lone message when no group id is given. */
function part(messageId: number, groupId?: string, caption?: string): TelegramMessage {
  return {
    message_id: messageId,
    chat: { id: 1, type: 'private' },
    from: { id: 7 },
    photo: [{ file_id: `p${messageId}` }],
    ...(groupId === undefined ? {} : { media_group_id: groupId }),
    ...(caption === undefined ? {} : { caption }),
  } as TelegramMessage
}

function build(options: { windowMs?: number; maxParts?: number } = {}) {
  const delivered: TelegramMessage[][] = []
  const buffer = new AlbumBuffer({
    deliver: (messages) => void delivered.push(messages),
    windowMs: options.windowMs ?? 20,
    ...(options.maxParts === undefined ? {} : { maxParts: options.maxParts }),
  })
  return { buffer, delivered }
}

describe('AlbumBuffer — what it takes', () => {
  it('leaves an ordinary message alone', () => {
    // A lone photo is already a whole message; waiting on it would add
    // latency for nothing.
    const { buffer, delivered } = build()
    expect(buffer.offer(part(1))).toBe(false)
    expect(delivered).toEqual([])
  })

  it('takes a message that belongs to an album', () => {
    const { buffer } = build()
    expect(buffer.offer(part(1, 'g1'))).toBe(true)
  })
})

describe('AlbumBuffer — gathering', () => {
  it('delivers the whole album once, not each part', async () => {
    const { buffer, delivered } = build()
    buffer.offer(part(1, 'g1'))
    buffer.offer(part(2, 'g1'))
    buffer.offer(part(3, 'g1'))

    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    expect(delivered[0]?.map((message) => message.message_id)).toEqual([1, 2, 3])
  })

  it('waits for the album to stop growing, not for a fixed time', async () => {
    const { buffer, delivered } = build({ windowMs: 40 })
    buffer.offer(part(1, 'g1'))

    await new Promise((resolve) => setTimeout(resolve, 25))
    buffer.offer(part(2, 'g1'))
    expect(delivered).toHaveLength(0)

    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    expect(delivered[0]).toHaveLength(2)
  })

  it('puts the parts in the order they were sent', async () => {
    // Telegram numbers them even when it delivers out of order, and the order
    // decides which image the caption belongs to.
    const { buffer, delivered } = build()
    buffer.offer(part(3, 'g1'))
    buffer.offer(part(1, 'g1'))
    buffer.offer(part(2, 'g1'))

    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    expect(delivered[0]?.map((message) => message.message_id)).toEqual([1, 2, 3])
  })

  it('keeps two albums apart', async () => {
    const { buffer, delivered } = build()
    buffer.offer(part(1, 'g1'))
    buffer.offer(part(2, 'g2'))

    await vi.waitFor(() => expect(delivered).toHaveLength(2))
    const ids = delivered.map((group) => group.map((message) => message.message_id))
    expect(ids).toContainEqual([1])
    expect(ids).toContainEqual([2])
  })

  it('cuts an album off at the platform limit rather than growing forever', async () => {
    const { buffer, delivered } = build({ maxParts: 3 })
    for (let index = 1; index <= 5; index += 1) buffer.offer(part(index, 'g1'))

    await vi.waitFor(() => expect(delivered.length).toBeGreaterThanOrEqual(2))
    expect(delivered[0]).toHaveLength(3)
    expect(delivered.flat()).toHaveLength(5)
  })
})

describe('AlbumBuffer — shutting down', () => {
  it('delivers what it is holding when asked to flush', () => {
    const { buffer, delivered } = build({ windowMs: 10_000 })
    buffer.offer(part(1, 'g1'))
    buffer.flush()

    expect(delivered).toHaveLength(1)
  })

  it('delivers nothing more after disposal', async () => {
    const { buffer, delivered } = build()
    buffer.offer(part(1, 'g1'))
    buffer.dispose()

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(delivered).toEqual([])
  })
})

describe('captionOf', () => {
  it('finds the one caption an album carries', () => {
    expect(captionOf([part(1, 'g1'), part(2, 'g1', 'what changed?')])).toBe('what changed?')
  })

  it('takes the first, since that is the one the sender typed', () => {
    expect(captionOf([part(1, 'g1', 'first'), part(2, 'g1', 'second')])).toBe('first')
  })

  it('answers nothing for an album with no caption at all', () => {
    expect(captionOf([part(1, 'g1'), part(2, 'g1')])).toBeUndefined()
  })

  it('ignores a caption that is only whitespace', () => {
    expect(captionOf([part(1, 'g1', '   '), part(2, 'g1', 'real')])).toBe('real')
  })
})
