/**
 * Slash commands.
 *
 * Telegram delivers a command as ordinary message text, and in a group it
 * arrives addressed — `/new@my_bot` — because several bots may share the chat.
 * Parsing is therefore a real step rather than a `startsWith`, and a command
 * addressed to a different bot must be ignored rather than executed.
 */

import { escapeHtml } from './render/escape.js'

/** A recognised command and the text that followed it. */
export interface ParsedCommand {
  /** Command name, lowercased, without the slash or the bot suffix. */
  readonly name: string
  /** Everything after the command, trimmed; empty when there was nothing. */
  readonly args: string
}

/** Telegram refuses a menu description longer than this. */
const MAX_MENU_DESCRIPTION = 256

/** Commands the plugin answers, with the one-line help shown by `/help`. */
export const COMMANDS: Readonly<Record<string, string>> = {
  start: 'Show what this bot is and whether you may use it',
  help: 'List the commands',
  claim: 'Take ownership of an unclaimed bot: /claim <code>',
  new: 'Start a fresh conversation, forgetting the current one',
  cd: 'Show or change the working directory: /cd ~/projects/app',
  model: 'Show or change the model: /model list, or /model provider/model',
  effort: 'Show or change the reasoning effort: /effort high',
  vision: 'Show or change the model that reads images: /vision off',
  permission: 'Show or change what the agent may do: /permission read-only',
  diag: 'Show what the plugin can see about itself, and recent failures',
  screenshot: "Send a picture of the harness machine's screen",
  sessions: 'Pick up an earlier conversation from this chat',
  status: 'Show the session, working directory, and who owns the bot',
  stop: 'Cancel whatever the agent is doing right now',
  whoami: 'Show your Telegram user id',
}

/**
 * Parse a message as a command.
 *
 * @param text - the raw message text.
 * @param botUsername - this bot's username, so `/cmd@other_bot` is ignored.
 * @returns the command, or undefined when the text is not one for us.
 */
export function parseCommand(text: string, botUsername?: string): ParsedCommand | undefined {
  const match = /^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i.exec(text.trim())
  if (!match) return undefined

  const addressed = match[2]
  if (addressed !== undefined && botUsername !== undefined) {
    if (addressed.toLowerCase() !== botUsername.toLowerCase()) return undefined
  }

  const name = (match[1] as string).toLowerCase()
  if (!(name in COMMANDS)) return undefined

  return { name, args: (match[3] ?? '').trim() }
}

/**
 * The command menu to publish, for the list Telegram shows on `/`.
 *
 * `/claim` is left out once the bot has an owner: it is the one command that
 * stops working the moment it succeeds, and offering it forever invites
 * everyone who opens the chat to try a code that can no longer be right.
 *
 * @param claimable - whether the bot is still waiting to be claimed.
 * @returns entries in menu order, descriptions clipped to Telegram's limit.
 */
export function commandMenu(claimable: boolean): { command: string; description: string }[] {
  return Object.entries(COMMANDS)
    .filter(([name]) => claimable || name !== 'claim')
    .map(([command, description]) => ({
      command,
      description: description.slice(0, MAX_MENU_DESCRIPTION),
    }))
}

/**
 * The `/help` body, rendered as Telegram HTML.
 *
 * The descriptions are prose, not markup, so they are escaped on the way in.
 * `/claim <code>` is the reason: sent raw with `parse_mode: HTML`, Telegram
 * read `<code>` as an unclosed tag and rejected the WHOLE message with a 400 —
 * so `/help` answered with silence, which reads as a dead bot rather than as a
 * malformed message. Escaping here means a description added later cannot do
 * it again.
 */
export function helpText(): string {
  const lines = Object.entries(COMMANDS).map(
    ([name, description]) => `/${name} — ${escapeHtml(description)}`,
  )
  return `<b>Commands</b>\n${lines.join('\n')}`
}
