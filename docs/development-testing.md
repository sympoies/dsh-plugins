# Layered plugin development and testing

This is the mandatory validation policy for material changes to
`dsh-plugins`. Use the repository-local `project-plugin-development` skill to
apply it.

Each layer proves a different boundary. Unit tests do not prove compiled
output, a successful build does not prove the npm inventory, and a packed
tarball does not prove that every declared DSH compatibility profile boots.
Start at the earliest layer that can prove the observable delta and advance
only while the owning issue requires more evidence.

## Validation map

Before implementation, record:

- the observable contract delta and retained invariants;
- the affected workspace or repository-level owner;
- the earliest proving layer and focused command;
- the expected secret-safe result and permitted side effects;
- the exact source commit, package name and version, DSH or Cordis peer pins,
  compatibility profile, packed artifact, and consumer identity needed by
  later layers;
- the receipts invalidated by the change and the outer layers actually
  required by the delta or owning issue.

Capture a meaningful failing owner test at the earliest testable layer. If a
safe failure is not practical, record the substitute validation before editing.
Use focused tests while iterating, freeze the candidate before a broad gate,
and run each declared full validation once.

Invalidated and required are different: invalidation forbids reusing stale
evidence, but does not authorize or require release, deployment, or an external
provider run when those outcomes are outside the task.

## Validation ladder

### 1. Contract and owner tests

Prove parsers, configuration, state transitions, rendering, request
projection, response handling, errors, and negative paths with deterministic
tests in the owning workspace. A behavior change normally starts with a
focused failing test. Documentation-only and policy-only changes may instead
use link, routing, schema, or command validation when no runtime failure can
meaningfully exist.

Tests must not depend on credentials, private profiles, deployment bindings,
machine-local paths, or an undeclared host binary. A broad suite is not a
substitute for the missing owner assertion.

### 2. Public-seam and adapter tests

Exercise the exact DSH or Cordis public extension seam used by the plugin.
Prove registration, lifecycle, cancellation, permission behavior, cleanup, and
typed failures with local stubs or fixtures where possible.

The caller-facing seam is part of the contract. A locally similar object or a
model claim that something worked cannot substitute for invoking the public
surface the plugin actually ships against. If the missing behavior belongs to
DSH, route it there instead of embedding a second agent loop, session manager,
approval system, or sandbox in this repository.

### 3. Build, package, and inventory tests

Build the exact candidate, inspect the emitted runtime, and audit the tarball
inventory. Source presence does not prove compiled output, and `npm pack`
must not be allowed to repair or build an otherwise stale candidate during
inspection.

The package's `files` list is closed inventory. Runtime files such as
`NOTICE` or `cordis.patch.yml` must be declared deliberately; source, tests,
release helpers, credentials, and local state must remain out of the tarball.
Record the package name, version, tarball SHA-256 or npm integrity when an
outer consumer needs it, and the exact release manifest that selected the
workspace.

### 4. Fresh compatibility-profile boot

For a compatibility or packaged-runtime change, install the packed tarball in
a fresh temporary profile for every profile declared by
`release/manifest.json`. Pin every compatibility peer exactly and run the
package-owned `release/smoke.mjs` against the installed tree.

An existing development checkout, hoisted workspace dependency, or single
preferred DSH prerelease cannot prove the full declared compatibility set.
Change a peer declaration only with current fresh-profile evidence for every
alternative it claims to support.

### 5. Consumer acceptance

Run consumer or real-service acceptance only when the observable delta crosses
that boundary. Bind the exact plugin artifact, DSH revision, consumer contract,
configuration projection, and allowed side effects. Verify independent
observable state; terminal prose and model output are supporting evidence, not
the sole proof.

Public reusable application contracts belong to `dsh-applications`. Runtime
governance and admission belong to `dsh-runtime-kit`. Deployment bindings,
credentials, host identity, rollout, and rollback belong to
`serenvia/sympoies-infra`.

### 6. Release and hosted rollout

A release starts from reviewed source on the default branch and the exact
workspace version selected by a signed `<tagPrefix>-v<version>` tag. The
workflow builds and packs once, verifies fresh boot, publishes those exact
bytes to npm through OIDC, and retains the checksum-bearing archive and lock in
an immutable GitHub Release.

