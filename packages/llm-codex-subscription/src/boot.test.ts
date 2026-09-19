import { Context } from "@deepseek-ai/cordis";
import LlmRuntime from "@deepseek-ai/dsh-llm";
import { describe, expect, it } from "vitest";

import * as CodexSubscription from "./index.js";

describe("plugin boot", () => {
  it("registers one provider through the public DSH LLM service", async () => {
    const ctx = new Context();
    try {
      await ctx.plugin(LlmRuntime);
      await ctx.plugin(CodexSubscription, {
        baseURL: "http://127.0.0.1:18765/v1",
        models: [{ id: "gpt-5.6-sol" }],
      });

      expect(ctx.llm.listProviders()).toEqual([
        { id: "codex-subscription", name: "OpenAI Codex Subscription" },
      ]);
      expect(await ctx.llm.listModels("codex-subscription")).toEqual([
        {
          provider: "codex-subscription",
          id: "gpt-5.6-sol",
          name: "gpt-5.6-sol",
          inputModalities: ["text"],
        },
      ]);
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
