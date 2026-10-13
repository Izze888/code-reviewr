import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { anthropicModel, headMovedOn, MODEL, openRouterChatBody, REPO_TOOLS, TOOL_LIMITS } from "./core.mjs";

const workflowPath = join(dirname(fileURLToPath(import.meta.url)), "..", "workflows", "suds-review.yml");

function cacheMarkers(value) {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.cache_control) found.push(node.cache_control);
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(walk);
      else if (child && typeof child === "object") walk(child);
    }
  };
  walk(value);
  return found;
}

const reviewMessages = [
  { role: "user", content: "diff of src/pay.ts" },
  { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function" }] },
  { role: "tool", tool_call_id: "call_1", content: "file bytes" },
];

test("Anthropic reviews cache the system prompt, the tools, and the repo context", () => {
  const messages = structuredClone(reviewMessages);
  const body = openRouterChatBody({
    system: "stable instructions",
    messages,
    effort: "high",
    withTools: true,
    mustAnswer: false,
    cachePrompt: true,
    sessionId: "suds-review/12",
  });
  assert.equal(body.model, MODEL);
  assert.deepEqual(body.messages[0].content, [
    { type: "text", text: "stable instructions", cache_control: { type: "ephemeral" } },
  ]);
  assert.equal(body.tools.length, REPO_TOOLS.length);
  assert.equal(body.tools[0].cache_control, undefined);
  assert.equal(body.tools.at(-1).function.name, "search_code");
  assert.deepEqual(body.tools.at(-1).cache_control, { type: "ephemeral" });
  assert.deepEqual(body.messages[1].content, [
    { type: "text", text: "diff of src/pay.ts", cache_control: { type: "ephemeral" } },
  ]);
  assert.equal(body.messages[2].cache_control, undefined);
  assert.equal(body.messages[3].role, "tool");
  assert.equal(body.messages[3].cache_control, undefined);
  assert.equal(body.messages[3].content, "file bytes");
  assert.equal(body.session_id, "suds-review/12");
  assert.equal(body.tool_choice, "auto");
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(cacheMarkers(body).length, 3);
  assert.deepEqual(messages, reviewMessages);
  assert.equal(REPO_TOOLS.some((tool) => "cache_control" in tool), false);
  assert.equal(TOOL_LIMITS.maxRounds, 12);
});

test("a content-block repo context is cached on its last text block", () => {
  const body = openRouterChatBody({
    system: "stable instructions",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "preface" },
        { type: "text", text: "large repo context" },
      ],
    }],
    effort: "high",
    withTools: true,
    mustAnswer: false,
    cachePrompt: true,
  });
  assert.equal(body.messages[1].content[0].cache_control, undefined);
  assert.deepEqual(body.messages[1].content[1].cache_control, { type: "ephemeral" });
  assert.equal(cacheMarkers(body).length, 3);
});

test("the answering call keeps the prompt cache and drops the tools", () => {
  const body = openRouterChatBody({
    system: "stable instructions",
    messages: [{ role: "user", content: "large repo context" }],
    effort: "high",
    withTools: true,
    mustAnswer: true,
    cachePrompt: true,
    sessionId: `suds-review/${"n".repeat(300)}`,
  });
  assert.equal(body.tools, undefined);
  assert.equal(body.tool_choice, undefined);
  assert.equal(body.messages[0].content[0].cache_control.type, "ephemeral");
  assert.equal(body.messages[1].content[0].text, "large repo context");
  assert.equal(body.session_id.length, 256);
  assert.equal(cacheMarkers(body).length, 2);
});

test("one-shot and non-Anthropic calls do not send cache breakpoints", () => {
  const plain = openRouterChatBody({
    system: "rewrite lessons",
    messages: [{ role: "user", content: "huge lessons" }],
    effort: "high",
    withTools: false,
    mustAnswer: true,
  });
  assert.equal(plain.messages[0].content, "rewrite lessons");
  assert.equal(plain.messages[1].content, "huge lessons");
  assert.equal(plain.tools, undefined);
  assert.equal(plain.session_id, undefined);
  assert.equal(cacheMarkers(plain).length, 0);

  const other = openRouterChatBody({
    model: "openai/gpt-5.4",
    system: "stable instructions",
    messages: [{ role: "user", content: "large repo context" }],
    effort: "high",
    withTools: true,
    mustAnswer: false,
    cachePrompt: true,
    sessionId: "suds-review/1",
  });
  assert.equal(other.messages[0].content, "stable instructions");
  assert.equal(other.messages[1].content, "large repo context");
  assert.equal(other.tools.at(-1).cache_control, undefined);
  assert.equal(other.session_id, undefined);
  assert.equal(cacheMarkers(other).length, 0);
  assert.equal(anthropicModel(MODEL), true);
  assert.equal(anthropicModel("claude-opus-5-5"), true);
  assert.equal(anthropicModel("openai/gpt-5.4"), false);
});

test("a debounced run reviews only when its head is still current", () => {
  const sha = "a".repeat(40);
  assert.equal(headMovedOn(sha, sha), false);
  assert.equal(headMovedOn(sha, sha.toUpperCase()), false);
  assert.equal(headMovedOn(sha, "b".repeat(40)), true);
  assert.equal(headMovedOn(sha, ""), false);
  assert.equal(headMovedOn(sha, null), false);
});

test("the workflow reviews once, about 10 minutes after pushes stop", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const group = workflow.indexOf("group: suds-review-${{ github.event.pull_request.number }}");
  const cancel = workflow.indexOf("cancel-in-progress: true");
  const wait = workflow.indexOf("run: sleep 600");
  const review = workflow.indexOf("run: node .github/suds-review/review.mjs\n");
  const aborted = workflow.indexOf("--finish-aborted");
  assert.ok(group > 0);
  assert.ok(cancel > group);
  assert.ok(wait > 0 && review > wait && aborted > review);
  assert.match(workflow, /timeout-minutes:\s*50/);
  assert.equal(TOOL_LIMITS.maxRounds, 12);
});
