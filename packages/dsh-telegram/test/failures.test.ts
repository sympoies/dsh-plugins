import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FailureLog, recordingLogger } from '../src/failures.js'
import type { Logger } from '../src/harness/types.js'

let file: string

beforeEach(async () => {
  file = join(await mkdtemp(join(tmpdir(), 'dsh-telegram-fail-')), 'failures.json')
})

/** A clock that does not move, so timestamps are assertable. */
const now = () => new Date('2026-08-21T10:00:00.000Z')

describe('FailureLog', () => {
  it('keeps what went wrong', () => {
    const log = new FailureLog({ now })
    log.record('error', 'the harness is gone')

    expect(log.recent()).toEqual([
      { at: '2026-08-21T10:00:00.000Z', level: 'error', message: 'the harness is gone' },
    ])
  })

  it('puts the newest first, which is what anyone reads', () => {
    const log = new FailureLog({ now })
    log.record('warn', 'first')
    log.record('error', 'second')

    expect(log.recent().map((entry) => entry.message)).toEqual(['second', 'first'])
  })

  it('caps the ring, so one bad night cannot fill a phone screen', () => {
    const log = new FailureLog({ keep: 3, now })
    for (const message of ['a', 'b', 'c', 'd']) log.record('warn', message)

    expect(log.recent().map((entry) => entry.message)).toEqual(['d', 'c', 'b'])
  })

  it('never writes down a secret', async () => {
    // The ring goes to disk, so it must pass through the same guard every
    // other written thing does.
    const log = new FailureLog({ now, redact: (text) => text.split('sekrit').join('<redacted>') })
    log.record('error', 'fetch failed for bot sekrit /getMe')

    expect(log.recent()[0]?.message).not.toContain('sekrit')
    expect(log.recent()[0]?.message).toContain('<redacted>')
  })

  it('ignores an empty message rather than logging a blank line', () => {
    const log = new FailureLog({ now })
    log.record('warn', '   ')
    expect(log.recent()).toEqual([])
  })
})

describe('FailureLog — the file', () => {
  it('mirrors the ring, so it is readable when the bot is not', async () => {
    const log = new FailureLog({ file, now, flushMs: 1 })
    log.record('error', 'could not connect')
    await log.flush()

    const written = JSON.parse(await readFile(file, 'utf8')) as { message: string }[]
    expect(written[0]?.message).toBe('could not connect')
  })

  it('batches a burst into one write', async () => {
    const log = new FailureLog({ file, now, flushMs: 5 })
    for (let index = 0; index < 20; index += 1) log.record('warn', `failure ${index}`)
    await log.flush()

    const written = JSON.parse(await readFile(file, 'utf8')) as unknown[]
    expect(written).toHaveLength(20)
  })

  it('keeps working in memory when the file cannot be written', async () => {
    // This file exists to be readable when things are broken; failing to write
    // it must not become another failure.
    const log = new FailureLog({ file: '/nope/nowhere/failures.json', now })
    log.record('error', 'still recorded')
    await log.flush()

    expect(log.recent()).toHaveLength(1)
  })
})

describe('recordingLogger', () => {
  /** A base logger recording every level it was called at. */
  function base() {
    const calls: { level: string; message: string }[] = []
    const logger: Logger = {
      debug: (message) => void calls.push({ level: 'debug', message }),
      info: (message) => void calls.push({ level: 'info', message }),
      warn: (message) => void calls.push({ level: 'warn', message }),
      error: (message) => void calls.push({ level: 'error', message }),
    }
    return { logger, calls }
  }

  it('still passes everything to the sink the deployment composed', () => {
    const sink = base()
    const log = new FailureLog({ now })
    const logger = recordingLogger(sink.logger, log)

    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')

    expect(sink.calls.map((call) => call.level)).toEqual(['debug', 'info', 'warn', 'error'])
  })

  it('keeps only what is worth looking back at', () => {
    // A ring of twenty filled with routine chatter would push out the one line
    // that mattered.
    const log = new FailureLog({ now })
    const logger = recordingLogger(base().logger, log)

    logger.debug('routine')
    logger.info('routine')
    logger.warn('a problem')

    expect(log.recent().map((entry) => entry.message)).toEqual(['a problem'])
  })

  it('folds an Error argument into the line, not an object graph', () => {
    const log = new FailureLog({ now })
    recordingLogger(base().logger, log).error('could not resume', new Error('log is gone'))

    expect(log.recent()[0]?.message).toBe('could not resume log is gone')
  })

  it('survives an argument that cannot be serialized', () => {
    const log = new FailureLog({ now })
    const circular: Record<string, unknown> = {}
    circular.self = circular

    expect(() =>
      recordingLogger(base().logger, log).warn('odd', circular),
    ).not.toThrow()
    expect(log.recent()[0]?.message).toContain('unserializable')
  })
})
