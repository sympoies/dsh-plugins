# Plugin packages

Create one directory per independently versioned DSH plugin. A package owns its
source, tests, manifest, compatibility declaration, and build output contract.

Do not add placeholder packages. Start a package only when its plugin surface
and observable behavior are defined.

- [`dsh-telegram`](dsh-telegram/README.md) provides a two-way Telegram channel
  with rich messages, questions, and approvals.
- [`llm-codex-subscription`](llm-codex-subscription/README.md) registers the
  portable `codex-subscription` LLM provider route.
