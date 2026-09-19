import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { createUserMessage, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { afterEach, describe, expect, it } from "vitest";

import {
  createCodexSubscriptionAdapter,
  PROVIDER_ROUTE,
} from "./index.js";

function responseEvents(text: string): Record<string, unknown>[] {
  const message = {
    id: "msg_fixture",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{
      type: "output_text",
      annotations: [],
      logprobs: [],
      text,
    }],
  };
  const response = {
    id: "resp_fixture",
    object: "response",
    created_at: 1,
    status: "completed",
    background: false,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    max_tool_calls: null,
    model: "gpt-5.6-sol",
    output: [message],
    parallel_tool_calls: false,
    previous_response_id: null,
    prompt_cache_key: null,
    prompt_cache_retention: null,
    reasoning: { effort: "high", summary: "auto" },
    safety_identifier: null,
    service_tier: "default",
    store: false,
    temperature: null,
    text: { format: { type: "text" }, verbosity: "medium" },
    tool_choice: "auto",
    tools: [],
    top_logprobs: 0,
    top_p: null,
    truncation: "disabled",
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 11,
    },
    user: null,
    metadata: {},
  };
  const part = message.content[0];
  return [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: message.id, output_index: 0, content_index: 0, part: { ...part, text: "" } },
    { type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: text, logprobs: [] },
    { type: "response.output_text.done", item_id: message.id, output_index: 0, content_index: 0, text, logprobs: [] },
    { type: "response.content_part.done", item_id: message.id, output_index: 0, content_index: 0, part },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.completed", response },
  ];
}

describe("Codex subscription adapter", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  it("sends the normalized request and returns canonical DSH chunks", async () => {
    let requestBody: Record<string, unknown> | undefined;
    let authorization: string | undefined;
    const server = createServer((request, response) => {
      authorization = request.headers.authorization;
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { raw += chunk; });
      request.on("end", () => {
        requestBody = JSON.parse(raw) as Record<string, unknown>;
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of responseEvents("hello")) {
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        response.write("data: [DONE]\n\n");
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
      server.closeAllConnections();
    }));
    const address = server.address() as AddressInfo;
    const adapter = createCodexSubscriptionAdapter({
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      models: [{ id: "gpt-5.6-sol" }],
    }, { resolveApiKey: async () => "fixture-token" });

    const chunks = [];
    for await (const chunk of adapter.stream({
      provider: PROVIDER_ROUTE,
      model: "gpt-5.6-sol",
      reasoningEffort: ReasoningEffortId("high"),
      maxTokens: 128_000,
      messages: [createUserMessage({
        content: [{ type: "text", text: "hello" }],
        source: { kind: "user" },
      })],
    })) {
      chunks.push(chunk);
    }

    expect(chunks.at(-1)).toMatchObject({ type: "finish", reason: { kind: "stop" } });
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      "block-start",
      "text-delta",
      "block-end",
      "usage",
      "finish",
    ]);
    expect(requestBody).toMatchObject({
      model: "gpt-5.6-sol",
      store: false,
      stream: true,
      parallel_tool_calls: false,
      reasoning: { effort: "high", summary: "auto", context: "all_turns" },
    });
    expect(requestBody).not.toHaveProperty("max_output_tokens");
    expect(authorization).toBe("Bearer fixture-token");
  });
});
