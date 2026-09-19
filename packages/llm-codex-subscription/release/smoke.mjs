import { Context } from "@deepseek-ai/cordis";
import LlmRuntime from "@deepseek-ai/dsh-llm";
import * as Plugin from "@sympoies/dsh-llm-codex-subscription";

const ctx = new Context();
try {
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(Plugin, {
    baseURL: "http://127.0.0.1:1/v1",
    models: [{ id: "release-smoke" }],
  });
  const providers = ctx.llm.listProviders();
  if (!providers.some((provider) => provider.id === "codex-subscription")) {
    throw new Error("codex-subscription provider route was not registered");
  }
} finally {
  await ctx.fiber.dispose();
}
