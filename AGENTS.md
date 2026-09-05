# AGENTS.md

## Scope

This repository contains MIT-licensed public plugins for DeepSeek Harness
(DSH).

## Product boundary

- Implement plugins through DSH's public extension interfaces.
- Keep generic runtime governance, admission, lifecycle, isolation, and receipt
  primitives in `sympoies/dsh-runtime-kit`.
- Reuse `sympoies/dsh-applications` contracts when a governed application
  plugin needs its SDK, profiles, triggers, or output formats.
- Keep deployment bindings, credentials, host identity, and rollout state out
  of this repository.
- Do not copy DSH's agent loop, sessions, tools, approvals, sandbox, or event
  reconciliation into this repository.

## Development

- Keep repository content in English.
- Use strict TypeScript and test-first evidence for behavior changes.
- Give each plugin an independent package under `packages/<name>`.
- Pin supported DSH prereleases explicitly and test installation and boot before
  changing a compatibility declaration.
- Never commit credentials, local profiles, session data, generated bundles, or
  deployment-specific bindings.
