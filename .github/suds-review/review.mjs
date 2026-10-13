#!/usr/bin/env node
// Suds Review runner (.github/workflows/suds-review.yml). Reviews one pull
// request head with Claude, posts each finding as a review thread on its line,
// resolves its own threads that a later push fixed, and reports the
// "Suds Review" check run on the exact head SHA. Decisions live in
// scripts/suds-review-core.mjs; this file only does IO.
//
//   node .github/suds-review/review.mjs                      # in Actions
//   node .github/suds-review/review.mjs --finish-aborted <job-status>
//   node .github/suds-review/review.mjs --dry-run <base-sha> <head-sha> [fake-review.json]
//
// --dry-run never calls GitHub. It prints the plan (kind, files, batches,
// prompt sizes) and, with a fake review JSON, the comments it would post. It
// calls OpenRouter only when OPENROUTER_API_KEY is set and no fake is given.
// The key is never written to a log. Actions masks it because the workflow
// passes it from the secrets context.
//
// Security: the workflow runs this file from the BASE branch. The PR's code
// is read with git as data and never installed, built, or executed.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openRouterChat } from "./openrouter-client.mjs";
import * as core from "./core.mjs";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const CHECK_ID_FILE = join(process.env.RUNNER_TEMP ?? "/tmp", "suds-review-check-id");
const API = process.env.GITHUB_API_URL || "https://api.github.com";

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (allowFail) return null;
    throw new Error(`git ${args.slice(0, 3).join(" ")} failed: ${String(error.stderr ?? error.message).trim().slice(0, 300)}`);
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function openRouterKey() {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) throw new Error(core.MISSING_OPENROUTER_KEY);
  return key;
}

function chat(body) {
  return openRouterChat(body, { key: openRouterKey() });
}

