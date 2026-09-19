/**
 * dsh-telegram, browser half.
 *
 * The harness scans enabled loader entries for packages declaring
 * `dsh.client`, resolves their `./client` export, and serves the bundle — so
 * this file needs no registration beyond existing. It claims one seat in the
 * Settings navigation and renders the page there.
 *
 * The two halves are paired by nothing but the settings namespace string: the
 * host registers it, this binds it, and the shell never learns what it means.
 */

import { TelegramPanel } from './panel.js'
import type { TelegramSettings } from './panel.js'
import { locales } from './locale.js'
import type { LocaleKey } from './locale.js'
import type { ClientContext } from './types.js'

/** Cordis plugin name, as the browser loader reports it. */
export const name = '@sympoies/dsh-telegram'

/**
 * Cordis SERVICES this half reads as properties — not packages.
 *
 * Every direct `ctx.<service>` access must be listed here or cordis refuses it
 * with "cannot get property … without inject". `connection` is deliberately
 * absent: it is reached through `ctx.get()`, which reads the store without the
 * inject requirement, so a deployment without it degrades to a page that
 * cannot edit the token rather than an entry that fails to apply.
 */
export const inject = ['slots', 'locale', 'settingsScope']

/** Must match `SETTINGS_NAMESPACE` in the host half. */
const NAMESPACE = 'telegram'

/** Places the page after the built-in sections without displacing them. */
const NAV_ORDER = 61

/**
 * Register the settings page.
 *
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    ctx.locale.register(NAMESPACE, locales)
  }, 'dsh-telegram: locales')

  const translate = ctx.locale.bind(NAMESPACE) as (
    key: LocaleKey,
    params?: Record<string, unknown>,
  ) => string

  // Binding the scope here — not inside the component — keeps it on this
  // plugin's fiber, so the page can mount and unmount freely without churning
  // the settings subscription.
  const scope = ctx.settingsScope.bind<TelegramSettings>({ namespace: NAMESPACE })

  // The credentials wire rides the connection service, not ctx.remote.
  const connection = ctx.get('connection')

  const Section = function TelegramSection() {
    if (!connection) return null
    return <TelegramPanel scope={scope} remote={connection.api} t={translate} />
  }

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: NAMESPACE,
        order: NAV_ORDER,
        label: () => translate('nav'),
        locale: NAMESPACE,
      },
      Section as never,
    ),
  )
}
