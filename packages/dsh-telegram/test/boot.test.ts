import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'

import * as Telegram from '../src/index.js'

const temporaryHomes: string[] = []

afterEach(async () => {
  delete process.env.DSH_HOME
  await Promise.all(temporaryHomes.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('package compatibility and boot', () => {
  it('composes through a real Cordis context and registers its settings namespace', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-telegram-boot-'))
    temporaryHomes.push(home)
    process.env.DSH_HOME = home

    const register = vi.fn(() => ({
      get: () => ({ enabled: false }),
      watch: () => () => undefined,
      update: async () => undefined,
    }))
    const ctx = new Context()
    ctx.provide('agents', {})
    ctx.provide('credentials', { resolve: async () => undefined })
    ctx.provide('settings', { register })

    try {
      await ctx.plugin(Telegram, { enabled: false })
      expect(register).toHaveBeenCalledWith(
        'telegram',
        Telegram.Config,
        expect.objectContaining({ base: expect.objectContaining({ enabled: false }) }),
      )
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
