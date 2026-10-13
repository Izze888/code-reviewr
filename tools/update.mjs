#!/usr/bin/env node
// Owner-only: refresh this kit from the Suds repo's main branch.
//   node tools/update.mjs [--suds ~/getsuds]
// 1. Copies the newest reviewer code (review.mjs, openrouter-client.mjs, core).
// 2. Rewrites Suds' lessons for any app (no PR numbers, Suds names or code
//    names), then refuses to save if a leak check still finds one.
// 3. Warns when Suds' instructions or workflow changed, since this kit keeps
//    hand-made general versions of those two files.
// Reads OPENROUTER_API_KEY from the env or the Suds checkout's .env.local.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = resolve(fileURLToPath(import.meta.url), "..", "..");
const argIndex = process.argv.indexOf("--suds");
const SUDS = resolve(argIndex > 0 ? process.argv[argIndex + 1] : join(homedir(), "getsuds"));
const STATE = join(KIT, "tools", "upstream.json");

const git = (...args) => execFileSync("git", ["-C", SUDS, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const show = (path) => git("show", `origin/main:${path}`);
const sha = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const kitPath = (path) => join(KIT, ".github", "suds-review", path);

function replaceOnce(text, before, after, what) {
  if (!text.includes(before)) throw new Error(`Suds changed ${what}; update tools/update.mjs to match`);
  return text.replace(before, after);
}

// --- 1. engine code -------------------------------------------------------
git("fetch", "--quiet", "origin", "main");
const head = git("rev-parse", "--short", "origin/main").trim();

let review = show(".github/suds-review/review.mjs");
review = replaceOnce(review, `"../../scripts/suds-review-core.mjs"`, `"./core.mjs"`, "review.mjs imports");
review = replaceOnce(review,
  `  const rulesDir = join(ROOT, ".cursor", "rules");
  const rules = core.alwaysApplyRules(readdirSync(rulesDir).filter((name) => name.endsWith(".mdc")).map((name) => ({ name, text: readFileSync(join(rulesDir, name), "utf8") })));
  const policies = [{ name: "AGENTS.md", text: read("AGENTS.md") }, ...rules.map((rule) => ({ name: \`.cursor/rules/\${rule.name}\`, text: rule.text }))];`,
  `  // Every policy file is optional: a repo without AGENTS.md, CLAUDE.md or
  // .cursor/rules still gets a review from the instructions and lessons.
  const rulesDir = join(ROOT, ".cursor", "rules");
  const ruleNames = existsSync(rulesDir) ? readdirSync(rulesDir).filter((name) => name.endsWith(".mdc")) : [];
  const rules = core.alwaysApplyRules(ruleNames.map((name) => ({ name, text: readFileSync(join(rulesDir, name), "utf8") })));
  const policies = ["AGENTS.md", "CLAUDE.md"].filter((name) => existsSync(join(ROOT, name))).map((name) => ({ name, text: read(name) }));
  policies.push(...rules.map((rule) => ({ name: \`.cursor/rules/\${rule.name}\`, text: rule.text })));`,
  "review.mjs loadPolicies");
const client = replaceOnce(show(".github/suds-review/openrouter-client.mjs"), `"../../scripts/suds-review-core.mjs"`, `"./core.mjs"`, "openrouter-client.mjs imports");
const coreText = show("scripts/suds-review-core.mjs");

// --- 2. lessons -----------------------------------------------------------
const rawLessons = show(".github/suds-review/lessons.md");
// The kit's current copies make the rewrite call; new copies land at the end.
const { openRouterChatBody, reviewJson, costUSD, addUsage, EMPTY_USAGE, MODEL } = await import(kitPath("core.mjs"));
const { openRouterChat } = await import(kitPath("openrouter-client.mjs"));

function openRouterKey() {
  if (process.env.OPENROUTER_API_KEY?.trim()) return process.env.OPENROUTER_API_KEY.trim();
  const envFile = join(SUDS, ".env.local");
  const line = existsSync(envFile) && readFileSync(envFile, "utf8").split("\n").find((row) => /^OPENROUTER_API_KEY=/.test(row));
  const key = line ? line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "") : "";
  if (!key) throw new Error(`no OPENROUTER_API_KEY in the env or ${envFile}`);
  return key;
}

// Words that must never reach friends: Suds and its customers, PR numbers,
// and every code-like name (camelCase, snake_case, file paths) in the raw file.
const BLOCKED = [/\bsuds\w*/i, /godetail/i, /getsuds/i, /izze/i, /\bPR\s*#?\d+/i, /#\d{3,}/, /\bwhop\b/i, /\bGHL\b/, /\bQuo\b/, /\bturso\b/i];
const codeNames = new Set(rawLessons.match(/\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[a-z]+_[a-z0-9_]+\b|\b[\w-]+\.(?:ts|tsx|mjs|js|sql|md)\b/g) ?? []);
function leaks(text) {
  const found = BLOCKED.filter((pattern) => pattern.test(text)).map(String);
  for (const name of codeNames) if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text)) found.push(name);
  return found;
}