// GitHub REST/GraphQL. Reads retry on network errors, 429 and 5xx; writes
// never retry (a retried POST could post a finding twice).
async function github(method, path, body) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  const read = method === "GET" || (path === "/graphql" && !/^\s*mutation/.test(body?.query ?? ""));
  for (let attempt = 1; ; attempt += 1) {
    let response;
    try {
      response = await fetch(`${API}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (read && attempt < 3) { await sleep(2_000 * attempt); continue; }
      throw new Error(`GitHub ${method} ${path} failed: ${error.message}`);
    }
    if (read && attempt < 3 && (response.status === 429 || response.status >= 500)) { await sleep(2_000 * attempt); continue; }
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`GitHub ${method} ${path} returned ${response.status}: ${text.slice(0, 300)}`);
      error.status = response.status;
      throw error;
    }
    let data = null;
    try { data = text ? JSON.parse(text) : null; }
    catch { throw new Error(`GitHub ${method} ${path} returned unreadable JSON`); }
    if (path === "/graphql" && Array.isArray(data?.errors) && data.errors.length) {
      throw new Error(`GitHub GraphQL error: ${data.errors.map((e) => e.message).join("; ").slice(0, 300)}`);
    }
    return data;
  }
}

const THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
    reviewThreads(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id isResolved path line comments(first: 50) { totalCount nodes { databaseId author { login } body } } }
    } } } }`;

async function fetchThreads(repo, number) {
  const [owner, name] = repo.split("/");
  const nodes = [];
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const data = await github("POST", "/graphql", { query: THREADS_QUERY, variables: { owner, repo: name, number, cursor } });
    const connection = data?.data?.repository?.pullRequest?.reviewThreads;
    if (!Array.isArray(connection?.nodes)) throw new Error("GitHub returned unreadable review threads");
    nodes.push(...connection.nodes);
    if (!connection.pageInfo?.hasNextPage) return core.ownThreads(nodes);
    cursor = connection.pageInfo.endCursor;
  }
  throw new Error("more than 2,000 review threads; stopped reading");
}

async function resolveThread(ctx, thread, note) {
  await github("POST", `/repos/${ctx.repo}/pulls/${ctx.number}/comments/${thread.commentId}/replies`, { body: `${note}\n\n<!-- suds-review-resolution -->` });
  await github("POST", "/graphql", {
    query: "mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }",
    variables: { id: thread.threadId },
  });
}

async function postFinding(ctx, finding, commentable) {
  const body = core.findingBody(finding);
  const line = core.snapLine(finding.line, commentable ?? new Set());
  const path = `/repos/${ctx.repo}/pulls/${ctx.number}/comments`;
  if (line !== null) {
    try {
      return await github("POST", path, { body, commit_id: ctx.headSha, path: finding.path, line, side: "RIGHT" });
    } catch (error) {
      // 422: GitHub would not anchor to that line; fall back to the file.
      if (error.status !== 422) throw error;
    }
  }
  return github("POST", path, { body, commit_id: ctx.headSha, path: finding.path, subject_type: "file" });
}

// The newest earlier PR commit that a completed, full-coverage review saw.
async function lastFullyReviewedSha(ctx) {
  const total = Number(ctx.commitCount) || 0;
  const lastPage = Math.max(1, Math.ceil(total / 100));
  const commits = [];
  for (const page of new Set([Math.max(1, lastPage - 1), lastPage])) {
    commits.push(...(await github("GET", `/repos/${ctx.repo}/pulls/${ctx.number}/commits?per_page=100&page=${page}`)));
  }
  const shas = [...new Set(commits.map((commit) => commit.sha))].reverse().filter((sha) => sha !== ctx.headSha).slice(0, 15);
  for (const sha of shas) {
    const runs = await github("GET", `/repos/${ctx.repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(core.CHECK_NAME)}&filter=all&per_page=100`);
    if (core.fullyReviewedRun(runs, sha)) return sha;
  }
  return null;
}

// lessonsPath: the replay eval's override (.github/suds-review/eval.mjs: a
// candidate lessons file, or "none"); CI always reads the base branch's file.
// A missing default file is no lessons; a missing override is an error.
const LESSONS_FILE = ".github/suds-review/lessons.md";
function loadPolicies({ lessonsPath } = {}) {
  const read = (path) => readFileSync(join(ROOT, path), "utf8");
  // Every policy file is optional: a repo without AGENTS.md, CLAUDE.md or
  // .cursor/rules still gets a review from the instructions and lessons.
  const rulesDir = join(ROOT, ".cursor", "rules");
  const ruleNames = existsSync(rulesDir) ? readdirSync(rulesDir).filter((name) => name.endsWith(".mdc")) : [];
  const rules = core.alwaysApplyRules(ruleNames.map((name) => ({ name, text: readFileSync(join(rulesDir, name), "utf8") })));
  const policies = ["AGENTS.md", "CLAUDE.md"].filter((name) => existsSync(join(ROOT, name))).map((name) => ({ name, text: read(name) }));
  policies.push(...rules.map((rule) => ({ name: `.cursor/rules/${rule.name}`, text: rule.text })));
  if (existsSync(join(ROOT, ".cursor", "BUGBOT.md"))) policies.push({ name: ".cursor/BUGBOT.md", text: read(".cursor/BUGBOT.md") });
  const lessons = lessonsPath === "none" ? ""
    : lessonsPath ? readFileSync(resolve(ROOT, lessonsPath), "utf8")
    : existsSync(join(ROOT, LESSONS_FILE)) ? read(LESSONS_FILE) : "";
  return core.systemPrompt({ instructions: read(".github/suds-review/instructions.md"), lessons: core.lessonsText(lessons), policies });
}

// The PR's files and each reviewable file's annotated diff.
function readDiff(baseSha, headSha) {
  const mergeBase = git(["merge-base", baseSha, headSha]).trim();
  const prFiles = core.parseNameStatus(git(["-c", "core.quotePath=false", "diff", "--name-status", "-z", "-M", mergeBase, headSha]));
  return { mergeBase, prFiles };
}

function annotate(mergeBase, headSha, file) {
  const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
  // Literal pathspecs: a PR file named like ":(glob)*" must not widen the diff.
  const text = git(["--literal-pathspecs", "-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "-M", `-U${core.LIMITS.contextLines}`, mergeBase, headSha, "--", ...paths]);
  return { ...file, ...core.annotateFileDiff(text) };
}

// Repository reads for the reviewer (core.REPO_TOOLS): git objects of the
// head commit only. A bad regex is reported to the model, not swallowed.
function runTool(headSha, block) {
  const request = core.toolRequest(block.name, block.input);
  if (request.error) return { content: request.error, is_error: true };
  if (request.kind === "read") {
    const text = git(["show", `${headSha}:${request.path}`], { allowFail: true });
    if (text === null) return { content: `${request.path} does not exist at the head commit`, is_error: true };
    return { content: core.clipToolResult(core.fileSlice(text, request.start, request.end)) };
  }
  try {
    const out = execFileSync("git", ["grep", "-n", "-I", "-E", "--no-color", "-e", request.pattern, headSha, "--", ...core.searchPathspecs(request.prefix)], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
    return { content: core.clipToolResult(core.searchResult(out, headSha)) };
  } catch (error) {
    if (error.status === 1) return { content: "(no matches)" };
    return { content: `search failed: ${String(error.stderr ?? error.message).trim().slice(0, 200)}`, is_error: true };
  }
}

// CI checks out a partial clone (blob:none). Before a review with repository
// reads, fetch the head's code-sized files in one batch so reads and searches
// do not download them one at a time. A full clone has them already.
function prefetchHeadBlobs(headSha) {
  if (git(["config", "--get", "remote.origin.promisor"], { allowFail: true })?.trim() !== "true") return 0;
  const oids = core.prefetchOids(git(["ls-tree", "-r", headSha]));
  if (oids.length) {
    execFileSync("git", ["-c", "fetch.negotiationAlgorithm=noop", "fetch", "--no-tags", "--no-write-fetch-head", "--quiet", "--filter=blob:none", "--stdin", "origin"], { cwd: ROOT, input: `${oids.join("\n")}\n`, stdio: ["pipe", "ignore", "pipe"], timeout: 5 * 60 * 1000 });
  }
  return oids.length;
}

// One batch review. With headSha, the reviewer may read the repository
// (core.REPO_TOOLS) for up to core.TOOL_LIMITS.maxRounds rounds before it
// must answer.
async function callClaude(system, user, effort, { headSha = null, readUntil = Infinity } = {}) {
  const messages = [{ role: "user", content: user }];
  let usage = core.EMPTY_RAW_USAGE;
  let toolCalls = 0;
  // Checked before every request (a later batch can start after the review's
  // reading time is up): once spent, the request forbids tools so the model
  // answers in that same call.
  let mustAnswer = false;
  for (let round = 0; round <= core.TOOL_LIMITS.maxRounds + 1; round += 1) {
    mustAnswer ||= core.readingSpent({ round, now: Date.now(), readUntil });
    const result = await chat(core.openRouterChatBody({
      system, messages, effort, withTools: Boolean(headSha), mustAnswer: !headSha || mustAnswer,
    }));
    usage = core.sumRawUsage(usage, result.usage);
    if (result.refusal) throw new Error("Claude declined to review this batch");
    if (result.finish === "length") throw new Error("Claude's review hit the output limit");
    if (core.openRouterHasToolCalls(result)) {
      if (!headSha) throw new Error("Claude asked for a tool on a review without tools");
      if (mustAnswer) throw new Error("Claude asked to read after reading was closed");
      toolCalls += result.toolCalls.length;
      messages.push(core.openRouterAssistantTurn(result));
      for (const call of result.toolCalls) {
        const ran = runTool(headSha, { name: call.name, input: call.input ?? {} });
        messages.push({ role: "tool", tool_call_id: call.id, content: ran.is_error ? `error: ${ran.content}` : ran.content });
      }
      continue;
    }
    const raw = core.reviewJson(result.text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(core.notJsonReason(result.text));
    return { raw, usage, model: result.model || core.MODEL, toolCalls };
  }
  throw new Error("Claude kept reading past its budget without answering");
}

function describe(error) {
  return String(error?.message ?? error)
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 300);
}

// Reviews the batches and returns what to post and resolve. Pure apart from
// the Claude calls; GitHub writes happen in run().
async function reviewBatches({ system, pr, kind, batches, open, fake, meter, repoTools = false, effort = core.effortFor(kind) }) {
  const readUntil = Date.now() + core.TOOL_LIMITS.readingMs;
  const findings = [];
  const prior = [];
  for (const batch of batches) {
    const paths = batch.map((file) => file.path);
    const batchPrior = core.batchThreads(open, batch);
    const user = core.batchPrompt({ pr, batch, prior: batchPrior, kind });
    meter.calls += 1;
    const result = fake ? { raw: fake, usage: {}, model: meter.model } : await callClaude(system, user, effort, { headSha: repoTools ? pr.headSha : null, readUntil });
    meter.usage = core.addUsage(meter.usage, result.usage);
    meter.toolCalls = (meter.toolCalls ?? 0) + (result.toolCalls ?? 0);
    meter.model = result.model ?? meter.model;
    const review = core.validateReview(result.raw, { paths, priorIds: batchPrior.map((thread) => thread.id) });
    findings.push(...review.findings);
    prior.push(...review.prior);
  }
  return { findings: core.dedupeFindings(findings, open), prior };
}

async function run() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const pull = event.pull_request;
  const ctx = {
    repo: process.env.GITHUB_REPOSITORY,
    number: pull.number,
    headSha: pull.head.sha,
    baseSha: pull.base.sha,
    commitCount: pull.commits,
    runUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  };
  const check = await github("POST", `/repos/${ctx.repo}/check-runs`, {
    name: core.CHECK_NAME, head_sha: ctx.headSha, status: "in_progress", details_url: ctx.runUrl, external_id: String(process.env.GITHUB_RUN_ID ?? ""),
    output: { title: "Reviewing", summary: "Suds Review is reading this push." },
  });
  writeFileSync(CHECK_ID_FILE, String(check.id));

  let kind = "full";
  let reviewed = [];
  let skipped = [];
  // Filled call by call, so a failure in a later batch still logs tokens spent.
  const meter = { usage: core.EMPTY_USAGE, model: core.MODEL, calls: 0 };
  let posted = 0;
  let resolved = 0;
  let error = null;
  // A thread that would not resolve stays open (the check fails on it), but
  // must not stop this push's new findings from being posted.
  const resolveFailures = [];
  const resolveOrRecord = async (thread, note) => {
    try {
      await resolveThread(ctx, thread, note);
      resolved += 1;
    } catch (caught) {
      console.error(caught);
      resolveFailures.push(describe(caught));
    }
  };
  let unavailable = null;
  let note = "";
  try {
    // The PR head is fetched as data only.
    git(["fetch", "--no-tags", "--quiet", "origin", `+refs/pull/${ctx.number}/head:refs/suds-review/head`, ctx.baseSha]);
    if (git(["cat-file", "-t", ctx.headSha], { allowFail: true })?.trim() !== "commit") throw new Error(`head ${ctx.headSha.slice(0, 9)} is not fetchable (a newer push replaced it)`);
    const { mergeBase, prFiles } = readDiff(ctx.baseSha, ctx.headSha);
    kind = core.classifyPaths(core.prPaths(prFiles));

    let open = (await fetchThreads(ctx.repo, ctx.number)).filter((thread) => !thread.isResolved);
    const offDiff = core.threadsOffDiff(open, prFiles);
    for (const thread of offDiff) {
      await resolveOrRecord(thread, `Resolved by Suds Review on ${ctx.headSha.slice(0, 9)}: this file is no longer changed by the PR.`);
    }
    open = open.filter((thread) => !offDiff.includes(thread));

    if (kind === "full" || kind === "tooling") {
      const since = await lastFullyReviewedSha(ctx);
      const changed = since && git(["cat-file", "-t", since], { allowFail: true })?.trim() === "commit"
        ? git(["-c", "core.quotePath=false", "diff", "--name-only", "-z", since, ctx.headSha]).split("\0").filter(Boolean)
        : null;
      if (changed) note = `Re-reviewed only the files changed since ${since.slice(0, 9)}, the last fully reviewed push.`;
      const files = core.filesToReview({ prFiles, changedSinceReviewed: changed }).map((file) => annotate(mergeBase, ctx.headSha, file));
      const plan = core.planBatches(files);
      skipped = plan.skipped;
      reviewed = plan.batches.flat();
      if (plan.batches.length) {
        if (!process.env.OPENROUTER_API_KEY?.trim()) {
          unavailable = core.MISSING_OPENROUTER_KEY;
        } else {
          // Repository reads are on unless the repo variable says "off".
          const repoTools = process.env.SUDS_REVIEW_REPO_TOOLS !== "off";
          if (repoTools) {
            try { prefetchHeadBlobs(ctx.headSha); }
            catch (caught) {
              // Reads still work without it, one file download at a time.
              console.error(caught);
              note = `${note ? `${note} ` : ""}Could not prefetch the head's files (${describe(caught)}); repository reads were slower.`;
            }
          }
          const result = await reviewBatches({
            system: loadPolicies(), kind, batches: plan.batches, open, meter, repoTools,
            pr: { number: ctx.number, headSha: ctx.headSha, title: pull.title, body: pull.body },
          });
          const commentable = new Map(reviewed.map((file) => [file.path, file.commentable]));
          for (const answer of result.prior) {
            if (answer.status === "open") continue;
            const verb = answer.status === "fixed" ? "fixed in" : "withdrawn on";
            for (const thread of open.filter((candidate) => candidate.id === answer.id)) {
              await resolveOrRecord(thread, `Resolved by Suds Review: ${verb} ${ctx.headSha.slice(0, 9)}.${answer.note ? ` ${answer.note}` : ""}`);
            }
          }
          for (const finding of result.findings) {
            await postFinding(ctx, finding, commentable.get(finding.path));
            posted += 1;
          }
        }
      }
    }
    if (resolveFailures.length) {
      throw new Error(`could not resolve ${resolveFailures.length} fixed thread${resolveFailures.length === 1 ? "" : "s"}: ${resolveFailures[0]}`);
    }
  } catch (caught) {
    error = describe(caught);
    console.error(caught);
  }

  let openNow = null;
  try { openNow = (await fetchThreads(ctx.repo, ctx.number)).filter((thread) => !thread.isResolved).length; }
  catch (caught) { error ??= `could not re-read review threads: ${describe(caught)}`; }
  const outcome = core.decideOutcome({ error, unavailable, open: openNow ?? 0, skipped, kind });
  const summary = core.checkSummary({ outcome, kind, effort: core.effortFor(kind), headSha: ctx.headSha, reviewed, skipped, usage: meter.usage, calls: meter.calls, model: meter.model, posted, resolved, open: openNow ?? 0, note, reads: meter.toolCalls ?? 0 });
  await github("PATCH", `/repos/${ctx.repo}/check-runs/${check.id}`, {
    status: "completed", conclusion: outcome.conclusion, output: { title: outcome.title, summary },
  });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  console.log(summary);
  if (error) process.exitCode = 1;
}

// The job was cancelled (a newer push) or crashed: never leave the check spinning.
async function finishAborted(jobStatus) {
  if (!existsSync(CHECK_ID_FILE)) return;
  const id = readFileSync(CHECK_ID_FILE, "utf8").trim();
  const repo = process.env.GITHUB_REPOSITORY;
  const current = await github("GET", `/repos/${repo}/check-runs/${id}`);
  if (current.status === "completed") return;
  const cancelled = jobStatus === "cancelled";
  await github("PATCH", `/repos/${repo}/check-runs/${id}`, {
    status: "completed",
    conclusion: cancelled ? "cancelled" : "failure",
    output: {
      title: cancelled ? "Stopped: a newer push or event replaced this review" : "Review could not run: the job failed",
      summary: `See the workflow run for details.\n\n<!-- suds-review-coverage: none -->`,
    },
  });
}

// Replay eval options (.github/suds-review/eval.mjs), dry-run only:
//   SUDS_REVIEW_LESSONS=<path>|none   review with another lessons file
//   SUDS_REVIEW_ONLY_PATHS=<a>\n<b>    review only these PR files
//   SUDS_REVIEW_JSON_OUT=<path>       also write the findings and usage as JSON
//   SUDS_REVIEW_REPO_TOOLS=off        review from the diff alone (CI's default is on)
//   SUDS_REVIEW_EFFORT=<level>        another effort level (high is CI's)
async function dryRun(baseSha, headSha, fakePath) {
  const { mergeBase, prFiles } = readDiff(baseSha, headSha);
  const kind = core.classifyPaths(core.prPaths(prFiles));
  const only = process.env.SUDS_REVIEW_ONLY_PATHS ? new Set(process.env.SUDS_REVIEW_ONLY_PATHS.split("\n").filter(Boolean)) : null;
  const files = core.filesToReview({ prFiles, changedSinceReviewed: null })
    .filter((file) => !only || only.has(file.path) || (file.oldPath && only.has(file.oldPath)))
    .map((file) => annotate(mergeBase, headSha, file));
  const plan = core.planBatches(files);
  const system = loadPolicies({ lessonsPath: process.env.SUDS_REVIEW_LESSONS || undefined });
  console.log(`kind=${kind} effort=${core.effortFor(kind)} files=${prFiles.length} reviewable=${files.length} batches=${plan.batches.length} skipped=${plan.skipped.length}`);
  console.log(`system prompt: ${system.length} chars (~${Math.round(system.length / 4)} tokens, cached)`);
  const prompts = plan.batches.map((batch) => core.batchPrompt({ pr: { number: 0, headSha, title: "(dry run)", body: "" }, batch, prior: [], kind }));
  prompts.forEach((prompt, index) => console.log(`batch ${index + 1}: ${plan.batches[index].length} files, ${prompt.length} chars (~${Math.round(prompt.length / 4)} tokens)`));
  for (const file of plan.skipped) console.log(`not reviewed: ${file.path}: ${file.reason}`);
  if (kind !== "full" && kind !== "tooling") return;
  const fake = fakePath ? JSON.parse(readFileSync(fakePath, "utf8")) : null;
  if (!fake && !process.env.OPENROUTER_API_KEY?.trim()) return;
  const meter = { usage: core.EMPTY_USAGE, model: core.MODEL, calls: 0 };
  const result = await reviewBatches({
    system, kind, batches: plan.batches, open: [], fake, meter, pr: { number: 0, headSha, title: "(dry run)", body: "" },
    repoTools: process.env.SUDS_REVIEW_REPO_TOOLS !== "off",
    effort: process.env.SUDS_REVIEW_EFFORT || core.effortFor(kind),
  });
  const commentable = new Map(plan.batches.flat().map((file) => [file.path, file.commentable]));
  for (const finding of result.findings) {
    const line = core.snapLine(finding.line, commentable.get(finding.path) ?? new Set());
    console.log(`\n--- would post on ${finding.path}:${line ?? "(file)"} ---\n${core.findingBody(finding)}`);
  }
  console.log(`\ncalls: ${meter.calls} repo reads: ${meter.toolCalls ?? 0} tokens: ${JSON.stringify(meter.usage)} cost=$${core.costUSD(meter.usage, meter.model).toFixed(4)}`);
  if (process.env.SUDS_REVIEW_JSON_OUT) {
    writeFileSync(process.env.SUDS_REVIEW_JSON_OUT, JSON.stringify({
      reviewed: plan.batches.flat().map((file) => file.path),
      skipped: plan.skipped,
      findings: result.findings.map(({ path, line, severity, title, scenario, fix }) => ({ path, line, severity, title, scenario, fix })),
      costUSD: core.costUSD(meter.usage, meter.model),
      toolCalls: meter.toolCalls ?? 0,
    }, null, 2));
  }
}

const [mode, ...args] = process.argv.slice(2);
const main = mode === "--finish-aborted" ? () => finishAborted(args[0]) : mode === "--dry-run" ? () => dryRun(args[0], args[1], args[2]) : run;
main().catch((error) => {
  console.error(`suds-review: ${describe(error)}`);
  process.exitCode = 1;
});
