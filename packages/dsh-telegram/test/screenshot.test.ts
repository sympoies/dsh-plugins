import { writeFile } from 'node:fs/promises'

import { describe, expect, it, vi } from 'vitest'

import { PHOTO_LIMIT_BYTES, Screenshotter } from '../src/media/screenshot.js'

/** A capturer that writes whatever a test wants to find at the output path. */
function build(options: {
  bytes?: Uint8Array
  throws?: Error
  hang?: boolean
  platform?: string
} = {}) {
  const captured: string[] = []

  const run = async (output: string, signal: AbortSignal) => {
    captured.push(output)
    if (options.throws) throw options.throws
    if (options.hang) {
      await new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }
    await writeFile(output, options.bytes ?? new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
  }

  const shotter = new Screenshotter({
    run,
    timeoutMs: 50,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  })

  return { shotter, captured }
}

describe('Screenshotter — availability', () => {
  it('is available on macOS, which ships screencapture', () => {
    expect(new Screenshotter({ platform: 'darwin' }).available).toBe(true)
  })

  it('is not available where no capture tool is known', () => {
    expect(new Screenshotter({ platform: 'linux' }).available).toBe(false)
  })

  it('names the platform rather than failing vaguely', async () => {
    const shot = await new Screenshotter({ platform: 'linux' }).take()
    expect(shot).toEqual({ kind: 'unsupported', platform: 'linux' })
  })
})

describe('Screenshotter — taking one', () => {
  it('returns the bytes it captured', async () => {
    const { shotter } = build({ bytes: new Uint8Array([1, 2, 3, 4]) })
    const shot = await shotter.take()

    expect(shot.kind).toBe('image')
    expect([...(shot as { data: Uint8Array }).data]).toEqual([1, 2, 3, 4])
  })

  it('names it something Telegram will show as an image', async () => {
    const { shotter } = build()
    expect((await shotter.take()) as { filename: string }).toMatchObject({ filename: 'screen.png' })
  })

  it('captures to a fresh path each time, so two cannot collide', async () => {
    const { shotter, captured } = build()
    await shotter.take()
    await shotter.take()

    expect(captured[0]).not.toBe(captured[1])
  })

  it('leaves nothing behind on disk', async () => {
    const { shotter, captured } = build()
    await shotter.take()

    const { access } = await import('node:fs/promises')
    await expect(access(captured[0] as string)).rejects.toThrow()
  })

  it('cleans up after a failure too', async () => {
    const { shotter, captured } = build({ throws: new Error('nope') })
    await shotter.take()

    const { access } = await import('node:fs/promises')
    await expect(access(captured[0] as string)).rejects.toThrow()
  })
})

describe('Screenshotter — when it cannot', () => {
  it('recognises a missing capture tool', async () => {
    const { shotter } = build({ throws: new Error('spawn ENOENT') })
    expect(await shotter.take()).toEqual({
      kind: 'failed',
      reason: 'no screen capture tool was found',
    })
  })

  it('recognises a refused permission, which is the macOS trap', async () => {
    // Grant it in System Settings, or the capture silently returns a desktop
    // picture with no windows and the feature looks broken instead.
    const { shotter } = build({ throws: new Error('Operation not permitted') })
    expect(await shotter.take()).toMatchObject({ reason: 'the harness has no Screen Recording permission' })
  })

  it('gives up rather than hanging the command forever', async () => {
    const { shotter } = build({ hang: true })
    expect(await shotter.take()).toEqual({ kind: 'failed', reason: 'the capture took too long' })
  })

  it('reports an empty capture rather than sending nothing', async () => {
    const { shotter } = build({ bytes: new Uint8Array([]) })
    expect(await shotter.take()).toEqual({ kind: 'failed', reason: 'the capture came back empty' })
  })

  it('passes an unrecognised failure through in its own words', async () => {
    const { shotter } = build({ throws: new Error('disk is full') })
    expect(await shotter.take()).toMatchObject({ reason: 'disk is full' })
  })
})

describe('the photo limit', () => {
  it('is the ten megabytes Telegram accepts as a photo', () => {
    // Above it the capture goes as a document instead, which takes 50 MB —
    // a large display's PNG routinely needs that.
    expect(PHOTO_LIMIT_BYTES).toBe(10 * 1024 * 1024)
  })
})