Release, consumer repinning, hosted acceptance, and deployment are separate
authority boundaries. Local rehearsal does not authorize a tag or publish,
and a successful publish does not authorize a production rollout. Follow
`docs/releases.md` when release is explicitly in scope.

## Identity and invalidation

| Change | Invalidated evidence |
| --- | --- |
| Plugin behavior, parser, adapter, or configuration semantics | Focused owner tests and every outer layer consuming the changed behavior. |
| TypeScript source, build script, dependency, or packaged file | Build, tarball inventory, fresh-profile boot, and later artifact consumers. |
| `peerDependencies`, release manifest, or smoke module | Package audit and every declared compatibility-profile boot. |
| Package name, version, tag prefix, or `files` inventory | Release plan, packed identity, registry/release read-back, and consumer pins. |
| Root policy or unshipped documentation only | Document routing, links, and routine repository validation; package and runtime receipts remain current. |
| Deployment-only binding or credential projection | Private deployment-owner evidence; do not encode it in this repository. |

Reviews bind to an exact head. After a repair, review the changed delta, direct
callers, earlier findings, and affected invariants. Repeat a full review only
when the new delta is cross-cutting or changes a core assumption or trust
boundary.

## Failure and replan rule

One failure is evidence, not permission for blind repetition. Repair the owner
identified by the earliest useful result. Stop and replan before another broad
run when:

- a generic failure cannot distinguish materially different stages;
- the same layer fails again without new evidence;
- a broader smoke is being changed to conceal an unproved lower layer;
- exact package, compatibility, target, authority, or cleanup state is unknown;
- progress depends on sleeps, blind retries, or human diagnosis hints;
- another full suite already owns the same mutable resources;
- the missing primitive belongs to another repository.

## Owner routing

| Observed gap | Canonical owner |
| --- | --- |
| Independently released plugin behavior, package metadata, release manifest, smoke module, or this policy | `sympoies/dsh-plugins` |
| Agent loop, sessions, native tools, permissions, approvals, provider bridge, or cancellation | DSH |
| Runtime governance, admission, lifecycle, isolation, operations, or reusable receipts | `sympoies/dsh-runtime-kit` |
| Public application/profile semantics or reusable application acceptance | `sympoies/dsh-applications` |
| Hosted trust, credentials, deployment bindings, rollout, or rollback | `serenvia/sympoies-infra` |
| Reusable agent workflow, evidence, worktree, commit, or forge primitive | `sympoies/nils-cli` or the owning agent-runtime project |

Cross-repository work needs its own authority and validation. A local plugin
change may identify or prepare a handoff, but this policy does not grant the
write.

## Receipt requirements

Record only what reviewers need:

- layer, owner, focused assertion, and command or bounded step;
- exact relevant source, package, compatibility profile, artifact, and
  consumer identities;
- pass or fail with the earliest stable stage;
- attempted side effects, cleanup, and residual gap;
- invalidated evidence and the next permitted layer or owner.

Do not retain prompts, model responses, credentials, auth state, private
identifiers, machine-local paths, or deployment topology in this public
repository, issues, commits, or logs.

## Self-improvement loop

When work exposes repeatable friction:

1. Preserve the first bounded failure and observable result.
2. Identify the earliest layer and canonical owner that should have caught it.
3. Add a focused failing regression or record why a safe RED is impractical.
4. Repair that owner within the active authority; otherwise prepare the
   smallest handoff and stop at the boundary.
5. Resume from the first invalidated required layer.
6. Update this policy or the project skill only when the lesson generalizes to
   future plugin work.

The loop improves tests and diagnostics. It never grants issue, release,
provider, credential, deployment, or cross-repository authority.

## Repository finish line

Use focused workspace commands during implementation, for example:

```sh
npm test --workspace <package-name>
npm run test:coverage --workspace <package-name>
npm run build --workspace <package-name>
```

Once the candidate is stable, run the complete routine gate once:

```sh
npm run check
```

That gate typechecks the repository and workspaces, runs tests and coverage,
builds every package, and audits each package inventory. Add fresh-profile
boot, release, consumer acceptance, or hosted rollout only when the change
invalidates that evidence and the owning issue requires the boundary.
