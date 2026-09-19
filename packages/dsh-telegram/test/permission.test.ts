import { describe, expect, it, vi } from 'vitest'

import { PermissionControl, matchPreset } from '../src/session/permission.js'

/** A deployment table plus a live-session store, as the harness supplies them. */
function harness(options: { names?: string[]; live?: string[]; setThrows?: boolean } = {}) {
  const applied: { session: string; name: string }[] = []
  const live = new Set(options.live ?? ['s1'])

  const presets = {
    names: options.names ?? ['read-only', 'workspace-write', 'danger-full-access'],
    set(session: unknown, name: string) {
      if (options.setThrows) throw new Error('the session is already ended')
      applied.push({ session: session as string, name })
    },
  }

  const sessions = { get: (id: string) => (live.has(id) ? id : undefined) }
  return { presets, sessions, applied }
}

function build(
  preset: string | undefined,
  options: Parameters<typeof harness>[0] & { bare?: boolean } = {},
) {
  const fake = harness(options)
  const control = new PermissionControl({
    ...(options.bare ? {} : { presets: fake.presets, sessions: fake.sessions }),
    preset: () => preset,
  })
  return { control, applied: fake.applied }
}

const CHAT = { chatId: '1' }

describe('matchPreset — the words somebody types on a phone', () => {
  const NAMES = ['read-only', 'workspace-write', 'danger-full-access']

  it('takes the exact name', () => {
    expect(matchPreset('workspace-write', NAMES)).toBe('workspace-write')
  })

  it('does not care about dashes, spaces or case', () => {
    // `full access`, `full-access` and `Full Access` are one request.
    expect(matchPreset('Workspace Write', NAMES)).toBe('workspace-write')
    expect(matchPreset('read_only', NAMES)).toBe('read-only')
  })

  it('takes a shorthand that names exactly one preset', () => {
    expect(matchPreset('readonly', NAMES)).toBe('read-only')
    expect(matchPreset('full', NAMES)).toBe('danger-full-access')
  })

  it('refuses a shorthand that could be either, rather than tossing a coin', () => {
    expect(matchPreset('e', NAMES)).toBeUndefined()
  })

  it('refuses a name nothing matches', () => {
    expect(matchPreset('yolo', NAMES)).toBeUndefined()
    expect(matchPreset('  ', NAMES)).toBeUndefined()
  })
})

describe('PermissionControl — choosing a preset', () => {
  it('puts the session on the configured preset', () => {
    // The deployment default is chosen for the surface the operator sits at;
    // Telegram is reachable from anywhere and may choose differently.
    const { control, applied } = build('workspace-write')
    control.apply(CHAT, 's1')

    expect(applied).toEqual([{ session: 's1', name: 'workspace-write' }])
  })

  it('leaves the deployment default alone when nothing is configured', () => {
    const { control, applied } = build(undefined)
    control.apply(CHAT, 's1')
    expect(applied).toEqual([])
  })

  it('treats an empty setting as "not configured"', () => {
    const { control, applied } = build('   ')
    control.apply(CHAT, 's1')
    expect(applied).toEqual([])
  })

  it('reads the setting per session, so a change reaches the next conversation', () => {
    const fake = harness()
    const queue = ['read-only', 'workspace-write']
    const control = new PermissionControl({
      presets: fake.presets,
      sessions: fake.sessions,
      preset: () => queue.shift(),
    })

    control.apply(CHAT, 's1')
    control.apply(CHAT, 's1')

    expect(fake.applied.map((entry) => entry.name)).toEqual(['read-only', 'workspace-write'])
  })
})

describe('PermissionControl — when it cannot', () => {
  it('keeps the default rather than failing on an unknown name', () => {
    const { control, applied } = build('typo-mode')
    control.apply(CHAT, 's1')
    expect(applied).toEqual([])
  })

  it('complains once about a bad name, not once per conversation', () => {
    const warn = vi.fn()
    const fake = harness()
    const control = new PermissionControl({
      presets: fake.presets,
      sessions: fake.sessions,
      preset: () => 'typo-mode',
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    })

    control.apply(CHAT, 's1')
    control.apply(CHAT, 's1')
    control.apply(CHAT, 's1')

    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('workspace-write')
  })

  it('does nothing for a session that is not live', () => {
    const { control, applied } = build('workspace-write', { live: [] })
    control.apply(CHAT, 'gone')
    expect(applied).toEqual([])
  })

  it('survives a table that refuses the switch', () => {
    const { control } = build('workspace-write', { setThrows: true })
    expect(() => control.apply(CHAT, 's1')).not.toThrow()
  })

  it('does nothing at all where the deployment composes no preset table', () => {
    const { control, applied } = build('workspace-write', { bare: true })
    control.apply(CHAT, 's1')
    expect(applied).toEqual([])
  })
})

describe('PermissionControl — what it reports', () => {
  it('is available only with both a table and a session store', () => {
    expect(build('workspace-write').control.available).toBe(true)
    expect(build('workspace-write', { bare: true }).control.available).toBe(false)
  })

  it('names the presets the deployment defines, for a message that lists them', () => {
    expect(build(undefined).control.names).toEqual([
      'read-only',
      'workspace-write',
      'danger-full-access',
    ])
  })
})
