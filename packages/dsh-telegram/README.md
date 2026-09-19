<div align="center">

<h1>dsh-telegram</h1>

<p><strong>Talk to your agent from Telegram — and actually answer it when it asks something.</strong></p>

<p>
  <a href="https://github.com/sympoies/dsh-plugins/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/sympoies/dsh-plugins/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/@sympoies/dsh-telegram"><img alt="npm" src="https://img.shields.io/npm/v/%40sympoies/dsh-telegram?logo=npm&logoColor=white&color=cb3837"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/npm/l/%40sympoies/dsh-telegram?color=3da639"></a>
  <a href="package.json"><img alt="node" src="https://img.shields.io/node/v/%40sympoies/dsh-telegram?logo=node.js&logoColor=white&color=5fa04e"></a>
  <a href="https://core.telegram.org/bots/api"><img alt="Bot API" src="https://img.shields.io/badge/Bot%20API-10.1%2B-2ca5e0?logo=telegram&logoColor=white"></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DeepSeek Harness" src="https://img.shields.io/badge/DeepSeek-Harness-4d6bfe"></a>
</p>

</div>

A Telegram front end for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

This package is independently maintained by Sympoies from Adam Suchiha
Fizullah's MIT-licensed
[`@ashafizullah/dsh-telegram`](https://github.com/ashafizullah/dsh-telegram).
The exact imported source and downstream repair are recorded in [NOTICE](NOTICE).

Talk to your agent from your phone — and actually *answer* it when it asks something.

## Why this exists

Running an agent from a chat app breaks down at two specific points, and this
plugin is built around fixing them.

**The agent writes markdown; Telegram was getting it raw.** Models answer with
`**bold**`, headings, tables, task lists and fenced code. Sent as plain text,
all of that arrives as literal asterisks and pipes.

Since Bot API 10.1 Telegram parses markdown itself, so this plugin forwards the
agent's reply almost verbatim through `sendRichMessage` — tables render as
tables, checklists as checklists — and the message cap rises from 4096 to
32768 characters with it.

**The agent asks questions; there was nowhere to answer them.** When the agent
calls `ask_user_question`, or a tool needs your permission, the harness blocks
and waits for a UI to answer. Only the browser could. A conversation held
entirely in Telegram would stall on the first question with no way to clear it.
This plugin registers itself as that UI, so questions and approvals arrive as
buttons in the chat.

## Requirements

- DeepSeek Harness with a profile you can add plugins to
- **Bot API 10.1 or later**, for `sendRichMessage` and `sendRichMessageDraft`
- Node 24 or later

There is no HTML fallback. Telegram's rich markdown parser is forgiving — an
unterminated code fence or a line of stray markers is accepted rather than
rejected — so a mid-stream frame does not need one.

## Install

```bash
npx @deepseek-ai/dsh plugin --profile web add -w @sympoies/dsh-telegram
```

Or from a checkout, to develop against it:

```bash
git clone https://github.com/sympoies/dsh-plugins.git
cd dsh-plugins
npm ci
npm run build --workspace @sympoies/dsh-telegram

npx @deepseek-ai/dsh plugin --profile web add -w "$(pwd)/packages/dsh-telegram"
```

Then give it a bot token. Create a bot with [@BotFather](https://t.me/BotFather)
and store the token under the credential reference — never in a config file:

```bash
npx @deepseek-ai/dsh credentials set TELEGRAM_BOT_TOKEN
```

Start the profile. The console prints a claim code:

```
[dsh-telegram] this bot has no owner yet. Message @your_bot with:

    /claim 3f9a2b1c
```

Send that to your bot and it is yours. Until then it answers nobody.

The code is also written to `$DSH_HOME/dsh-telegram/claim-code.txt`, owner-only,
because several profiles compose no console sink at all and a code nobody can
read makes the bot permanently unusable.

## Access

A Telegram bot is reachable by anyone who knows its handle, and the agent behind
it can run shell commands on your machine. So the default is closed.

- **Claim flow** (default): the first person to send the console-printed code
  becomes the owner. Ownership is durable and single-shot — a later claim is
  refused even with the right code, so a leaked code grants nothing.
- **Allowlist**: set `allowFrom` to a list of Telegram user ids to skip claiming
  entirely. Use `/whoami` to find your id.

The claim code changes on every restart and is never sent over Telegram.

## Commands

| Command | What it does |
| --- | --- |
| `/start` | What this bot is, and whether you may use it |
| `/help` | List the commands |
| `/claim <code>` | Take ownership of an unclaimed bot |
| `/new` | Start a fresh conversation, forgetting the current one |
| `/cd [path]` | Show or change the working directory |
| `/model [what]` | Show the model, `/model list`, or switch to one |
| `/effort [level]` | Show or change how hard the model thinks |
| `/vision [what]` | Show, change, or turn off the model that reads images |
| `/permission [name]` | Show or change what the agent may do here |
| `/diag` | What the plugin can see about itself, and recent failures |
| `/screenshot` | Send a picture of the harness machine's screen |
| `/sessions` | Pick up an earlier conversation from this chat |
| `/status` | Session id, working directory, and whether it is loaded |
| `/stop` | Cancel whatever the agent is doing right now |
| `/whoami` | Your Telegram user id |

### In a group

A bot that answers every line is one nobody keeps in the room, so in a group it
answers only when @mentioned or replied to — the convention people already use.
Its own mention is stripped before the prompt, because that is addressing
rather than content, and replying to something it said continues the exchange
without an @mention on every line. Private chats are untouched. Set
`requireMentionInGroups` to `false` for the older behaviour.

The mention is compared against Telegram's own parsed span rather than searched
for in the text: `@mybot_staging` contains `@mybot`, and a substring match would
hand another bot's mentions to this one.

### What the agent is allowed to do

A deployment picks one permission default for everything it runs, usually with
the web UI in mind: loopback-only, with a person watching. A Telegram bot is
reachable from anywhere and gated by a list of user ids, so the same
`danger-full-access` reads differently there. `permissionPreset` names one of
the deployment's own presets for Telegram conversations alone.

It also decides whether the approval buttons work: under a preset whose
approval policy is `never` nothing ever asks, so they can never appear.
Choosing one that asks is what turns them on.

### A picture of the screen

`/screenshot` sends what the harness machine is showing. It is the reason the
bot exists, applied to the screen itself: the machine is at a desk and you are
not, so checking what a long build is showing needs a trip back to the keyboard
otherwise.

It is **off by default**, and the switch is a deployment setting rather than a
chat command on purpose. A screen holds whatever happens to be on it — an open
password manager, someone else's messages, an unrelated customer's data — and
this is the one thing here that sends the machine's own contents outward
without the agent being involved. Turning it on should take the same access as
configuring the bot.

macOS also needs Screen Recording permission for the process running the
harness. Without it `screencapture` still succeeds and returns the desktop
picture with no windows, which looks like a broken feature rather than a
missing permission, so that case is named rather than shrugged at. Grant it in
System Settings → Privacy & Security → Screen Recording and restart the
harness.

A capture over Telegram's 10 MB photo limit is sent as a document instead,
which takes 50 MB — a large display's PNG routinely needs it.

### Effort, and what the agent may do

`/effort` shows how hard the model thinks and lists what *that model* offers —
read from the model itself, because `low`/`medium`/`high` is one provider's
vocabulary rather than everyone's, and offering an effort a model does not have
would fail the turn instead of the command. `/effort default` gives it back.

`/permission` shows what the agent may do here and switches it: `read-only`,
`workspace-write`, `danger-full-access`, or whatever else the deployment
defines — the names are read from its own table, not fixed here. Spelling is
forgiving, so `full access`, `full-access` and `readonly` all land, and a
shorthand matching two presets is refused rather than guessed at. The change
applies to the conversation in flight as well as the next one, because the
reason to tighten it is usually the turn about to run.

Each of these is per conversation and sits on top of what the settings page
configures. That is two surfaces showing related state, so the commands say
which layer answered: once a conversation has chosen for itself, its reply
names the deployment default underneath. Without that the page reads as though
it were lying — it shows one thing while the chat does another, and nothing
connects them. `/… default` gives a conversation back to the deployment.

`/status` answers all of it in one message — session, directory, model, effort,
permission — since having to run four commands to learn what you are talking to
is four commands too many.

### Which model, and which conversation

`/model` says which model the conversation is on, `/model list` shows what is
configured, and `/model provider/model` switches. A bare model id works when
only one provider offers it; when several do, it asks which. Unlike `/cd` this
does not restart anything — the harness reads a mutable selection while
assembling each step, so the change lands on the next message with the history
intact. `/model default` gives the conversation back to the deployment.

`/sessions` offers this chat's earlier conversations as buttons. `/new` is
otherwise a one-way door: the harness keeps every log, but the binding naming
the current one is replaced, and from a phone there is no other way back. The
list is this plugin's own, so it holds conversations from this chat rather than
every session the web UI ever opened.

### Which tools the agent has

A preset supplies them. The registries are host-plane, but almost every
model-facing row — bash, the editor, grep, skills, subagents, todo, plan mode —
is registered into a *preset's* scope layer, so an agent that joins no preset
reaches the model with only whatever the host composition registered globally.
Telegram sessions are composed from the deployment's default preset, or from
`agentPreset` when one is named, and the choice is recorded in the session
header so a later reader resolves the same composition.

### Where the agent works

`/cd` on its own says where the conversation is; `/cd ~/projects/app` moves it.
Absolute paths, `~`, and paths relative to where the conversation already is all
work, and a pasted path keeps its quotes off.

Moving starts a fresh conversation, and the bot says so. That is not a shortcut:
the sandbox derives its writable root from the session's working directory, and
that root is fixed when the session opens — so a directory change is a new
session by construction. The choice is remembered per chat and survives both
`/new` and a restart, which is why it is kept apart from the session binding
that `/new` discards.

A directory that does not exist, one that turns out to be a file, and one that
cannot be read are three different mistakes and get three different sentences.
Each leaves the conversation exactly where it was.

They are published to Telegram on every connection, so typing `/` in the chat
offers the list with descriptions. `/claim` drops off it once the bot has an
owner — it is the one command that stops working the moment it succeeds.

Anything else you type is a prompt for the agent.

## What you can send

| You send | What the agent gets |
| --- | --- |
| Text | The prompt |
| A photo, or an image sent as a file | What the vision model reads in it, and your caption |
| Several photos at once | All of them in one message, under your caption |
| A text file — a log, a stack trace, source | Its contents in the prompt, truncated if very long |
| A voice note, audio, or video | A note saying it could not be read |

Images go through the harness attachment seam, which accepts PNG, JPEG, WebP
and GIF. Everything else it explicitly defers, so this plugin says so rather
than accepting the message and quietly dropping what it carried.

The seam also refuses an image whose longest side is over `maxImageDimension`,
2000 pixels by default — and every full-height phone screenshot is over it:
1179×2556 on an iPhone, 1080×2400 on most Android. Telegram sends a photo at
several rendered sizes, so the largest one that fits is chosen rather than the
largest one there is, and the seam's published limits are read from the store
itself so there is no second copy of the number to drift. If the seam refuses a
size anyway, the next smaller one is tried; when a photo sent uncompressed
leaves nothing to step down to, the refusal names the limit and says that
sending it as a photo would let Telegram offer a smaller copy.

A file that is too large, or that fails to download, becomes a note in the
prompt explaining why — your caption still reaches the agent either way.

### Sending several at once

Telegram has no "several photos in one message". An album arrives as N separate
updates tied together only by a shared id, with the caption on exactly one of
them — so three screenshots used to become three turns, two of them bare images
the agent had no question for.

A message belonging to an album is now held rather than answered, and the group
goes through as one prompt once it stops growing: your caption, then every
image. The wait is paid only by albums, and only once each, which beats
answering the same question three times.

### A model has to be able to look

A model that declares no image input rejects the whole request, so an image is
checked against `inputModalities` before it is sent. **No DeepSeek model
accepts images** — `deepseek-v4-flash` and `deepseek-v4-pro` are both text-only
— so out of the box a screenshot is declined with a sentence naming what would
work, and your caption still reaches the agent.

**Settings → Telegram → Attachments** offers a dropdown of the models already
configured in Settings → Models. Pick one and images become readable.

`/vision` chooses which model reads images here, or turns the reading off
entirely with `/vision off`. Off is a real answer rather than the absence of
one: a conversation whose own model can see wants no reader at all, and saying
so outranks whatever the deployment configured. Like the rest, it is per
conversation and survives `/new`.

**If the conversation's own model reads images, none of this happens.** The
picture goes straight through, and the model looks at it. Since DeepSeek
shipped `deepseek-v4-flash-vision-exp` that is a real choice rather than a
hypothetical, and it is the better one when the screenshot is not just text: a
transcription loses the diagram, the chart, the misaligned layout — everything
you were actually asking about.

The indirection below exists because a provider inspects the whole request
history, so an image binds a conversation to a model that can see. When that
model IS the one you chose, there is nothing to be stuck on and nothing to work
around — so the reading, the refusal, and the sticky routing all stand down
together.

The picture never enters your conversation. It goes to a throwaway session on
that model, which is asked to transcribe every piece of text in it and describe
what it is; the reply comes back as ordinary text and *that* is what your
conversation receives, under your own caption. The session is disposed either
way — it exists for one turn.

The indirection is the point. A provider checks the entire request history for
images, so an image left in a conversation binds it to a model that can see for
as long as it lives: one screenshot and every later turn — however plain its own
text — has to run there too, away from the model you chose and the tools
configured around it. Reading it elsewhere keeps the history free of images, so
the conversation stays where it was, keeps its tools, and never gets stuck.

With no vision model configured nothing reaches this path at all: the image is
declined before it is even downloaded, with a sentence naming the models that
would have worked, and your caption still reaches the agent.

If a reading is attempted and fails — the model unreachable, the turn timing out
after two minutes — the picture goes through as it is and the conversation moves
onto the vision model instead, durably, until `/new`. That is the fallback
rather than the design, and the prompt says which happened.

The catalog the browser can read carries no modality information, so the
dropdown cannot mark which models accept images. The host checks that when an
image is actually sent, which is the one place the answer is certain. Vision
models reach the harness through a provider that carries them, such as an
OpenAI-compatible route added in Settings → Models, whose model entry declares
`input: [text, image]`.

### When no model can look

With no vision model configured the image used to be refused outright, and the
answer was a sentence about model configuration rather than anything about the
picture. If `tesseract` is installed, its text is read instead.

It is a fallback and says so. OCR reads text; it does not see. A screenshot of
an error, a log or a receipt comes back cleanly — crisp text, high contrast, no
perspective is exactly its best case — while a whiteboard, an architecture
diagram or a chart comes back as scattered words with nothing to say what the
picture was. The reading is therefore labelled as OCR wherever it goes: an
agent handed unlabelled OCR treats a misread digit as a fact, and a receipt's
amount is precisely what it gets wrong.

Tesseract is never assumed. No operating system this runs on ships it, so its
absence is the ordinary case: it is probed once, and where it is missing the
old refusal stands — now naming both ways forward. `/diag` says which of the
two this machine has.

The same fallback covers a vision model that was configured but could not be
reached, for the same reason: reading the text beats returning nothing.

Latin script reads well with `eng` alone — Indonesian, numbers, dates and
amounts all come through — so `media.ocr.languages` only needs changing for a
different script. `tesseract --list-langs` says what is installed.

### When a conversation gets stuck

A turn can fail in a way no retry clears — most often that one: an earlier
message carries content the current model will not take, and nothing typed next
will change it. The bot recognises those, says what failed, and offers a button
that starts a fresh conversation. Asking the user to remember `/new` would be
asking them to diagnose the plugin.

Failures that may pass on their own are reported without a button, because
retrying really is the right thing to do with them.

## Configuring it

Open **Settings → Telegram** in the harness web UI. The page writes straight to
the settings document — there is no Save button, because the host applies a
committed change by reconnecting, and a staged form would let the page and the
running bot disagree about what is configured.

The bot token is the exception. It is a secret, so it never rides the settings
wire in either direction: the page learns only whether one is stored, writes it
through the credentials domain, and refuses to offer an edit for a reference the
environment already supplies (a write there would look like it worked while
resolution kept returning the shadowing value).

Everything on the page is equally settable in a profile patch, for a deployment
that configures by file:

## Configuration

Every field has a working default; an empty config runs.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Whether the connection starts with the harness |
| `tokenRef` | `TELEGRAM_BOT_TOKEN` | Credential reference holding the token |
| `baseUrl` | `https://api.telegram.org` | Bot API origin; change only for a proxy |
| `allowFrom` | `[]` | User ids allowed in; empty enables the claim flow |
| `cwd` | harness cwd | Directory a conversation starts in until `/cd` moves it |
| `agentPreset` | `""` | Preset Telegram conversations are composed from; empty takes the deployment default. The preset supplies the tools |
| `permissionPreset` | `""` | Permission preset Telegram runs under, from the deployment's own table; empty follows the deployment default |
| `requireMentionInGroups` | `true` | In a group, answer only when @mentioned or replied to |
| `screenshot.enabled` | `false` | Allow `/screenshot`. Off by default; macOS also needs Screen Recording permission |
| `streaming.enabled` | `true` | Show the answer as it is written |
| `streaming.throttleMs` | `1200` | Minimum gap between streamed frames |
| `timeoutMs` | `30000` | Per-request Bot API timeout |
| `longPollSeconds` | `25` | How long Telegram holds an empty poll open |
| `media.enabled` | `true` | Read images and text files the user sends |
| `media.maxBytes` | `20 MB` | Refuse anything larger; Telegram caps bot downloads there |
| `media.maxTextChars` | `60000` | Truncate an inlined text file to this many characters |
| `media.ocr.enabled` | `true` | Read an image's text with tesseract when no vision model can. Does nothing unless tesseract is installed |
| `media.ocr.languages` | `eng` | Languages tesseract reads; join several with `+`. Only installed ones work |
| `media.visionModel` | `""` | `provider/model` that reads images in a session of its own; empty sends the image to the conversation itself. Picked from a dropdown on the settings page |
| `reconnect.baseDelayMs` | `1000` | Delay before the first reconnect attempt |
| `reconnect.maxDelayMs` | `30000` | Longest delay between reconnect attempts |

## Diagnostics

`/diag` reports what the plugin can see about itself: the connection, which
harness seams this deployment actually composed, and the last twenty things
that went wrong.

It also says which versions are running and whether anything newer is
published — read-only, and cached for an hour so asking twice costs nothing.
There is deliberately no `/update` to go with it: updating the harness takes
effect only after a restart, and restarting it from inside a plugin running in
it kills the process answering you, with nothing to bring it back on a machine
with no supervisor. Knowing you are behind is the useful half; acting on it
belongs where you can watch it.

The seam list is the useful part. An absent seam explains a whole class of "why
does it not do that" without anyone having to guess — a missing `agentPresets`
is why Telegram agents once reached the model with almost no tools, and nothing
anywhere said so.

`ctx.logger` reaches whatever sink the deployment composed, and several profiles
compose none — so a plugin that only logs its failures is silent about them.
This one also writes its state to `$DSH_HOME/dsh-telegram/status.json` on every
transition:

```json
{ "state": "connected", "bot": "your_bot", "updatedAt": "..." }
```

`connecting`, `connected`, `idle` with a reason, `failed` with a reason. The bot
token never appears in it.

## Living alongside the web UI

The harness allows exactly one user-questions provider, and in a profile that
also runs the web app the browser has already claimed it. This plugin takes the
slot over and keeps the browser's provider as a fallback: a question belonging
to a browser session is forwarded straight back to it, and one belonging to a
Telegram conversation becomes buttons in the chat. Unloading the plugin puts
the previous arrangement back exactly.

Approvals compose natively — the harness runs them as a waterfall — so this
plugin answers for its own sessions and passes every other one along.

## How it fits together

```
Telegram Bot API
      │  long poll: message + callback_query
      ▼
UpdatePoller ──► UpdateRouter ──┬──► SessionRunner ──► ctx.agents
                                │           │
                                │           └──► VisionExtractor ──► a throwaway
                                │                                    session
                                ├──► MediaCollector ──► ctx.attachments
                                ├──► TelegramQuestionProvider ──► ctx.userQuestions
                                └──► TelegramApprovalAnswerer ──► approval/request

ctx.on('session/event') ──┬──► VisionExtractor   (its own reading sessions)
                          └──► TurnBridge ──► RichReplyStream ──► sendRichMessage

TypingIndicator          (held by the router and the bridge until a reply shows)
```

### How a reply is streamed

Telegram offers two mechanisms, and they are not interchangeable:

- **Private chats** use `sendRichMessageDraft` — an ephemeral preview that
  animates between frames sharing a draft id. It expires 30 seconds after its
  last frame, so a heartbeat re-sends the current text during a long tool call;
  otherwise the preview would vanish and the bot would look dead. A draft is
  never persisted, so the turn ends with a real `sendRichMessage`.
- **Groups have no draft API.** There the finished reply is simply sent when it
  is ready.

Both end with one permanent rich message.

### Nothing is posted until there is something to say

Telegram's own typing indicator carries the wait, and the reply appears only
once it has content — the first words, or the name of a tool the agent reached
for. An ellipsis posted the moment a turn opens tells the user what they
already know, and in a group it is a permanent message telling them.

The indicator is held rather than sent. `sendChatAction` lapses after five
seconds, which is shorter than almost everything worth waiting for here —
downloading a file, reading an image on a vision model, a turn queued behind
the last one, a minute inside a tool call — so one call reads as a bot that
started and died. Holds are counted per conversation and re-sent inside their
own expiry, so the router's hold while it reads an attachment and the bridge's
hold over the turn that follows overlap cleanly, and typing stops when the last
of them lets go. A ten-minute backstop covers a release that never arrives.

Nothing is ever redrawn with less than it showed before. When a tool finishes
and there is no text yet, the line naming it stays until real text replaces it
— Telegram refuses an empty draft, so the alternative was trading the last
thing that happened for a frame that said nothing.

While the agent works, the running tool is shown above the reply in a
`<tg-thinking>` block:

```
▸ bash: npm test

Here is what I found so far…
```

Telegram accepts that block in a draft and nowhere else, which matches its
lifetime exactly — it disappears when the turn is persisted, so the finished
reply carries the answer rather than the scaffolding that produced it. It is a
single clipped line: a tool call's arguments can be an entire file, and the
point is knowing the agent is alive, not reading a transcript.

Access is checked before anything else, so no unauthorised text reaches the
agent — not even a command.

## Development

```bash
npm ci
npm test --workspace @sympoies/dsh-telegram
npm run test:coverage --workspace @sympoies/dsh-telegram
npm run typecheck --workspace @sympoies/dsh-telegram
npm run build --workspace @sympoies/dsh-telegram
```

Releases use this monorepo's package-independent workflow and npm trusted
publishing. The workflow validates the selected workspace, version and tag
before GitHub exchanges its OIDC identity for a short-lived npm credential.
This package stores no npm token and has no package-specific release workflow.

Every module runs without a harness, which is what keeps the suite fast: the
plugin entry is exercised against a real HTTP stub of the Bot API, and the
browser bundle is materialized exactly as the shell materializes it.

### The browser half

`build.client.mjs` wraps an esbuild CJS bundle in the shell's lazy-CJS factory
envelope (`window.__ModuleLoader__.load({ id, factory })`). That envelope is
reproduced rather than imported: the harness's `clientBundle` preset is not
published, which its own documentation lists as a known limitation for plugins
shipped outside its repository. It is therefore the single place this plugin is
coupled to an internal format, and `test/client-bundle.test.ts` pins it — the
test runs the build, materializes the factory with a stub `require`, and checks
that `apply` claims its settings seat. A harness release that changes the format
fails there by name instead of showing up as a blank Settings page.

React and the shell's own packages are marked external; bundling a second React
would break every hook the moment the page mounted.

## Known limitations

- **One directory per conversation.** `/cd` moves a conversation, but a
  session cannot be moved: the change starts a fresh one.
- **No voice, audio or video.** The harness attachment seam takes images only.

## License

MIT. The original copyright and license are retained in [LICENSE](LICENSE),
and the imported source is documented in [NOTICE](NOTICE).
