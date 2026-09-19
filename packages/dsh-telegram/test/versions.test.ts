import { describe, expect, it } from 'vitest'

import { VersionCheck, compareVersions } from '../src/versions.js'

describe('compareVersions', () => {
  it('orders ordinary releases', () => {
    expect(compareVersions('0.3.0', '0.4.0')).toBeLessThan(0)
    expect(compareVersions('0.4.0', '0.3.0')).toBeGreaterThan(0)
    expect(compareVersions('0.4.0', '0.4.0')).toBe(0)
  })

  it('compares each part as a number, not as text', () => {
    // "0.10.0" < "0.9.0" as strings, which is the wrong way round.
    expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0)
  })

  it('orders prereleases of the same release numerically', () => {
    // The harness ships as 0.1.0-rc.8, and rc.8 < rc.10 is false as text.
    expect(compareVersions('0.1.0-rc.8', '0.1.0-rc.10')).toBeLessThan(0)
  })

  it('puts a release above any prerelease of it', () => {
    expect(compareVersions('1.0.0-rc.9', '1.0.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0', '1.0.0-rc.9')).toBeGreaterThan(0)
  })

  it('orders across releases before looking at prereleases', () => {
    expect(compareVersions('0.1.0-rc.8', '0.1.1-rc.1')).toBeLessThan(0)
  })

  it('sorts a shorter prerelease first', () => {
    expect(compareVersions('1.0.0-rc.1', '1.0.0-rc.1.1')).toBeLessThan(0)
  })

  it('sorts a numeric prerelease part below an alphanumeric one', () => {
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0)
  })

  it('ignores a leading v and build metadata', () => {
    expect(compareVersions('v1.2.3', '1.2.3+build.9')).toBe(0)
  })

  it('treats a missing part as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(compareVersions('1.2', '1.2.1')).toBeLessThan(0)
  })
})

/** A registry answering with whatever a test wants. */
function registry(options: { version?: string; ok?: boolean; throws?: boolean } = {}) {
  const asked: string[] = []
  const fetchImpl = async (url: string) => {
    asked.push(url)
    if (options.throws) throw new Error('offline')
    return {
      ok: options.ok !== false,
      json: async () => ({ version: options.version ?? '9.9.9' }),
    }
  }
  return { fetchImpl, asked }
}

describe('VersionCheck', () => {
  it('reports being behind what is published', async () => {
    const fake = registry({ version: '0.5.0' })
    const check = new VersionCheck({ fetchImpl: fake.fetchImpl })

    expect(await check.check('@a/b', '0.4.0')).toEqual({
      name: '@a/b',
      installed: '0.4.0',
      latest: '0.5.0',
      behind: true,
    })
  })

  it('reports being current', async () => {
    const fake = registry({ version: '0.4.0' })
    const check = new VersionCheck({ fetchImpl: fake.fetchImpl })

    expect((await check.check('@a/b', '0.4.0')).behind).toBe(false)
  })

  it('does not call a local build behind, having outrun the registry', async () => {
    const fake = registry({ version: '0.4.0' })
    const check = new VersionCheck({ fetchImpl: fake.fetchImpl })

    expect((await check.check('@a/b', '0.5.0')).behind).toBe(false)
  })

  it('escapes the scope, which is a path separator in a url', async () => {
    const fake = registry()
    await new VersionCheck({ fetchImpl: fake.fetchImpl }).check('@scope/name', '1.0.0')

    expect(fake.asked[0]).toBe('https://registry.npmjs.org/@scope%2Fname/latest')
  })

  it('asks for the one dist-tag, not the whole document', async () => {
    // A package's full metadata can be megabytes; one field is wanted.
    const fake = registry()
    await new VersionCheck({ fetchImpl: fake.fetchImpl }).check('@a/b', '1.0.0')
    expect(fake.asked[0]?.endsWith('/latest')).toBe(true)
  })

  it('says nothing about the registry when it cannot be reached', async () => {
    // Rather than claiming a version is current on a failed request.
    const fake = registry({ throws: true })
    const report = await new VersionCheck({ fetchImpl: fake.fetchImpl }).check('@a/b', '0.4.0')

    expect(report.latest).toBeUndefined()
    expect(report.behind).toBe(false)
  })

  it('says nothing when the registry refuses', async () => {
    const fake = registry({ ok: false })
    expect((await new VersionCheck({ fetchImpl: fake.fetchImpl }).check('@a/b', '1.0.0')).latest)
      .toBeUndefined()
  })

  it('remembers the answer, so /diag is free to run twice', async () => {
    const fake = registry()
    const check = new VersionCheck({ fetchImpl: fake.fetchImpl, now: () => 1000 })

    await check.check('@a/b', '1.0.0')
    await check.check('@a/b', '1.0.0')
    expect(fake.asked).toHaveLength(1)
  })

  it('asks again once the answer is stale', async () => {
    const fake = registry()
    let clock = 0
    const check = new VersionCheck({ fetchImpl: fake.fetchImpl, cacheMs: 100, now: () => clock })

    await check.check('@a/b', '1.0.0')
    clock = 500
    await check.check('@a/b', '1.0.0')

    expect(fake.asked).toHaveLength(2)
  })
})
