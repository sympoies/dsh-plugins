import { describe, expect, it } from 'vitest'

import { addressesBot, isGroupChat, stripMention } from '../src/telegram/addressing.js'
import type { TelegramMessage } from '../src/telegram/types.js'

const BOT = 'my_bot'
const BOT_ID = 4242

/** A message in whichever kind of chat a test needs. */
function message(fields: Partial<TelegramMessage>, type = 'supergroup'): TelegramMessage {
  return {
    message_id: 1,
    chat: { id: -100, type },
    from: { id: 7 },
    ...fields,
  } as TelegramMessage
}

/** Text plus the mention entity Telegram would have parsed out of it. */
function mentioning(handle: string, before = '') {
  const text = `${before}@${handle} what changed?`
  return {
    text,
    entities: [{ type: 'mention', offset: before.length, length: handle.length + 1 }],
  }
}

describe('isGroupChat', () => {
  it('recognises both group flavours', () => {
    expect(isGroupChat(message({}, 'group'))).toBe(true)
    expect(isGroupChat(message({}, 'supergroup'))).toBe(true)
  })

  it('does not treat a private chat as one', () => {
    expect(isGroupChat(message({}, 'private'))).toBe(false)
  })
})

describe('addressesBot — a private chat', () => {
  it('always addresses the bot, because nobody else is there', () => {
    expect(addressesBot(message({ text: 'hello' }, 'private'), BOT, BOT_ID)).toBe(true)
  })

  it('does so even for a message carrying no text at all', () => {
    expect(addressesBot(message({ photo: [{ file_id: 'p' }] }, 'private'), BOT, BOT_ID)).toBe(true)
  })
})

describe('addressesBot — a group', () => {
  it('ignores people talking to each other', () => {
    // The whole point: a bot that answers every line is one nobody keeps in
    // the room.
    expect(addressesBot(message({ text: 'did you see the deploy?' }), BOT, BOT_ID)).toBe(false)
  })

  it('answers when @mentioned', () => {
    expect(addressesBot(message(mentioning(BOT)), BOT, BOT_ID)).toBe(true)
  })

  it('answers when mentioned mid-sentence', () => {
    expect(addressesBot(message(mentioning(BOT, 'hey ')), BOT, BOT_ID)).toBe(true)
  })

  it('is not fooled by a longer handle that starts the same way', () => {
    // `@my_bot_staging` contains `@my_bot`; a substring search would hand
    // another bot's mentions to this one.
    expect(addressesBot(message(mentioning('my_bot_staging')), BOT, BOT_ID)).toBe(false)
  })

  it('ignores a mention of some other bot', () => {
    expect(addressesBot(message(mentioning('other_bot')), BOT, BOT_ID)).toBe(false)
  })

  it('matches a handle regardless of case', () => {
    expect(addressesBot(message(mentioning('My_Bot')), BOT, BOT_ID)).toBe(true)
  })

  it('answers a reply to something it said', () => {
    // This is what makes a group usable: nobody wants to re-@mention a bot
    // just to say "yes, do it".
    const replied = message({ text: 'yes, do it', reply_to_message: { message_id: 9, from: { id: BOT_ID } } })
    expect(addressesBot(replied, BOT, BOT_ID)).toBe(true)
  })

  it('ignores a reply to somebody else', () => {
    const replied = message({ text: 'agreed', reply_to_message: { message_id: 9, from: { id: 55 } } })
    expect(addressesBot(replied, BOT, BOT_ID)).toBe(false)
  })

  it('answers a text_mention, which is how a handle-less account is named', () => {
    const tagged = message({
      text: 'bot what changed?',
      entities: [{ type: 'text_mention', offset: 0, length: 3, user: { id: BOT_ID } }],
    })
    expect(addressesBot(tagged, BOT, BOT_ID)).toBe(true)
  })

  it('ignores a text_mention of somebody else', () => {
    const tagged = message({
      text: 'adam what changed?',
      entities: [{ type: 'text_mention', offset: 0, length: 4, user: { id: 55 } }],
    })
    expect(addressesBot(tagged, BOT, BOT_ID)).toBe(false)
  })

  it('reads a caption\'s entities, since a photo carries its text there', () => {
    const captioned = message({
      photo: [{ file_id: 'p' }],
      caption: `@${BOT} what is this?`,
      caption_entities: [{ type: 'mention', offset: 0, length: BOT.length + 1 }],
    })
    expect(addressesBot(captioned, BOT, BOT_ID)).toBe(true)
  })

  it('ignores a photo dropped in the room with no caption', () => {
    expect(addressesBot(message({ photo: [{ file_id: 'p' }] }), BOT, BOT_ID)).toBe(false)
  })

  it('cannot match a mention when the bot has no handle', () => {
    expect(addressesBot(message(mentioning(BOT)), undefined, BOT_ID)).toBe(false)
  })

  it('still answers a reply when the bot has no handle', () => {
    const replied = message({ text: 'go on', reply_to_message: { message_id: 9, from: { id: BOT_ID } } })
    expect(addressesBot(replied, undefined, BOT_ID)).toBe(true)
  })
})

describe('stripMention', () => {
  it('removes the bot\'s own name, which is addressing and not content', () => {
    expect(stripMention(`@${BOT} what changed?`, BOT)).toBe('what changed?')
  })

  it('removes it from the end too', () => {
    expect(stripMention(`what changed? @${BOT}`, BOT)).toBe('what changed?')
  })

  it('leaves another bot\'s mention alone, since that is content', () => {
    expect(stripMention('ask @other_bot about it', BOT)).toBe('ask @other_bot about it')
  })

  it('collapses the gap it leaves behind', () => {
    expect(stripMention(`hey @${BOT} look`, BOT)).toBe('hey look')
  })

  it('leaves text alone when the bot has no handle', () => {
    expect(stripMention('@my_bot hello', undefined)).toBe('@my_bot hello')
  })

  it('does not treat a handle as a pattern', () => {
    // A username cannot contain regex metacharacters, but building a pattern
    // from unvalidated input is how that stops being true.
    expect(stripMention('@a.c hello', 'a.c')).toBe('hello')
    // An unescaped dot would match any character, eating this one too.
    expect(stripMention('@abc hello', 'a.c')).toBe('@abc hello')
  })
})
