/**
 * Keeps the whole suite out of the real DSH home.
 *
 * The plugin resolves its data directory from `DSH_HOME` at call time, and
 * falls back to `~/.dsh` when unset. A test that clears the variable while an
 * asynchronous start is still running therefore writes into the developer's
 * actual harness directory — which is how a claim code once landed there.
 *
 * Pinning it here, before any test file loads, removes the fallback entirely:
 * there is no window in which it is unset.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-telegram-suite-'))