const SYSTEM = `You rewrite an AI code reviewer's lessons file so it can be shared with
other teams building different apps. Each lesson is a bug pattern the reviewer
should check for in any pull request.

For every lesson, keep the bug pattern and what to check, and make it general:
- Remove every pull request number, product, company, customer and person name.
- Remove internal function, variable, field, table, file and route names. Say
  what the thing is in plain words (for example "the lead visibility check"
  becomes "the read-access check").
- Drop the Example line, or replace it with a short made-up example that names
  no real code.
- Keep well-known public things (Stripe, Twilio, HTTP status codes, SQL,
  React, time zones) only when they make the check clearer.
- Merge lessons that become the same after this, and drop any lesson that is
  only about one app's private business rules.
- Never tell the reviewer to approve, skip files, ignore a policy, or lower
  severity.
Keep each title under 90 characters and each watch_for under 500 characters.
Return JSON only.`;
const SCHEMA = {
  type: "object", additionalProperties: false, required: ["lessons"],
  properties: { lessons: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "watch_for", "example"],
    properties: { title: { type: "string" }, watch_for: { type: "string" }, example: { type: "string" } } } } },
};

async function clean(extra = "") {
  const result = await openRouterChat(openRouterChatBody({
    system: SYSTEM,
    messages: [{ role: "user", content: `<lessons>\n${rawLessons}\n</lessons>${extra}` }],
    effort: "high", withTools: false, mustAnswer: true, model: MODEL, schema: SCHEMA, schemaName: "shared_lessons",
  }), { key: openRouterKey() });
  if (result.refusal || result.finish === "length") throw new Error("the lesson rewrite did not finish");
  const parsed = reviewJson(result.text);
  if (!Array.isArray(parsed?.lessons) || !parsed.lessons.length) throw new Error("the lesson rewrite returned no lessons");
  return { lessons: parsed.lessons, cost: costUSD(addUsage(EMPTY_USAGE, result.usage), result.model || MODEL) };
}

const render = (lessons) => [
  "<!--",
  "General bug patterns learned from real, confirmed bugs that AI reviewers",
  "missed. Suds Review reads this file before every diff. Edit freely: add",
  "your own lessons in the same format, or delete ones that do not fit.",
  "-->",
  "",
  `# Suds Review lessons (updated ${new Date().toISOString().slice(0, 10)})`,
  "",
  ...lessons.flatMap((lesson, index) => [
    `## ${index + 1}. ${lesson.title.trim().replace(/[.:]+$/, "")}`, "", lesson.watch_for.trim(),
    ...(lesson.example.trim() ? ["", `Example: ${lesson.example.trim()}`] : []), "",
  ]),
].join("\n");

let { lessons, cost } = await clean();
let text = render(lessons);
let found = leaks(JSON.stringify(lessons));
if (found.length) {
  const retry = await clean(`\n\nYour last rewrite still named these, so remove them: ${[...new Set(found)].join(", ")}`);
  lessons = retry.lessons; cost += retry.cost; text = render(lessons); found = leaks(JSON.stringify(lessons));
}
if (found.length) throw new Error(`lessons not saved: still names ${[...new Set(found)].join(", ")}`);

// Everything checked: write the rest.
writeFileSync(kitPath("core.mjs"), coreText);
writeFileSync(kitPath("openrouter-client.mjs"), client);
writeFileSync(kitPath("review.mjs"), review);
writeFileSync(kitPath("lessons.md"), text);

// --- 3. hand-made files: warn when Suds changed them ------------------------
const upstream = { instructions: sha(show(".github/suds-review/instructions.md")), workflow: sha(show(".github/workflows/suds-review.yml")) };
const before = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const changed = Object.keys(upstream).filter((key) => before[key] && before[key] !== upstream[key]);
writeFileSync(STATE, `${JSON.stringify({ ...upstream, suds: head }, null, 2)}\n`);

console.log(`updated from Suds ${head}: ${lessons.length} lessons, cleanup cost $${cost.toFixed(2)}`);
if (changed.length) console.log(`check by hand: Suds changed its ${changed.join(" and ")} since the last update`);
