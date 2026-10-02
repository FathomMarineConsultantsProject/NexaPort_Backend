// Shared backend-only transport. Callers own prompts, schemas and retry policy.
export function postOpenRouter(body, { env = process.env, fetchImpl = globalThis.fetch, signal } = {}) {
  return fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST", signal,
    headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
