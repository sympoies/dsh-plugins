import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { load } from 'js-yaml'

const require = createRequire(import.meta.url)
const dshManifestPath = require.resolve('@deepseek-ai/dsh/package.json')
const telegramManifestPath = require.resolve('@sympoies/dsh-telegram/package.json')
const dshManifest = JSON.parse(readFileSync(dshManifestPath, 'utf8'))
const telegramManifest = JSON.parse(readFileSync(telegramManifestPath, 'utf8'))
const telegramEntryPath = require.resolve('@sympoies/dsh-telegram')
const cordisEntryPath = require.resolve('@deepseek-ai/cordis', {
  paths: [dirname(telegramManifestPath)],
})

if (dshManifest.version !== '0.1.1-rc.2') {
  throw new Error(`expected @deepseek-ai/dsh@0.1.1-rc.2, received ${dshManifest.version}`)
}
if (telegramManifest.name !== '@sympoies/dsh-telegram') {
  throw new Error(`unexpected Telegram package identity ${telegramManifest.name}`)
}

const installationNodeModules = dirname(dirname(dirname(telegramManifestPath)))
const dshHome = mkdtempSync(join(tmpdir(), 'dsh-telegram-release-smoke-'))
const profileDir = join(dshHome, 'profiles', 'release')
const previousDshHome = process.env.DSH_HOME

try {
  process.env.DSH_HOME = dshHome

  const [Telegram, { Context }] = await Promise.all([
    import(pathToFileURL(telegramEntryPath).href),
    import(pathToFileURL(cordisEntryPath).href),
  ])
  if (Telegram.name !== '@sympoies/dsh-telegram' || typeof Telegram.apply !== 'function') {
    throw new Error('packaged Telegram entrypoint does not expose its plugin contract')
  }

  const ctx = new Context()
  ctx.provide('agents', {})
  ctx.provide('credentials', { resolve: async () => undefined })
  ctx.provide('settings', {
    register: () => ({
      get: () => ({ enabled: false }),
      watch: () => () => undefined,
      update: async () => undefined,
    }),
  })
  try {
    await ctx.plugin(Telegram, { enabled: false })
  } finally {
    await ctx.fiber.dispose()
  }

  mkdirSync(profileDir, { recursive: true })
  symlinkSync(installationNodeModules, join(profileDir, 'node_modules'), 'dir')
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
    private: true,
    type: 'module',
    dependencies: {
      '@sympoies/dsh-telegram': telegramManifest.version,
    },
    dsh: {
      profile: {
        bundles: ['@sympoies/dsh-telegram'],
      },
    },
  }, null, 2)}\n`)
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')

  const output = execFileSync(
    process.execPath,
    [join(dirname(dshManifestPath), 'lib', 'bin.js'), '--profile', 'release', '--dump-config'],
    {
      cwd: process.cwd(),
      env: { ...process.env, DSH_HOME: dshHome },
      encoding: 'utf8',
    },
  )
  const rows = load(output)
  if (!Array.isArray(rows)) throw new Error('DSH profile dump did not contain a row list')
  const telegram = rows.find((row) => row?.id === 'telegram')
  if (telegram?.name !== '@sympoies/dsh-telegram') {
    throw new Error('DSH did not compose the packaged Telegram bundle')
  }
} finally {
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  rmSync(dshHome, { recursive: true, force: true })
}
