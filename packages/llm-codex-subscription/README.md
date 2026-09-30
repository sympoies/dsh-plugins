# `@sympoies/dsh-llm-codex-subscription`

DSH LLM adapter for an OpenAI Responses compatible endpoint backed by a Codex
subscription.

Version 0.2.0 supports the exact DSH `0.2.0-rc.2` dependency set with Cordis
`4.0.4`. The release gate installs that set into a fresh profile and boots it
before publication. The package builds on the pi-ai and schemastery versions
that DSH release resolves, because the adapter hands its pi-ai provider to
DSH's own pi-ai adapter. Version 0.1.5 remains the release for DSH
`0.1.1-rc.2`, `0.1.2-rc.1`, and `0.1.6-alpha.2`.

The plugin registers the fixed provider route `codex-subscription`. Deployment
configuration supplies the endpoint and the name of the environment credential;
the package contains no host address or credential value.

```yaml
- id: llm-codex-subscription
  name: '@sympoies/dsh-llm-codex-subscription'
  config:
    baseURL: http://127.0.0.1:18765/v1
    apiKeyEnv: DSH_CODEX_SUBSCRIPTION_TOKEN
```

The adapter uses DSH's public LLM seam and the DSH pi-ai bridge for canonical
message and stream conversion. Its provider policy removes output token caps,
keeps `store: false`, disables parallel tool calls, and requests all-turn
reasoning context.
