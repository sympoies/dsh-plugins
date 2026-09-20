# `@sympoies/dsh-llm-codex-subscription`

DSH LLM adapter for an OpenAI Responses compatible endpoint backed by a Codex
subscription.

Version 0.1.4 supports the exact DSH dependency sets for `0.1.1-rc.2`,
`0.1.2-rc.1`, and `0.1.6-alpha.2`. Each set is installed independently and
booted by the release gate before publication.

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
