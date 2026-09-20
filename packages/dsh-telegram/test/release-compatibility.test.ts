import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const workspace = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(resolve(workspace, 'package.json'), 'utf8'))
const release = JSON.parse(readFileSync(resolve(workspace, 'release/manifest.json'), 'utf8'))
const smoke = readFileSync(resolve(workspace, 'release/smoke.mjs'), 'utf8')

describe('release compatibility', () => {
  it('targets the exact DSH 0.1.6-alpha.2 dependency line without resolver bypasses', () => {
    expect(manifest.version).toBe('0.6.3')
    expect(manifest.dependencies).toMatchObject({
      '@deepseek-ai/cordis': '4.0.2',
      '@deepseek-ai/schemastery': '3.18.2',
    })
    expect(manifest.peerDependencies).toEqual({ '@deepseek-ai/dsh': '0.1.6-alpha.2' })
    expect(release.legacyPeerDeps).toBe(false)
    expect(release.smokeDependencies['@deepseek-ai/dsh-invariants']).toBe('0.1.6-alpha.2')
  })

  it('boots the enabled plugin through the exact packaged DSH profile', () => {
    expect(smoke).toContain("dshManifest.version !== '0.1.6-alpha.2'")
    expect(smoke).toContain("await ctx.plugin(Telegram, { enabled: true, tokenRef: 'release-token' })")
    expect(smoke).toContain("status?.state !== 'idle'")
  })
})
