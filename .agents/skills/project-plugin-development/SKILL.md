---
name: project-plugin-development
description: >
  Develop, diagnose, test, package, and deliver dsh-plugins changes through
  the earliest independently observable validation layer, then strengthen the
  owning regression or diagnostic when acceptance exposes a reusable gap.
allowed-tools: Bash, Read, Edit, Write
---

# Project Plugin Development

Use the repository's canonical
[layered development and testing policy](../../../docs/development-testing.md)
for material plugin behavior, DSH compatibility, packaging, release-contract,
and development-policy work. This skill applies that policy; it does not
duplicate or override it.

## Contract

Before editing, produce a small validation map containing:

- the observable delta and retained invariants;
- the affected plugin or repository-level owner;
- the earliest proving layer and focused command;
- the expected secret-safe receipt and permitted side effects;
- the exact source, package, DSH, compatibility-profile, and artifact
  identities required by later layers;
- invalidated receipts and the outer layers actually required by the delta or
  owning issue.

Capture the earliest meaningful failing owner test when practical. Iterate at
that layer, freeze the candidate before the routine gate or external harness,
and run each declared full validation once. The output is a reviewable change,
layer-specific evidence, explicit residual gaps, and a statement of which
outer layers ran or remained out of scope.

Stop before a mutation when target, package identity, authority, clean-room
state, or prior-layer evidence cannot be proved.

## Workflow

1. Read `docs/development-testing.md`; do not work from this summary alone.
2. Inspect the affected workspace, public DSH seam, callers, tests, release
   manifest, package inventory, and supported compatibility profiles. Write the
   validation map before changing production files.
3. Add or select the focused owner regression and capture RED evidence, or
   record the substitute validation. Repair only the owning contract.
4. Advance through only the required validation layers, starting at the
   earliest one. Do not compensate for a lower-layer gap with retries or an
   assertion in a broader smoke test.
5. For a compatibility declaration, build and pack the exact candidate, install
   it into a fresh profile for every declared profile, and exercise the
   package-owned `release/smoke.mjs` entrypoint.
6. Keep repository source, packed bytes, npm integrity, GitHub Release assets,
   and consumer pins as distinct identities. A passing source test does not
   prove the installed tarball, and model output does not prove observable
   runtime state.
7. Route missing contracts to their canonical owner instead of copying DSH,
   runtime-kit, application, or deployment logic into a plugin.
8. Run `npm run check` once on the stable candidate. Perform tag, publish,
   consumer repin, deployment, or hosted acceptance only when separately
   authorized and required by the owning issue.

## Self-improvement loop

When work exposes repeatable friction, retain the first bounded failure,
identify the earliest layer that should have caught it, add a focused owner
regression, and repair the owner before resuming an outer layer. Update the
canonical policy or this skill only when the lesson applies to future plugin
work; keep one incident's chronology and exact identities in its issue.

Before delivery, ask:

- Did the failure gain an earlier deterministic owner assertion?
- Does its receipt identify a stable stage without exposing secrets?
- Does the policy tell a future agent when to stop, resume, or invalidate
  evidence?
- Is the lesson general enough for policy or skill text?

## Boundary

This skill coordinates development decisions inside `sympoies/dsh-plugins`.
It does not grant deployment, provider, credential, issue-write, release,
merge, cross-repository, or hosted-run authority. It must not copy runtime
governance from `dsh-runtime-kit`, application contracts from
`dsh-applications`, native agent behavior from DSH, or deployment state from
`sympoies-infra`.
