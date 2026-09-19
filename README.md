# dsh-plugins

MIT-licensed public plugins for
[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness).

This repository owns plugin source, tests, package metadata, and compatibility
evidence. It does not own DSH runtime governance or production deployment.

## Repository boundary

- [`sympoies/dsh-runtime-kit`](https://github.com/sympoies/dsh-runtime-kit)
  owns reusable runtime governance, composition, admission, lifecycle,
  isolation, and receipts.
- [`sympoies/dsh-applications`](https://github.com/sympoies/dsh-applications)
  owns the coordinated public application and profile catalog.
- This repository owns independently released DSH plugins.

## Layout

Each plugin belongs in its own TypeScript workspace package:

```text
packages/
  <plugin-name>/
    src/
    test/
    package.json
    tsconfig.json
```

Every package should declare exact compatibility with the DSH prereleases it
supports. A normal DSH plugin should consume DSH's public extension APIs
directly. A governed application plugin may additionally consume the public
contracts exposed by `dsh-applications` and `dsh-runtime-kit`; it must not copy
their policy or lifecycle implementations.

Each package is released independently to npm through OIDC trusted publishing,
with the same tarball retained in an immutable checksum-bearing GitHub Release.
See [`docs/releases.md`](docs/releases.md) for tag, provenance, bootstrap, and
consumer pinning rules.

## Development

```sh
fnm use
npm install --global npm@11.6.2 --ignore-scripts
npm ci --ignore-scripts
npm run check
```

The first package is
[`@sympoies/dsh-llm-codex-subscription`](packages/llm-codex-subscription/README.md),
a portable provider adapter for Codex subscription compatible Responses
endpoints.

## License

[MIT](LICENSE)
