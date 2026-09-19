import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import { AccessPolicy } from '../src/access.js'

let file: string

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-telegram-access-'))
  file = join(dir, 'owner.json')
})

describe('AccessPolicy — explicit allowlist', () => {
  it('admits a listed user', async () => {
    const policy = await AccessPolicy.open(file, { allowFrom: [7], claimCode: 'code' })
    expect(policy.check(7)).toBe('allowed')
  })

  it('refuses an unlisted user', async () => {
    const policy = await AccessPolicy.open(file, { allowFrom: [7], claimCode: 'code' })
    expect(policy.check(8)).toBe('denied')
  })

  it('does not offer a claim when an allowlist is configured', async () => {
    const policy = await AccessPolicy.open(file, { allowFrom: [7], claimCode: 'code' })
    expect(policy.check(8)).not.toBe('unclaimed')
  })
})

describe('AccessPolicy — claiming an unowned bot', () => {
  it('refuses everyone until someone claims it', async () => {
    const policy = await AccessPolicy.open(file, { allowFrom: [], claimCode: 'secret' })
    expect(policy.check(7)).toBe('unclaimed')
  })

  it('admits the user who presents the claim code', async () => {
    const policy = await AccessPolicy.open(file, { allowFrom: [], claimCode: 'secret' })
    expect(await policy.claim(7, 'secret')).toBe(true)
    expect(policy.check(7)).toBe('allowed')
  })

  it('refuses a wrong claim code', async () => {
    const policy = await AccessPolicy.open(file, { allowFrom: [], claimCode: 'secret' })
    expect(await policy.claim(7, 'wrong')).toBe(false)
    expect(policy.check(7)).toBe('unclaimed')
  })

  it('refuses a second claimant once the bot is owned', async () => {
    const policy = await AccessPolicy.open(file, { allowFrom: [], claimCode: 'secret' })
    await policy.claim(7, 'secret')

    expect(await policy.claim(8, 'secret')).toBe(false)
    expect(policy.check(8)).toBe('denied')
  })

  it('remembers the owner across a restart', async () => {
    const first = await AccessPolicy.open(file, { allowFrom: [], claimCode: 'secret' })
    await first.claim(7, 'secret')

    // A fresh process mints a different claim code; ownership must not reset.
    const second = await AccessPolicy.open(file, { allowFrom: [], claimCode: 'a-different-code' })
    expect(second.check(7)).toBe('allowed')
    expect(second.check(8)).toBe('denied')
  })

  it('compares claim codes in constant time regardless of length', async () => {
    const policy = await AccessPolicy.open(file, { allowFrom: [], claimCode: 'secret' })
    expect(await policy.claim(7, '')).toBe(false)
    expect(await policy.claim(7, 'secret-but-longer')).toBe(false)
  })
})

describe('AccessPolicy — combined', () => {
  it('admits both the allowlist and the recorded owner', async () => {
    const policy = await AccessPolicy.open(file, { allowFrom: [7], claimCode: 'secret' })
    expect(policy.check(7)).toBe('allowed')
    expect(policy.check(9)).toBe('denied')
  })

  it('reports who owns the bot', async () => {
    const policy = await AccessPolicy.open(file, { allowFrom: [], claimCode: 'secret' })
    expect(policy.owner()).toBeUndefined()
    await policy.claim(7, 'secret')
    expect(policy.owner()).toBe(7)
  })
})


describe('AccessPolicy — publishing the claim code', () => {
  /** Where the code is dropped for an operator whose console ate the log. */
  let codeFile: string

  beforeEach(() => {
    codeFile = `${file}.code.txt`
  })

  it('writes the code where the operator can read it', async () => {
    await AccessPolicy.open(file, { allowFrom: [], claimCode: 'secret', claimCodeFile: codeFile })
    expect(await readFile(codeFile, 'utf8')).toContain('/claim secret')
  })

  it('writes it owner-only, since reading it is taking the bot', async () => {
    await AccessPolicy.open(file, { allowFrom: [], claimCode: 'secret', claimCodeFile: codeFile })
    const mode = (await stat(codeFile)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('removes it the moment the bot is claimed', async () => {
    const policy = await AccessPolicy.open(file, {
      allowFrom: [],
      claimCode: 'secret',
      claimCodeFile: codeFile,
    })
    await policy.claim(7, 'secret')
    await expect(readFile(codeFile, 'utf8')).rejects.toThrow()
  })

  it('leaves none behind for an already-claimed bot', async () => {
    const first = await AccessPolicy.open(file, {
      allowFrom: [],
      claimCode: 'secret',
      claimCodeFile: codeFile,
    })
    await first.claim(7, 'secret')

    await AccessPolicy.open(file, { allowFrom: [], claimCode: 'new', claimCodeFile: codeFile })
    await expect(readFile(codeFile, 'utf8')).rejects.toThrow()
  })

  it('writes none when an allowlist makes claiming impossible', async () => {
    await AccessPolicy.open(file, { allowFrom: [7], claimCode: 'secret', claimCodeFile: codeFile })
    await expect(readFile(codeFile, 'utf8')).rejects.toThrow()
  })

  it('still works when no file is configured', async () => {
    const policy = await AccessPolicy.open(file, { allowFrom: [], claimCode: 'secret' })
    expect(await policy.claim(7, 'secret')).toBe(true)
  })
})
