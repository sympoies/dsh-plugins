const JSON_OBJECT = "payload must be a JSON object";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Apply the Codex subscription Responses request contract after pi-ai has
 * assembled the provider payload.
 */
export function normalizeCodexSubscriptionPayload(
  payload: unknown,
): Record<string, unknown> {
  if (!isRecord(payload)) throw new Error(`codex-subscription: ${JSON_OBJECT}`);
  if (payload.store !== false) {
    throw new Error("codex-subscription: store must be false");
  }

  const reasoning = payload.reasoning;
  if (reasoning !== undefined && !isRecord(reasoning)) {
    throw new Error("codex-subscription: reasoning must be a JSON object");
  }
  if (
    reasoning?.context !== undefined
    && reasoning.context !== "all_turns"
  ) {
    throw new Error("codex-subscription: reasoning.context must be all_turns");
  }

  const normalized = { ...payload };
  delete normalized.max_output_tokens;
  delete normalized.max_tokens;
  normalized.parallel_tool_calls = false;
  normalized.reasoning = { ...reasoning, context: "all_turns" };
  return normalized;
}
