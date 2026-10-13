// Shared OpenRouter chat call for Suds Review.
// review.mjs (CI and ship.sh pre-review), learn.mjs (weekly learning), and
// eval.mjs (the fair replay of the same cases with and without lessons) all
// use this. The key is an argument. It is sent only as the Authorization
// header and is never written to a log.

import * as core from "./core.mjs";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function consumeOpenRouterLine(state, line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return;
  const data = trimmed.slice(5).trim();
  if (!data || data === "[DONE]") return;
  let chunk;
  try { chunk = JSON.parse(data); }
  catch { throw new Error("OpenRouter returned a stream that is not JSON"); }
  if (chunk?.error) throw new Error(core.apiFailureReason({ message: JSON.stringify(chunk) }));
  core.applyOpenRouterChunk(state, chunk);
}

async function readOpenRouterStream(response) {
  const state = core.emptyOpenRouterStream();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) consumeOpenRouterLine(state, line);
  }
  if (buffer.trim()) consumeOpenRouterLine(state, buffer);
  return core.openRouterStreamResult(state);
}

// The Authorization header is the only place the key goes. Retries cover
// rate limits and 5xx, twice, the same budget the old SDK used.
// fetchImpl is for tests. Callers pass the key; this function does not read env.
export async function openRouterChat(body, { key, fetchImpl = fetch } = {}) {
  const apiKey = typeof key === "string" ? key.trim() : "";
  if (!apiKey) throw new Error(core.MISSING_OPENROUTER_KEY);
  let failure = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(core.OPENROUTER_CHAT_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
        signal: AbortSignal.timeout(15 * 60 * 1000),
      });
    } catch (error) {
      failure = core.apiFailureReason({ message: error?.message });
      if (attempt < 3) { await sleep(core.openRouterRetryDelayMs({ attempt })); continue; }
      throw new Error(failure);
    }
    if (!response.ok) {
      const text = await response.text();
      failure = core.apiFailureReason({ status: response.status, message: text });
      if (core.openRouterShouldRetry({ status: response.status, attempt })) {
        await sleep(core.openRouterRetryDelayMs({ attempt, retryAfter: response.headers.get("retry-after") }));
        continue;
      }
      throw new Error(failure);
    }
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("text/event-stream")) {
      const json = await response.json();
      if (json?.error) throw new Error(core.apiFailureReason({ status: response.status, message: JSON.stringify(json) }));
      return core.openRouterCompletion(json);
    }
    return readOpenRouterStream(response);
  }
  throw new Error(failure ?? core.apiFailureReason({ message: "no response" }));
}
