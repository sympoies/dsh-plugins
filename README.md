# dsh-plugins

MIT-licensed public plugins for
[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness).

This repository owns plugin source, tests, package metadata, and compatibility
evidence. It does not own DSH runtime governance or production deployment.

## Repository boundary

- `sympoies/dsh-runtime-kit` owns reusable runtime governance, composition,
  admission, lifecycle, isolation, and receipts.
- `sympoies/dsh-applications` owns the coordinated public application and
  profile catalog.
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

## Development

```sh
fnm use
npm install --global npm@11.6.2 --ignore-scripts
npm ci --ignore-scripts
npm run check
```

The root workspace intentionally contains no placeholder plugin. Add the first
real package under `packages/` when its behavior and DSH extension surface are
known.

## License

[MIT](LICENSE)
