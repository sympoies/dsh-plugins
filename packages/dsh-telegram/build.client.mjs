/**
 * Build the browser half.
 *
 * The harness loads plugin bundles as lazy CJS factories: executing the script
 * only REGISTERS a factory, and every module body side effect runs later, when
 * the shell materializes it. So the output is an esbuild CJS bundle wrapped in
 * `window.__ModuleLoader__.load({ id, factory })`.
 *
 * This envelope is reproduced here rather than imported because the harness's
 * `clientBundle` preset is not published — its own documentation lists that as
 * a known limitation for plugins shipped outside its repository. That makes
 * this file the one place coupled to an internal format, which is why it is
 * small, commented, and asserted by `test/client-bundle.test.ts`.
 *
 * React, its JSX runtime, and the shell's own packages are marked external:
 * the loader answers those requires from the shell's seeded modules, and
 * bundling a second React would break hooks the moment the page mounted.
 */

import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** The module id the shell registers this bundle under: the package name. */
const { name: PACKAGE_NAME } = JSON.parse(await readFile('./package.json', 'utf8'))

/** Specifiers the shell provides; bundling any of them would be a second copy. */
const EXTERNAL = [
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-primitives',
]

const OUTPUT = './lib/client.js'

const result = await build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: EXTERNAL,
  write: false,
  outfile: OUTPUT,
  // A source map would be misaligned by the envelope's own lines, and a wrong
  // map costs more than no map.
  sourcemap: false,
  logLevel: 'warning',
})

const bundled = result.outputFiles[0].text

// Created here rather than assumed: the tests run this script directly, so on
// a fresh clone — where lib/ is gitignored and tsc has not run — the directory
// does not exist yet.
await mkdir(dirname(OUTPUT), { recursive: true })
await writeFile(OUTPUT, envelope(PACKAGE_NAME, bundled), 'utf8')
process.stdout.write(`client bundle: ${OUTPUT} (${(bundled.length / 1024).toFixed(1)} kB)\n`)

/**
 * Wrap a CJS bundle in the loader's registration envelope.
 *
 * `module`, `exports`, and `require` come from the factory closure, which is
 * what makes registration free and materialization lazy.
 *
 * @param id - module id the shell resolves; the package name.
 * @param code - the esbuild CJS bundle.
 * @returns the classic script the shell serves under /plugins.
 */
function envelope(id, code) {
  return `window.__ModuleLoader__.load({
  id: ${JSON.stringify(id)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    try {
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    } catch (e) { /* environments without Symbol support */ }
${code}
    return module.exports;
  }
});
`
}
