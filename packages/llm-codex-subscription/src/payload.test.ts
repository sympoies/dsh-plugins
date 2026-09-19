import { describe, expect, it } from "vitest";

import { normalizeCodexSubscriptionPayload } from "./payload.js";

describe("normalizeCodexSubscriptionPayload", () => {
  it("enforces the reviewed Responses request invariants", () => {
    const normalized = normalizeCodexSubscriptionPayload({
      model: "gpt-5.6-sol",
      input: [{ role: "user", content: "hello" }],
      max_output_tokens: 128_000,
      parallel_tool_calls: true,
      reasoning: { effort: "high", summary: "auto" },
      store: false,
      stream: true,
    });

    expect(normalized).toEqual({
      model: "gpt-5.6-sol",
      input: [{ role: "user", content: "hello" }],
      parallel_tool_calls: false,
      reasoning: { effort: "high", summary: "auto", context: "all_turns" },
      store: false,
      stream: true,
    });
  });

  it("adds reasoning context when the SDK omitted reasoning", () => {
    expect(normalizeCodexSubscriptionPayload({ store: false })).toEqual({
      parallel_tool_calls: false,
      reasoning: { context: "all_turns" },
      store: false,
    });
  });

  it("refuses an incompatible storage request", () => {
    expect(() => normalizeCodexSubscriptionPayload({ store: true })).toThrow(
      "store must be false",
    );
  });

  it("refuses an incompatible reasoning context", () => {
    expect(() => normalizeCodexSubscriptionPayload({
      store: false,
      reasoning: { context: "previous_turn" },
    })).toThrow("reasoning.context must be all_turns");
  });

  it("refuses non-object provider payloads", () => {
    expect(() => normalizeCodexSubscriptionPayload([])).toThrow(
      "payload must be a JSON object",
    );
  });
});
