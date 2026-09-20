import type { Context } from "@deepseek-ai/cordis";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import {
  assertUsableApiKey,
  LlmError,
  resolveRetryPolicy,
  ReasoningEffortId,
  RetryPolicySchema,
} from "@deepseek-ai/dsh-llm";
import type { RetryPolicyConfig } from "@deepseek-ai/dsh-llm";
import {
  PiAiAdapter,
} from "@deepseek-ai/dsh-llm-pi-ai";
import type {
  ResolvedPiAiProviderProfile,
} from "@deepseek-ai/dsh-llm-pi-ai";
import z from "@deepseek-ai/schemastery";
import {
  createProvider,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import type {
  Api,
  Model,
  ProviderStreams,
  SimpleStreamOptions,
  StreamOptions,
} from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";

import { normalizeCodexSubscriptionPayload } from "./payload.js";

export { normalizeCodexSubscriptionPayload } from "./payload.js";

export const name = "llm-codex-subscription";
export const inject = ["llm"];
export const PROVIDER_ROUTE = "codex-subscription";
export const DEFAULT_API_KEY_ENV = "DSH_CODEX_SUBSCRIPTION_TOKEN";

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_CONTEXT_WINDOW = 272_000;
const DEFAULT_MAX_TOKENS = 128_000;
const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 16_000_000;
const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MODELS: readonly CodexSubscriptionModelConfig[] = [
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
];

export interface CodexSubscriptionModelConfig {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
}

export interface Config {
  baseURL: string;
  apiKeyEnv?: string;
  reasoning?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  models?: CodexSubscriptionModelConfig[];
  streamIdleTimeoutMs?: number;
  retryPolicy?: RetryPolicyConfig;
}

const modelSchema: z<CodexSubscriptionModelConfig> = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
});

export const Config: z<Config> = z.object({
  baseURL: z.string().required(),
  apiKeyEnv: z.string().role("credential-ref").default(DEFAULT_API_KEY_ENV),
  reasoning: z.union(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).default("high"),
  models: z.array(modelSchema).default([...DEFAULT_MODELS]),
  streamIdleTimeoutMs: z.number().min(1).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
});

function withSubscriptionPayload<T extends StreamOptions | SimpleStreamOptions>(
  options: T | undefined,
): T {
  const previous = options?.onPayload;
  return {
    ...options,
    onPayload: async (payload: unknown, model: Model<Api>) => {
      const candidate = previous === undefined
        ? payload
        : (await previous(payload, model)) ?? payload;
      return normalizeCodexSubscriptionPayload(candidate);
    },
  } as T;
}

/** Responses transport with subscription-specific payload policy. */
export function codexSubscriptionStreams(): ProviderStreams {
  const responses = openAIResponsesApi();
  return {
    stream: (model, context, options) => responses.stream(
      model,
      context,
      withSubscriptionPayload(options),
    ),
    streamSimple: (model, context, options) => responses.streamSimple(
      model,
      context,
      withSubscriptionPayload(options),
    ),
  };
}

function resolveModels(config: Config): Model<"openai-responses">[] {
  const seen = new Set<string>();
  return (config.models ?? DEFAULT_MODELS).map((entry) => {
    if (entry.id.length === 0) throw new Error("codex-subscription: model id must be non-empty");
    if (seen.has(entry.id)) throw new Error(`codex-subscription: duplicate model id "${entry.id}"`);
    seen.add(entry.id);
    return {
      id: entry.id,
      name: entry.name ?? entry.id,
      api: "openai-responses",
      provider: PROVIDER_ROUTE,
      baseUrl: config.baseURL,
      reasoning: true,
      thinkingLevelMap: {
        off: "none",
        minimal: "minimal",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      },
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: entry.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: entry.maxTokens ?? DEFAULT_MAX_TOKENS,
    };
  });
}

function resolvedProfile(config: Config): ResolvedPiAiProviderProfile {
  const models = resolveModels(config);
  const apiKeyEnv = config.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
  return {
    provider: PROVIDER_ROUTE,
    displayName: "OpenAI Codex Subscription",
    apiKeyEnv: apiKeyEnv as NonNullable<ResolvedPiAiProviderProfile["apiKeyEnv"]>,
    api: "openai-responses",
    baseURL: config.baseURL,
    reasoning: config.reasoning ?? "high",
    streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    maxRequestImageBytes: DEFAULT_MAX_REQUEST_IMAGE_BYTES,
    requestImagePixelBudget: DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
    requestImageMaxBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, "llm-codex-subscription.retryPolicy"),
    modelErrors: new Map(),
    configuredMaxTokens: new Map(),
    piProvider: createProvider({
      id: PROVIDER_ROUTE,
      name: "OpenAI Codex Subscription",
      baseUrl: config.baseURL,
      auth: {
        apiKey: {
          name: "Codex subscription proxy token",
          resolve: async ({ ctx: authContext, credential }) => {
            const apiKey = credential?.key ?? await authContext.env(apiKeyEnv);
            return apiKey === undefined
              ? undefined
              : { auth: { apiKey }, source: apiKeyEnv };
          },
        },
      },
      models,
      api: codexSubscriptionStreams(),
    }),
  };
}

export interface AdapterFactoryOptions {
  resolveApiKey: () => Promise<string>;
}

/** Build the adapter independently for integration tests and embedded hosts. */
export function createCodexSubscriptionAdapter(
  config: Config,
  options: AdapterFactoryOptions,
): PiAiAdapter {
  if (config.baseURL.length === 0) throw new Error("codex-subscription: baseURL must be non-empty");
  const profile = resolvedProfile(config);
  const profiles = new Map([[PROVIDER_ROUTE, profile]]);
  return new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: async () => options.resolveApiKey(),
    auth: {
      credentials: new InMemoryCredentialStore(),
      authContext: {
        env: async (name) => name === (config.apiKeyEnv ?? DEFAULT_API_KEY_ENV)
          ? options.resolveApiKey()
          : undefined,
        fileExists: async () => false,
      },
    },
  });
}

/** Register the fixed codex-subscription route with DSH's public LLM seam. */
export function apply(ctx: Context, config: Config): void {
  const apiKeyEnv = config.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
  const adapter = createCodexSubscriptionAdapter(config, {
    resolveApiKey: async () => {
      const value = launchEnvironmentOf(ctx).get(apiKeyEnv)?.value;
      if (value === undefined || value.length === 0) {
        throw new LlmError(
          `llm-codex-subscription: no credential resolved from ${apiKeyEnv}`,
          "MISSING_CREDENTIAL",
        );
      }
      return assertUsableApiKey(value, "llm-codex-subscription", apiKeyEnv);
    },
  });
  ctx.llm.registerAdapter([PROVIDER_ROUTE], adapter);
}

export const reasoningEfforts = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
].map(ReasoningEffortId);
