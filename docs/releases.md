# npm release contract

Every workspace under `packages/` owns an independent SemVer version and an
excluded-from-package `release/manifest.json`. A signed tag named
`<tagPrefix>-v<version>` selects one workspace. The release workflow rejects
ambiguous prefixes, version mismatch, private packages, incomplete metadata,
missing runtime files, and unexpected tarball inventory.

The manifest uses `dsh-plugin-release.v2` and declares the package-specific
parts of verification:

```json
{
  "schemaVersion": "dsh-plugin-release.v2",
  "tagPrefix": "dsh-example",
  "compatibilityPeers": ["@deepseek-ai/dsh"],
  "smokeModule": "release/smoke.mjs"
}
```

Every named compatibility peer must exist in `peerDependencies` with an exact
version. The smoke module is copied into the fresh installation profile and
executed there, so it can compose the package through the DSH surfaces that the
package actually implements. Keep both release files outside the package's
`files` inventory.

Tarball inventory follows the safe literal paths declared by `package.json`
`files`. This permits package-owned runtime files such as `NOTICE` or
`cordis.patch.yml` while continuing to reject undeclared source and test files.

The GitHub-hosted workflow typechecks the repository, runs the selected
workspace's coverage suite, builds it, and packs it exactly once. It installs
that tarball into a fresh temporary profile with its declared peer dependencies
and runs the package-owned smoke module. The second job
receives only the fixed tarball, checksum, and lock, publishes those exact bytes
to npm through OIDC trusted publishing with provenance, and then creates an
immutable checksum-bearing GitHub Release.

## One-time npm setup

The package must already exist on npm before its trusted publisher can be
configured. Prepare a code-free prerelease that contains only package metadata,
README, and the repository license:

```sh
npm run bootstrap:prepare -- \
  --package @sympoies/<package> \
  --out-dir <empty-output-directory>
```

After signing in interactively, a package owner publishes that tarball with the
non-default `bootstrap` dist-tag. It does not publish plugin code or occupy the
`latest` tag. The owner then configures this trusted publisher in the package
settings:

```sh
npm publish <bootstrap-tarball> --access public --tag bootstrap \
  --registry=https://registry.npmjs.org/
```

- organization: `sympoies`
- repository: `dsh-plugins`
- workflow filename: `release.yml`
- allowed action: `npm publish`

No npm token belongs in this repository or its Actions secrets. After the
trusted publisher is configured, all later versions use the signed-tag
workflow. Repeat the package bootstrap and publisher binding once for each new
workspace package.

## Maintainer entrypoint

Run the read-only gate first, then repeat the exact invocation with
`--execute`:

```sh
agent-run exec --cwd "$PWD" -- ./.agents/scripts/release.sh \
  --dry-run --tag <tagPrefix>-v<version> --expected-head <main-sha> \
  --repository sympoies/dsh-plugins
```

`--verify-only` resumes registry and GitHub Release read-back without creating
or replacing state.
