/**
 * Strings for the settings page.
 *
 * The dictionary key is `en` — the shell's own tag, not BCP 47. A dictionary
 * filed under `en-US` matches nothing, and `ctx.locale.bind`
 * answers an unresolved key with the key itself, so the page renders the word
 * "heading" where its heading should be. `test/client-bundle.test.ts` pins the
 * tags for that reason.
 */

/** Every string the page renders, keyed by the locale the shell selects. */
export const locales = {
  en: {
    nav: 'Telegram',
    heading: 'Telegram',
    subheading: 'Talk to the agent from Telegram, with real formatting and answerable questions.',

    loading: 'Reading configuration…',
    unavailable:
      'This browser cannot reach the settings document, so nothing here can be changed. Settings are loopback-only — open the harness on the machine running it.',
    readonly: 'The settings document is read-only in this deployment.',

    connectionTitle: 'Connection',
    enabled: 'Connected',
    enabledHint: 'Turn off to disconnect the bot without removing the plugin.',
    tokenTitle: 'Bot token',
    tokenChecking: 'Checking…',
    tokenCheckFailed: 'Could not check the stored token: {reason}',
    tokenRetry: 'Check again',
    tokenReadOnly: 'This credential is read-only in this deployment.',
    tokenConfigured: 'A token is stored.',
    tokenMissing: 'No token yet. Create a bot with @BotFather and paste its token here.',
    tokenFromEnvironment: 'Supplied by the environment, so it cannot be changed here.',
    tokenPlaceholder: 'Paste a bot token',
    tokenSave: 'Save token',
    tokenClear: 'Remove token',
    tokenSaved: 'Token saved. Reconnecting.',
    tokenRef: 'Credential reference',
    tokenRefHint: 'Where the token is stored. Change it only to keep several bots apart.',
    baseUrl: 'Bot API address',
    baseUrlHint: 'Change only when routing through a proxy.',

    accessTitle: 'Access',
    accessWarning:
      'Anyone allowed here can make the agent run commands on this machine. Leave the list empty to hand the bot to one person with the claim code printed on the console.',
    allowFrom: 'Allowed Telegram user ids',
    allowFromHint: 'Comma separated. Empty enables the one-time claim flow. Send /whoami to find an id.',
    allowFromInvalid: 'Enter numeric user ids separated by commas.',

    mediaTitle: 'Attachments',
    mediaEnabled: 'Read images and text files',
    mediaHint: 'Off replies that attachments are not accepted.',
    visionModel: 'Model that reads images',
    visionModelHint:
      'Chosen from the models added in Settings → Models. It must accept images — no DeepSeek model does. An image is read in a session of its own, and only what it says joins your conversation, which therefore keeps its own model and tools.',
    visionModelNone: 'Send the image to the conversation itself',
    visionModelLoading: 'Reading the configured models…',
    visionModelUnreadable: 'Could not read the configured models. Add one in Settings → Models.',
    visionModelUnavailable: 'No longer configured',

    screenTitle: 'Screen',
    screenshotEnabled: 'Allow /screenshot',
    screenshotHint:
      "Sends a picture of this machine's screen to the chat. Off by default — a screen holds whatever happens to be on it. On macOS the harness also needs Screen Recording permission.",

    repliesTitle: 'Replies',
    streamingEnabled: 'Stream the answer as it is written',
    streamingHint: 'Off sends each reply once, when it is finished.',
    throttle: 'Minimum gap between edits (ms)',
    throttleHint: 'Telegram rate-limits rapid edits to one chat. Below about a second invites that.',

    advancedTitle: 'Advanced',
    cwd: 'Working directory for new conversations',
    cwdHint: 'Empty uses the directory the harness was started in.',
    longPoll: 'Long-poll seconds',
    timeout: 'Request timeout (ms)',

    overridden: 'changed',
    reset: 'Reset',
    saveFailed: 'That change was not saved: {reason}',
  },
} as const

/** Keys the page may ask for; a typo becomes a type error rather than a blank. */
export type LocaleKey = keyof (typeof locales)['en']

/** Translate one key, used where a real locale binding is not available. */
export type Translate = (key: LocaleKey, params?: Record<string, unknown>) => string
