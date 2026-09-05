# Contributing

Open an issue before proposing a new plugin or a change to a plugin's public
contract.

## Development

Use the repository-pinned Node.js release and exact npm version:

```sh
fnm use
npm install --global npm@11.6.2 --ignore-scripts
npm ci --ignore-scripts
npm run check
```

Every behavior change should include focused test-first evidence. Each plugin
must declare its exact DSH compatibility and keep deployment-specific values
out of source control.
