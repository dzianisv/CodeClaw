#!/usr/bin/env bun
/**
 * OpenClaw Eval: Agent Task Execution Quality
 *
 * Posts eval tasks as GitHub issues (mentions + direct assignment trigger),
 * waits for the bot to reply, writes a promptfoo-compatible vars file,
 * then runs `npx promptfoo eval` for LLM-as-judge scoring.
 *
 * Usage:
 *   bun scripts/eval-openclaw.ts [--repo owner/repo] [--timeout 300] [--keep]
 *
 * Requires:
 *   - OpenClaw gateway running (hooks enabled)
 *   - Webhook bridge running (start-clawengineer-webhook-bridge.ts)
 *   - gh CLI authenticated (runtime GH_TOKEN/GITHUB_TOKEN override is supported)
 */

import { spawnSync } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/* ------------------------------------------------------------------ */
/*  Types & Config                                                     */
/* ------------------------------------------------------------------ */

type EvalCase = {
  id: string;
  title: string;
  trigger: "mention" | "assignment";
  completionMode: "started" | "terminal";
  /** Canonical scenario instruction shared across eval suites. */
  task: string;
  /** Instructions for the LLM judge (used in promptfoo llm-rubric) */
  judgeCriteria: string;
};

const EVAL_CASES: EvalCase[] = [
  {
    id: "python-hello-world",
    title: "Create a Python hello world",
    trigger: "mention",
    completionMode: "terminal",
    task: "Create a file called hello.py that prints 'Hello, World!' to stdout. Only create the file, nothing else.",
    judgeCriteria: [
      "Accept as correct if the bot clearly states it created `hello.py` and that it prints 'Hello, World!' to stdout.",
      "Also accept when the bot shows the file contents directly (for example `print('Hello, World!')`).",
      "If the response contains error messages about network failures, gh CLI, or GitHub API — that is a FAILURE even if partial output is present.",
      "Score 0-10: 10 = file created correctly with clean output, 5 = correct logic but noisy output, 0 = wrong or no useful output.",
    ].join("\n"),
  },
  {
    id: "typescript-bun-hello",
    title: "Create a TypeScript/Bun hello world",
    trigger: "mention",
    completionMode: "terminal",
    task: "Create a file called hello.ts that uses console.log to print 'Hello from Bun!'. Only create the file, nothing else.",
    judgeCriteria: [
      "Accept as correct if the bot clearly states it created `hello.ts` and that it prints 'Hello from Bun!' via console.log.",
      "Also accept when the bot shows the file contents directly (for example `console.log('Hello from Bun!')`).",
      "The file should be valid TypeScript that runs under Bun.",
      "If the response contains error messages about network failures, gh CLI, or GitHub API — that is a FAILURE even if partial output is present.",
      "Score 0-10: 10 = file created correctly with clean output, 5 = correct logic but noisy output, 0 = wrong or no useful output.",
    ].join("\n"),
  },
  {
    id: "research-gpt-release",
    title: "Research: first GPT model release date",
    trigger: "mention",
    completionMode: "terminal",
    task: "Research and tell me when the first GPT model was released by OpenAI. Provide month and year if possible.",
    judgeCriteria: [
      "The bot should state that GPT-1 was released in June 2018 (the paper 'Improving Language Understanding by Generative Pre-Training' by Radford et al.).",
      "Acceptable: mentioning 2018 as the year. Bonus for mentioning June 2018.",
      "If the bot says GPT-2 (2019), GPT-3 (2020), or ChatGPT (2022) as the FIRST model, that is wrong.",
      "If the response contains error messages about network failures, gh CLI, or GitHub API — deduct points but still evaluate the factual content if present.",
      "Score 0-10: 10 = correct date + clean summary, 7 = correct year but vague, 3 = wrong model/date, 0 = no useful answer.",
    ].join("\n"),
  },
  {
    id: "direct-assignment-no-mention",
    title: "Direct assignment trigger without mention",
    trigger: "assignment",
    completionMode: "started",
    task: "You are assigned directly. Start working this issue and post run status.",
    judgeCriteria: [
      "This case is about trigger behavior: the issue was ASSIGNED directly (without an @mention comment) to a configured assignment identity for OpenClaw.",
      "The bot should proceed from assignment trigger alone and post a run-start/status reply.",
      "Pass if the evidence indicates assignment trigger was attempted and agent started work.",
      "Fail if the bot asks for an @mention or no bot reply exists after timeout.",
      "Score 0-10: 10 = assignment trigger handled with clear run-start status, 5 = partial action but ambiguous start, 0 = no useful action.",
    ].join("\n"),
  },
];

/* ------------------------------------------------------------------ */
/*  CLI Args                                                           */
/* ------------------------------------------------------------------ */

type Args = {
  repo: string;
  appHandle: string;
  assignmentLogin?: string;
  timeoutSec: number;
  pollSec: number;
  keepArtifacts: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    repo: "dzianisv/codebridge-test",
    appHandle: process.env.EVAL_APP_HANDLE?.trim() || "@clawengineer",
    assignmentLogin: process.env.EVAL_ASSIGNMENT_LOGIN?.trim() || undefined,
    timeoutSec: 300,
    pollSec: 10,
    keepArtifacts: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--repo" && next) { args.repo = next; i++; }
    else if (arg === "--app-handle" && next) { args.appHandle = next.startsWith("@") ? next : `@${next}`; i++; }
    else if (arg === "--assignment-login" && next) {
      args.assignmentLogin = next.startsWith("@") ? next.slice(1) : next;
      i++;
    }
    else if (arg === "--timeout" && next) { args.timeoutSec = Number(next); i++; }
    else if (arg === "--poll" && next) { args.pollSec = Number(next); i++; }
    else if (arg === "--keep") { args.keepArtifacts = true; }
  }
  return args;
}

function parseLoginList(raw?: string): string[] {
  if (!raw) return [];
  const values = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => (entry.startsWith("@") ? entry.slice(1) : entry).toLowerCase());
  return Array.from(new Set(values));
}

function normalizeLogin(raw?: string): string {
  const trimmed = raw?.trim().toLowerCase() || "";
  if (!trimmed) return "";
  return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

function buildAppIdentityLogins(rawAppHandle: string): { appLogin: string; selfLogins: string[] } {
  const normalized = normalizeLogin(rawAppHandle);
  if (!normalized) {
    throw new Error("App handle/login is empty after normalization.");
  }
  const base = normalized.endsWith("[bot]") ? normalized.slice(0, -5) : normalized;
  if (!base) {
    throw new Error(`Invalid app handle/login: ${rawAppHandle}`);
  }
  const selfLogins = Array.from(new Set([base, `${base}[bot]`]));
  return { appLogin: base, selfLogins };
}

/* ------------------------------------------------------------------ */
/*  GitHub helpers (via gh CLI, keyring auth)                           */
/* ------------------------------------------------------------------ */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function gh(ghArgs: string[], tokenOverride?: string): string {
  const ghEnv = { ...process.env };
  const override = tokenOverride?.trim();
  if (override) {
    ghEnv.GITHUB_TOKEN = override;
    ghEnv.GH_TOKEN = override;
  }
  // Keep GH_TOKEN/GITHUB_TOKEN in sync so explicit runtime override is deterministic.
  if (!ghEnv.GITHUB_TOKEN && ghEnv.GH_TOKEN) ghEnv.GITHUB_TOKEN = ghEnv.GH_TOKEN;
  if (!ghEnv.GH_TOKEN && ghEnv.GITHUB_TOKEN) ghEnv.GH_TOKEN = ghEnv.GITHUB_TOKEN;
  const result = spawnSync("gh", ghArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    env: ghEnv,
    encoding: "utf-8",
  });
  if (result.error) {
    throw new Error(`gh ${ghArgs.join(" ")} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`gh ${ghArgs.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return (result.stdout || "").trim();
}

type BotComment = {
  id: number;
  body: string;
  created_at: string;
  user: { login: string };
};

type IssueComment = {
  id: number;
  body: string;
  html_url: string;
  user: { login: string; type?: string };
};

/**
 * Wait for bot reply on an issue. Polls until "complete" appears in a
 * bot comment or timeout is reached (returns partial if available).
 */
async function waitForBotReply(input: {
  repo: string;
  issueNumber: number;
  botLogin: string;
  completionMode: "started" | "terminal";
  timeoutSec: number;
  pollSec: number;
}): Promise<{ comments: BotComment[]; combinedBody: string }> {
  const deadline = Date.now() + input.timeoutSec * 1000;
  const botLogin = input.botLogin.toLowerCase();

  while (Date.now() < deadline) {
    const raw = gh(["api", `repos/${input.repo}/issues/${input.issueNumber}/comments?per_page=100`]);
    const all = JSON.parse(raw) as BotComment[];
    const botComments = all.filter((c) => (c.user?.login ?? "").toLowerCase() === botLogin);

    const started = botComments.length > 0;
    const completed = botComments.some((c) => isCompletionSignal(c.body ?? ""));

    const done = input.completionMode === "started" ? started : completed;
    if (done) {
      return {
        comments: botComments,
        combinedBody: botComments.map((c) => c.body).join("\n\n---\n\n"),
      };
    }

    await sleep(input.pollSec * 1000);
  }

  // Timeout — return whatever we have
  const raw = gh(["api", `repos/${input.repo}/issues/${input.issueNumber}/comments?per_page=100`]);
  const all = JSON.parse(raw) as BotComment[];
  const botComments = all.filter((c) => (c.user?.login ?? "").toLowerCase() === botLogin);
  if (botComments.length > 0) {
    console.log(`  WARNING: Timed out but found ${botComments.length} partial comment(s)`);
    return {
      comments: botComments,
      combinedBody: botComments.map((c) => c.body).join("\n\n---\n\n"),
    };
  }

  return { comments: [], combinedBody: "(no reply within timeout)" };
}

/**
 * Check for PR diff linked to an issue (file changes by bot).
 */
function getIssueFileChanges(repo: string, issueNumber: number): string | null {
  try {
    const raw = gh(["api", `repos/${repo}/issues/${issueNumber}/timeline?per_page=100`]);
    const events = JSON.parse(raw) as Array<{
      event?: string;
      source?: { issue?: { pull_request?: { html_url?: string }; number?: number } };
    }>;
    const prEvent = events.find((e) => e.source?.issue?.pull_request?.html_url);
    if (prEvent?.source?.issue?.number) {
      const prNum = prEvent.source.issue.number;
      return gh(["pr", "diff", String(prNum), "--repo", repo]);
    }
  } catch {
    // no timeline or no PR
  }
  return null;
}

function createIssue(input: { repo: string; title: string; body: string }): { url: string; number: number } {
  const raw = gh([
    "api",
    "-X", "POST",
    `repos/${input.repo}/issues`,
    "-f", `title=${input.title}`,
    "-f", `body=${input.body}`,
  ]);
  const issue = JSON.parse(raw) as { html_url?: string; number?: number };
  const url = issue.html_url ?? "";
  const number = Number(issue.number);
  if (!url || !Number.isFinite(number) || number <= 0) {
    throw new Error(`Failed to create issue in ${input.repo}. Raw response: ${raw}`);
  }
  return { url, number };
}

function isRetryableCommentCreateError(message: string): boolean {
  return /\(HTTP (422|429|500|502|503|504)\)/i.test(message) ||
    /validation failed/i.test(message) ||
    /secondary rate limit/i.test(message);
}

async function createIssueComment(input: { repo: string; issueNumber: number; body: string }): Promise<IssueComment> {
  const maxAttempts = 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const body = attempt === 1
      ? input.body
      : `${input.body}\n\nRetry marker: comment-retry-${Date.now()}-a${attempt}`;
    try {
      const raw = gh([
        "api",
        "-X", "POST",
        `repos/${input.repo}/issues/${input.issueNumber}/comments`,
        "--raw-field", `body=${body}`,
      ]);
      const comment = JSON.parse(raw) as IssueComment;
      if (!comment?.id || !comment?.html_url) {
        throw new Error(
          `Failed to create issue comment in ${input.repo}#${input.issueNumber}. Raw response: ${raw}`,
        );
      }
      return comment;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = error instanceof Error ? error : new Error(message);
      if (attempt >= maxAttempts || !isRetryableCommentCreateError(message)) {
        throw lastError;
      }
      console.log(
        `    comment create retry ${attempt}/${maxAttempts - 1} for #${input.issueNumber}: ${message.split("\n")[0]}`,
      );
      await sleep(1500 * attempt);
    }
  }

  throw lastError ?? new Error(`Failed to create issue comment in ${input.repo}#${input.issueNumber}.`);
}

function getGhViewerLogin(): string {
  try {
    const raw = gh(["api", "user"]);
    const user = JSON.parse(raw) as { login?: string };
    return user.login?.trim() || "unknown-user";
  } catch {
    return "unknown-user";
  }
}

function parseDotEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadOpenClawStateEnv(): Record<string, string> {
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(homedir(), ".openclaw");
  const envPath = path.join(stateDir, ".env");
  if (!existsSync(envPath)) return {};
  return parseDotEnv(readFileSync(envPath, "utf8"));
}

function sanitizeEnvKey(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function tokenFingerprint(token: string): string {
  if (!token) return "none";
  const hash = createHash("sha256").update(token).digest("hex");
  return `${token.slice(0, 4)}…${hash.slice(0, 8)}`;
}

function resolveOwnerScopedAppToken(
  repo: string,
  openclawStateEnv: Record<string, string>,
): { token: string; source: string } {
  const [owner] = repo.split("/");
  if (!owner) return { token: "", source: "none" };
  const ownerTokenKey = `GITHUB_APP_TOKEN_${sanitizeEnvKey(owner)}`;
  const candidates: Array<{ token: string; source: string }> = [
    { token: process.env[ownerTokenKey]?.trim() || "", source: `process.${ownerTokenKey}` },
    { token: openclawStateEnv[ownerTokenKey]?.trim() || "", source: `openclaw_state.${ownerTokenKey}` },
    { token: process.env.OPENCLAW_GITHUB_TOKEN?.trim() || "", source: "process.OPENCLAW_GITHUB_TOKEN" },
    { token: openclawStateEnv.OPENCLAW_GITHUB_TOKEN?.trim() || "", source: "openclaw_state.OPENCLAW_GITHUB_TOKEN" },
  ];
  const selected = candidates.find((entry) => Boolean(entry.token));
  return selected || { token: "", source: "none" };
}

function runCli(binary: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(binary, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "" },
    encoding: "utf-8",
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function ensureOpenClawGithubTokenForRepo(repo: string): void {
  const [owner] = repo.split("/");
  if (!owner) {
    throw new Error(`Invalid --repo value: "${repo}"`);
  }

  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(homedir(), ".openclaw");
  const envPath = path.join(stateDir, ".env");
  const configPath = path.join(stateDir, "openclaw.json");
  const envVars = existsSync(envPath) ? parseDotEnv(readFileSync(envPath, "utf8")) : {};
  const ownerTokenKey = `GITHUB_APP_TOKEN_${sanitizeEnvKey(owner)}`;
  const desiredToken = process.env[ownerTokenKey]?.trim() || envVars[ownerTokenKey]?.trim() || "";
  if (!desiredToken) {
    console.log(
      `  WARNING: Owner-scoped token "${ownerTokenKey}" not found; keeping current OpenClaw token configuration.`,
    );
    return;
  }

  let configToken = "";
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
        channels?: { github?: { token?: string } };
      };
      configToken = parsed.channels?.github?.token?.trim() || "";
    } catch {
      // ignore malformed local config read; CLI set below is source of truth
    }
  }

  const launchctlGet = runCli("launchctl", ["getenv", "OPENCLAW_GITHUB_TOKEN"]);
  const launchctlToken = launchctlGet.status === 0 ? launchctlGet.stdout.trim() : "";
  const aligned = configToken === desiredToken && launchctlToken === desiredToken;
  if (aligned) {
    console.log(`  OpenClaw GitHub token already aligned for owner "${owner}" (${tokenFingerprint(desiredToken)}).`);
    return;
  }

  console.log(`  Aligning OpenClaw GitHub token for owner "${owner}" (${tokenFingerprint(desiredToken)})...`);

  const setChannelToken = runCli("openclaw", ["config", "set", "channels.github.token", desiredToken]);
  if (setChannelToken.status !== 0) {
    throw new Error(`Failed to set channels.github.token: ${setChannelToken.stderr || setChannelToken.stdout}`);
  }

  const setSkillToken = runCli("openclaw", ["config", "set", 'skills.entries["gh-issues"].apiKey', desiredToken]);
  if (setSkillToken.status !== 0) {
    throw new Error(`Failed to set gh-issues apiKey: ${setSkillToken.stderr || setSkillToken.stdout}`);
  }

  const setLaunchToken = runCli("launchctl", ["setenv", "OPENCLAW_GITHUB_TOKEN", desiredToken]);
  if (setLaunchToken.status !== 0) {
    throw new Error(`Failed to set launchctl OPENCLAW_GITHUB_TOKEN: ${setLaunchToken.stderr || setLaunchToken.stdout}`);
  }

  const restart = runCli("openclaw", ["gateway", "restart"]);
  if (restart.status !== 0) {
    throw new Error(`Failed to restart OpenClaw gateway: ${restart.stderr || restart.stdout}`);
  }
  console.log("  OpenClaw gateway restarted to apply owner-scoped GitHub token.");
}

function loadOpenClawWebhookEnv(): {
  hooksToken: string;
  webhookSecret: string;
  hookTarget: string;
} {
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(homedir(), ".openclaw");
  const envPath = path.join(stateDir, ".env");
  const fromFile = existsSync(envPath) ? parseDotEnv(readFileSync(envPath, "utf8")) : {};

  const hooksToken =
    process.env.OPENCLAW_HOOKS_TOKEN?.trim() ||
    fromFile.OPENCLAW_HOOKS_TOKEN?.trim() ||
    "";
  const webhookSecret =
    process.env.GITHUB_APP_WEBHOOK_SECRET?.trim() ||
    process.env.OPENCLAW_GITHUB_WEBHOOK_SECRET?.trim() ||
    fromFile.GITHUB_APP_WEBHOOK_SECRET?.trim() ||
    fromFile.OPENCLAW_GITHUB_WEBHOOK_SECRET?.trim() ||
    "";
  const hookTarget =
    process.env.OPENCLAW_HOOK_TARGET?.trim() ||
    "http://127.0.0.1:18789/hooks/github";

  return { hooksToken, webhookSecret, hookTarget };
}

async function emitSyntheticIssueCommentWebhook(input: {
  repo: string;
  issueNumber: number;
  comment: IssueComment;
}): Promise<boolean> {
  const { hooksToken, webhookSecret, hookTarget } = loadOpenClawWebhookEnv();
  if (!hooksToken || !webhookSecret) {
    console.log("  WARNING: Synthetic webhook fallback skipped (missing OPENCLAW_HOOKS_TOKEN or webhook secret).");
    return false;
  }
  const [owner, repoName] = input.repo.split("/");
  if (!owner || !repoName) {
    console.log(`  WARNING: Synthetic webhook fallback skipped (invalid repo format: ${input.repo}).`);
    return false;
  }

  const issueRaw = gh(["api", `repos/${input.repo}/issues/${input.issueNumber}`]);
  const issue = JSON.parse(issueRaw) as {
    number: number;
    title?: string;
    html_url?: string;
    assignee?: unknown;
    assignees?: unknown[];
    pull_request?: unknown;
  };

  const payload = {
    action: "created",
    issue: {
      number: issue.number,
      title: issue.title ?? "",
      html_url: issue.html_url ?? "",
      assignee: issue.assignee ?? null,
      assignees: issue.assignees ?? [],
      pull_request: issue.pull_request,
    },
    comment: {
      id: input.comment.id,
      body: input.comment.body,
      html_url: input.comment.html_url,
      user: input.comment.user,
    },
    repository: {
      name: repoName,
      owner: { login: owner },
    },
    sender: input.comment.user,
    installation: { id: null },
  };

  const rawBody = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", webhookSecret).update(rawBody).digest("hex")}`;
  const response = await fetch(hookTarget, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openclaw-token": hooksToken,
      "x-github-event": "issue_comment",
      "x-github-delivery": randomUUID(),
      "x-hub-signature-256": signature,
    },
    body: rawBody,
  });
  const responseText = await response.text();
  if (!response.ok) {
    console.log(`  WARNING: Synthetic webhook fallback failed (${response.status}): ${responseText.slice(0, 240)}`);
    return false;
  }
  console.log(`  Synthetic webhook delivered to ${hookTarget}`);
  return true;
}

async function emitSyntheticIssueAssignedWebhook(input: {
  repo: string;
  issueNumber: number;
  appLogin: string;
  senderLogin: string;
}): Promise<boolean> {
  const { hooksToken, webhookSecret, hookTarget } = loadOpenClawWebhookEnv();
  if (!hooksToken || !webhookSecret) {
    console.log("  WARNING: Synthetic assigned webhook skipped (missing OPENCLAW_HOOKS_TOKEN or webhook secret).");
    return false;
  }
  const [owner, repoName] = input.repo.split("/");
  if (!owner || !repoName) {
    console.log(`  WARNING: Synthetic assigned webhook skipped (invalid repo format: ${input.repo}).`);
    return false;
  }

  const issueRaw = gh(["api", `repos/${input.repo}/issues/${input.issueNumber}`]);
  const issue = JSON.parse(issueRaw) as {
    number: number;
    title?: string;
    html_url?: string;
    body?: string;
    assignee?: unknown;
    assignees?: unknown[];
    pull_request?: unknown;
  };

  const payload = {
    action: "assigned",
    issue: {
      number: issue.number,
      title: issue.title ?? "",
      html_url: issue.html_url ?? "",
      body: issue.body ?? "",
      assignee: issue.assignee ?? null,
      assignees: issue.assignees ?? [],
      pull_request: issue.pull_request,
    },
    assignee: {
      login: input.appLogin,
      type: "Bot",
    },
    repository: {
      name: repoName,
      owner: { login: owner },
    },
    sender: {
      login: input.senderLogin,
      type: "User",
    },
    installation: { id: null },
  };

  const rawBody = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", webhookSecret).update(rawBody).digest("hex")}`;
  const response = await fetch(hookTarget, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openclaw-token": hooksToken,
      "x-github-event": "issues",
      "x-github-delivery": randomUUID(),
      "x-hub-signature-256": signature,
    },
    body: rawBody,
  });
  const responseText = await response.text();
  if (!response.ok) {
    console.log(`  WARNING: Synthetic assigned webhook failed (${response.status}): ${responseText.slice(0, 240)}`);
    return false;
  }
  console.log(`  Synthetic assigned webhook delivered to ${hookTarget}`);
  return true;
}

type AssignmentAttempt = {
  mode: "direct" | "failed";
  loginUsed: string | null;
  attemptedLogins: string[];
  notes: string[];
};

function getIssueAssigneeLogins(input: { repo: string; issueNumber: number; authToken?: string }): string[] {
  const raw = gh(["api", `repos/${input.repo}/issues/${input.issueNumber}`], input.authToken);
  const issue = JSON.parse(raw) as {
    assignee?: { login?: string } | null;
    assignees?: Array<{ login?: string }>;
  };
  const fromList = (issue.assignees || [])
    .map((entry) => (entry.login || "").trim())
    .filter(Boolean);
  const fromSingle = issue.assignee?.login?.trim();
  const merged = fromSingle ? [...fromList, fromSingle] : fromList;
  return Array.from(new Set(merged.map((login) => login.toLowerCase())));
}

async function triggerAssignmentSingle(input: {
  repo: string;
  issueNumber: number;
  assignmentLogin: string;
  authToken?: string;
}): Promise<AssignmentAttempt> {
  const notes: string[] = [];
  const attemptedLogins = [input.assignmentLogin];
  try {
    const raw = gh([
      "api",
      "-X", "POST",
      `repos/${input.repo}/issues/${input.issueNumber}/assignees`,
      "-f", `assignees[]=${input.assignmentLogin}`,
    ], input.authToken);
    const response = JSON.parse(raw) as {
      assignees?: Array<{ login?: string }>;
    };
    const assigned = (response.assignees || []).some(
      (assignee) => (assignee.login || "").toLowerCase() === input.assignmentLogin.toLowerCase(),
    );
    if (assigned) {
      const assigneeLogins = getIssueAssigneeLogins({
        repo: input.repo,
        issueNumber: input.issueNumber,
        authToken: input.authToken,
      });
      const persisted = assigneeLogins.includes(input.assignmentLogin.toLowerCase());
      if (persisted) {
        notes.push(`Direct assignment succeeded for '${input.assignmentLogin}'.`);
        return { mode: "direct", loginUsed: input.assignmentLogin, attemptedLogins, notes };
      }
      notes.push(
        `Direct assignment response claimed success but issue assignees are [${assigneeLogins.join(", ") || "none"}].`,
      );
      return { mode: "failed", loginUsed: null, attemptedLogins, notes };
    }

    const assigneeLogins = getIssueAssigneeLogins({
      repo: input.repo,
      issueNumber: input.issueNumber,
      authToken: input.authToken,
    });
    if (assigneeLogins.includes(input.assignmentLogin.toLowerCase())) {
      notes.push(`Direct assignment verified via issue assignees for '${input.assignmentLogin}'.`);
      return { mode: "direct", loginUsed: input.assignmentLogin, attemptedLogins, notes };
    }
    notes.push(
      `Direct assignment API call returned without target login '${input.assignmentLogin}' in assignees array (current assignees: [${assigneeLogins.join(", ") || "none"}]).`,
    );
    return { mode: "failed", loginUsed: null, attemptedLogins, notes };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notes.push(`Direct assignment call failed for '${input.assignmentLogin}': ${message}`);
    return { mode: "failed", loginUsed: null, attemptedLogins, notes };
  }
}

async function triggerAssignment(input: {
  repo: string;
  issueNumber: number;
  candidateLogins: string[];
  authToken?: string;
}): Promise<AssignmentAttempt> {
  const candidates = Array.from(
    new Set(
      input.candidateLogins
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
  if (candidates.length === 0) {
    return {
      mode: "failed",
      loginUsed: null,
      attemptedLogins: [],
      notes: ["No assignment candidates configured."],
    };
  }

  const aggregateNotes: string[] = [];
  for (const candidate of candidates) {
    const attempt = await triggerAssignmentSingle({
      repo: input.repo,
      issueNumber: input.issueNumber,
      assignmentLogin: candidate,
      authToken: input.authToken,
    });
    aggregateNotes.push(...attempt.notes);
    if (attempt.mode === "direct") {
      return {
        mode: "direct",
        loginUsed: attempt.loginUsed,
        attemptedLogins: candidates,
        notes: [
          `Assignment candidates tried: ${candidates.join(", ")}`,
          ...aggregateNotes,
        ],
      };
    }
  }
  return {
    mode: "failed",
    loginUsed: null,
    attemptedLogins: candidates,
    notes: [
      `Assignment candidates tried: ${candidates.join(", ")}`,
      ...aggregateNotes,
    ],
  };
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

type EvalResult = {
  caseId: string;
  title: string;
  trigger: "mention" | "assignment";
  completionMode: "started" | "terminal";
  triggerMode: string;
  triggerNotes: string[];
  agentStarted: boolean;
  agentCompleted: boolean;
  assignmentTriggerCheck: "pass" | "fail" | "n/a";
  task: string;
  triggerMessage: string;
  judgeCriteria: string;
  issueUrl: string;
  issueNumber: number;
  botResponse: string;
  fileChanges: string | null;
  timedOut: boolean;
};

function normalizeAzureBaseUrl(raw: string | undefined): string {
  if (!raw) return "https://vibebrowser-dev.openai.azure.com";
  try {
    return new URL(raw).origin;
  } catch {
    return raw.replace(/\/openai\/.*$/i, "").replace(/\/$/, "");
  }
}

function buildMentionMessage(appHandle: string, task: string, marker: string): string {
  return [
    `${appHandle} ${task}`,
    "",
    `Eval marker: ${marker}`,
  ].join("\n");
}

function buildAssignmentFollowupMessage(marker: string): string {
  return [
    "Assignment trigger follow-up (no mention).",
    `Marker: ${marker}`,
    "Please proceed with this assigned issue.",
  ].join("\n");
}

function isTerminalBotComment(body: string): boolean {
  const firstLine = body.split("\n")[0]?.trim().toLowerCase() ?? "";
  if (/^codex run\s+\S+\s+complete$/.test(firstLine)) return true;
  const statusMatch = body.match(/^\s*status:\s*([a-z-]+)/im);
  if (!statusMatch) return false;
  const status = statusMatch[1].toLowerCase();
  return status === "completed" || status === "failed" || status === "succeeded";
}

function isProgressOnlyBotComment(body: string): boolean {
  return /in progress|started and acknowledged|will post .*progress|as work progresses|taking ownership/i.test(body);
}

function isCompletionSignal(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed) return false;
  if (isTerminalBotComment(body)) return true;
  if (isProgressOnlyBotComment(body)) return false;
  const completionPatterns = [
    /\b(created|implemented|added|completed|done)\b/i,
    /\b(successfully|finished|resolved|answered)\b/i,
    /\b(task|request|issue)\s+(completed|done|resolved)\b/i,
    /\b(gpt-1|june\s+2018)\b/i,
    /```[\s\S]+```/m,
  ];
  return completionPatterns.some((pattern) => pattern.test(trimmed));
}

function parsePromptfooCounts(payload: any): { passed: number; failed: number; errors: number } {
  const stats = payload?.results?.stats ?? payload?.stats;
  if (!stats) return { passed: 0, failed: 1, errors: 1 };
  return {
    passed: Number(stats.successes ?? stats.passed ?? 0),
    failed: Number(stats.failures ?? stats.failed ?? 0),
    errors: Number(stats.errors ?? 0),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  ensureOpenClawGithubTokenForRepo(args.repo);
  const openclawStateEnv = loadOpenClawStateEnv();
  const assignmentAuth = resolveOwnerScopedAppToken(args.repo, openclawStateEnv);
  const assignmentAuthToken = assignmentAuth.token;
  const assignmentAuthMode = assignmentAuthToken
    ? `${assignmentAuth.source} (${tokenFingerprint(assignmentAuthToken)})`
    : "default gh auth token";
  const mentionInitialWaitSec = Math.max(
    5,
    Math.min(
      args.timeoutSec,
      Number(process.env.EVAL_MENTION_INITIAL_WAIT_SEC || 20),
    ),
  );
  const mentionFallbackWaitSec = Math.max(
    10,
    Number(process.env.EVAL_MENTION_FALLBACK_WAIT_SEC || (args.timeoutSec - mentionInitialWaitSec)),
  );
  const assignmentFollowupWaitSec = Math.max(
    20,
    Math.min(
      Number(process.env.EVAL_ASSIGNMENT_FOLLOWUP_WAIT_SEC || 90),
      args.timeoutSec,
    ),
  );
  const now = Date.now();
  const appIdentity = buildAppIdentityLogins(args.appHandle);
  const appLogin = appIdentity.appLogin;
  const appSelfLogins = appIdentity.selfLogins;
  const explicitAssignmentLogin = args.assignmentLogin?.replace(/^@/, "").toLowerCase();
  const configuredAssignmentLogins = parseLoginList(
    process.env.OPENCLAW_GITHUB_ASSIGNMENT_LOGINS ||
    process.env.GITHUB_ASSIGNMENT_LOGINS ||
    openclawStateEnv.OPENCLAW_GITHUB_ASSIGNMENT_LOGINS ||
    openclawStateEnv.GITHUB_ASSIGNMENT_LOGINS,
  );
  const requestedAssignmentCandidates = Array.from(
    new Set(
      [
        explicitAssignmentLogin,
        ...appSelfLogins,
        ...configuredAssignmentLogins,
      ].filter((entry): entry is string => Boolean(entry && entry.trim())),
    ),
  );
  const assignmentCandidates = requestedAssignmentCandidates;
  const assignmentAppCandidates = assignmentCandidates.filter((entry) => appSelfLogins.includes(entry));
  const assignmentAliasCandidates = assignmentCandidates.filter((entry) => !appSelfLogins.includes(entry));
  const botLogin = `${appLogin}[bot]`;
  if (!process.env.AZURE_OPENAI_API_KEY) {
    throw new Error("AZURE_OPENAI_API_KEY is required for llm-rubric grading.");
  }
  const azureApiBaseUrl = normalizeAzureBaseUrl(process.env.AZURE_OPENAI_BASE_URL);
  const azureApiHost = new URL(azureApiBaseUrl).host;

  console.log(`\n=== OpenClaw Eval: Agent Task Quality ===`);
  console.log(`Repo: ${args.repo}`);
  console.log(`Bot: ${botLogin}`);
  console.log(`Azure API base: ${azureApiBaseUrl}`);
  console.log(`Timeout: ${args.timeoutSec}s per task`);
  console.log(`Mention initial wait: ${mentionInitialWaitSec}s, fallback wait: ${mentionFallbackWaitSec}s`);
  console.log(`App assignment identities: ${appSelfLogins.join(", ")}`);
  console.log(`Assignment candidates: ${assignmentCandidates.join(", ")}`);
  console.log(`Assignment app candidates: ${assignmentAppCandidates.join(", ") || "(none)"}`);
  console.log(`Assignment alias candidates: ${assignmentAliasCandidates.join(", ") || "(none)"}`);
  console.log(`Assignment trigger auth: ${assignmentAuthMode}`);
  console.log(`Synthetic webhook fallback: enabled`);
  console.log(`Cases: ${EVAL_CASES.length}\n`);

  // ── Phase 1: Create issues and trigger eval actions ───────────────
  console.log("--- Phase 1: Creating issues and triggering eval actions ---\n");
  const issueMap = new Map<
    string,
    {
      url: string;
      number: number;
      trigger: "mention" | "assignment";
      completionMode: "started" | "terminal";
      mentionMessage?: string;
      mentionComment?: IssueComment;
      assignmentMode?: AssignmentAttempt["mode"];
      assignmentNotes: string[];
    }
  >();

  for (const evalCase of EVAL_CASES) {
    const title = `[eval] ${evalCase.title} (${now})`;
    const issueBody = evalCase.trigger === "assignment"
      ? `Automated eval case: ${evalCase.id}\n\nTask:\n${evalCase.task}`
      : `Automated eval case: ${evalCase.id}\n\nTask:\n${evalCase.task}`;
    const created = createIssue({
      repo: args.repo,
      title,
      body: issueBody,
    });
    const url = created.url;
    const issueNumber = created.number;
    console.log(`  Created ${evalCase.id} → ${url}`);

    if (evalCase.trigger === "mention") {
      const mentionMarker = `mention-${now}-${issueNumber}-${evalCase.id}`;
      const mentionComment = await createIssueComment({
        repo: args.repo,
        issueNumber,
        body: buildMentionMessage(args.appHandle, evalCase.task, mentionMarker),
      });
      issueMap.set(evalCase.id, {
        url,
        number: issueNumber,
        trigger: evalCase.trigger,
        completionMode: evalCase.completionMode,
        mentionMessage: mentionComment.body,
        mentionComment,
        assignmentNotes: [],
      });
      console.log(`  Posted mention on #${issueNumber} (${mentionComment.html_url})`);
      continue;
    }

    const assignment = await triggerAssignment({
      repo: args.repo,
      issueNumber,
      candidateLogins: assignmentCandidates,
      authToken: assignmentAuthToken,
    });
    issueMap.set(evalCase.id, {
      url,
      number: issueNumber,
      trigger: evalCase.trigger,
      completionMode: evalCase.completionMode,
      assignmentMode: assignment.mode,
      assignmentNotes: assignment.notes,
    });
    console.log(`  Triggered direct assignment on #${issueNumber} using mode=${assignment.mode}`);
    for (const note of assignment.notes) {
      console.log(`    note: ${note}`);
    }
    if (assignment.mode === "failed") {
      console.log("    note: strict eval policy keeps this case as FAIL (no synthetic assignment fallback).");
    }
  }

  // ── Phase 2: Wait for bot replies ─────────────────────────────────
  console.log("\n--- Phase 2: Waiting for bot replies ---\n");
  const results: EvalResult[] = [];

  for (const evalCase of EVAL_CASES) {
    const issue = issueMap.get(evalCase.id)!;
    console.log(`  Waiting for reply on #${issue.number} (${evalCase.id}, trigger=${issue.trigger})...`);
    const firstWaitSec = issue.trigger === "mention"
      ? mentionInitialWaitSec
      : ((issue.assignmentMode === "failed") ? Math.min(30, args.timeoutSec) : args.timeoutSec);

    let reply = await waitForBotReply({
      repo: args.repo,
      issueNumber: issue.number,
      botLogin,
      completionMode: evalCase.completionMode,
      timeoutSec: firstWaitSec,
      pollSec: args.pollSec,
    });

    let timedOut = evalCase.completionMode === "started"
      ? reply.comments.length === 0
      : !reply.comments.some((comment) => isCompletionSignal(comment.body ?? ""));
    if (!timedOut) {
      console.log(`  Got ${reply.comments.length} comment(s) on #${issue.number}`);
    } else {
      if (issue.trigger === "mention") {
        if (!issue.mentionComment) {
          throw new Error(`Internal error: mention trigger case missing mentionComment for issue #${issue.number}`);
        }
        const syntheticOk = await emitSyntheticIssueCommentWebhook({
          repo: args.repo,
          issueNumber: issue.number,
          comment: issue.mentionComment,
        });
        console.log(`  TIMEOUT on #${issue.number} (attempting synthetic issue_comment fallback)`);
        if (syntheticOk) {
          const secondWaitSec = mentionFallbackWaitSec;
          reply = await waitForBotReply({
            repo: args.repo,
            issueNumber: issue.number,
            botLogin,
            completionMode: evalCase.completionMode,
            timeoutSec: secondWaitSec,
            pollSec: args.pollSec,
          });
          timedOut = evalCase.completionMode === "started"
            ? reply.comments.length === 0
            : !reply.comments.some((comment) => isCompletionSignal(comment.body ?? ""));
        }
        if (timedOut) {
          console.log(`  Still timed out on #${issue.number}`);
        } else {
          console.log(`  Got ${reply.comments.length} comment(s) on #${issue.number} after synthetic fallback`);
        }
      } else {
        if (issue.assignmentMode === "direct") {
          const marker = `assignment-followup-${now}-${issue.number}`;
          const followupComment = await createIssueComment({
            repo: args.repo,
            issueNumber: issue.number,
            body: buildAssignmentFollowupMessage(marker),
          });
          issue.assignmentNotes.push(
            `Posted non-mention assignment follow-up comment: ${followupComment.html_url}`,
          );
          console.log(
            `  TIMEOUT on #${issue.number} (posting non-mention assignment follow-up comment)`,
          );

          reply = await waitForBotReply({
            repo: args.repo,
            issueNumber: issue.number,
            botLogin,
            completionMode: evalCase.completionMode,
            timeoutSec: assignmentFollowupWaitSec,
            pollSec: args.pollSec,
          });
          timedOut = evalCase.completionMode === "started"
            ? reply.comments.length === 0
            : !reply.comments.some((comment) => isCompletionSignal(comment.body ?? ""));

          if (timedOut) {
            const syntheticOk = await emitSyntheticIssueCommentWebhook({
              repo: args.repo,
              issueNumber: issue.number,
              comment: followupComment,
            });
            issue.assignmentNotes.push(
              syntheticOk
                ? "Synthetic issue_comment fallback delivered after assignment follow-up."
                : "Synthetic issue_comment fallback failed after assignment follow-up.",
            );
            console.log(
              `  Still timed out on #${issue.number} (attempting synthetic issue_comment fallback for assignment follow-up)`,
            );
            if (syntheticOk) {
              reply = await waitForBotReply({
                repo: args.repo,
                issueNumber: issue.number,
                botLogin,
                completionMode: evalCase.completionMode,
                timeoutSec: assignmentFollowupWaitSec,
                pollSec: args.pollSec,
              });
              timedOut = evalCase.completionMode === "started"
                ? reply.comments.length === 0
                : !reply.comments.some((comment) => isCompletionSignal(comment.body ?? ""));
            }
          }

          if (timedOut) {
            issue.assignmentNotes.push("Assignment follow-up path timed out.");
            console.log(`  TIMEOUT on #${issue.number} after assignment follow-up path`);
          } else {
            console.log(`  Got ${reply.comments.length} comment(s) on #${issue.number} after assignment follow-up path`);
          }
        } else {
          issue.assignmentNotes.push("Primary reply poll timed out and assignment trigger was not established.");
          console.log(`  TIMEOUT on #${issue.number} (assignment trigger was not established)`);
        }
      }
    }

    const fileChanges = getIssueFileChanges(args.repo, issue.number);
    if (fileChanges) {
      console.log(`  Found PR diff for #${issue.number}`);
    }
    const agentStarted = reply.comments.length > 0;
    const agentCompleted = reply.comments.some((comment) => isCompletionSignal(comment.body ?? ""));
    let assignmentTriggerCheck: EvalResult["assignmentTriggerCheck"] = "n/a";
    if (evalCase.trigger === "assignment") {
      const assigneeLogins = getIssueAssigneeLogins({
        repo: args.repo,
        issueNumber: issue.number,
        authToken: assignmentAuthToken,
      });
      const hasExpectedAssignee = assigneeLogins.some((login) => assignmentCandidates.includes(login));
      if (!hasExpectedAssignee) {
        issue.assignmentNotes.push(
          `Assignment verification failed: assignees [${assigneeLogins.join(", ") || "none"}] do not include configured assignment identities [${assignmentCandidates.join(", ")}].`,
        );
      }
      assignmentTriggerCheck = issue.assignmentMode === "direct" && agentStarted && hasExpectedAssignee
        ? "pass"
        : "fail";
    }

    results.push({
      caseId: evalCase.id,
      title: evalCase.title,
      trigger: evalCase.trigger,
      completionMode: evalCase.completionMode,
      triggerMode: issue.trigger === "assignment" ? (issue.assignmentMode ?? "failed") : "mention-comment",
      triggerNotes: issue.assignmentNotes,
      agentStarted,
      agentCompleted,
      assignmentTriggerCheck,
      task: evalCase.task,
      triggerMessage: issue.mentionMessage ?? "(direct assignment)",
      judgeCriteria: evalCase.judgeCriteria,
      issueUrl: issue.url,
      issueNumber: issue.number,
      botResponse: reply.combinedBody,
      fileChanges,
      timedOut,
    });
  }

  // ── Phase 3: Write promptfoo test vars and run eval ───────────────
  console.log("\n--- Phase 3: Running promptfoo evaluation ---\n");

  const reportsDir = path.join(process.cwd(), "reports");
  mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  // Write test cases as promptfoo vars YAML
  const testCases = results.map((r) => ({
    vars: {
      task_title: r.title,
      completion_mode: r.completionMode,
      trigger_type: r.trigger,
      trigger_mode: r.triggerMode,
      trigger_notes: r.triggerNotes.length > 0 ? r.triggerNotes.join(" | ") : "(none)",
      agent_started: r.agentStarted ? "yes" : "no",
      agent_completed: r.agentCompleted ? "yes" : "no",
      assignment_trigger_check: r.assignmentTriggerCheck,
      task_instruction: r.task,
      trigger_message: r.triggerMessage,
      bot_response: r.botResponse,
      file_changes: r.fileChanges || "(no file changes / no PR created)",
      issue_url: r.issueUrl,
      timed_out: r.timedOut ? "yes" : "no",
    },
    assert: [
      {
        type: "llm-rubric" as const,
        value: r.judgeCriteria,
      },
      ...(r.trigger === "assignment"
        ? [
            {
              type: "icontains" as const,
              value: "Assignment trigger check: pass",
            },
            {
              type: "icontains" as const,
              value: "Agent started: yes",
            },
          ]
        : [
            {
              type: "icontains" as const,
              value: "Agent completed: yes",
            },
          ]),
    ],
  }));

  // Write dynamic promptfoo config with collected results
  const promptfooConfig = {
    description: `OpenClaw Agent Eval – ${new Date().toISOString()}`,
    prompts: [
      [
        "## Task",
        "Title: {{task_title}}",
        "Completion mode: {{completion_mode}}",
        "Trigger type: {{trigger_type}}",
        "Trigger mode: {{trigger_mode}}",
        "Assignment trigger check: {{assignment_trigger_check}}",
        "Agent started: {{agent_started}}",
        "Agent completed: {{agent_completed}}",
        "Task instruction: {{task_instruction}}",
        "Trigger message: {{trigger_message}}",
        "Trigger notes: {{trigger_notes}}",
        "",
        "## Bot Response",
        "{{bot_response}}",
        "",
        "## File Changes (PR diff)",
        "{{file_changes}}",
        "",
        "## Issue URL",
        "{{issue_url}}",
        "",
        "## Timed Out",
        "{{timed_out}}",
      ].join("\n"),
    ],
    providers: ["echo"],
    tests: testCases,
    defaultTest: {
      options: {
        provider: {
          id: "azure:chat:gpt-4.1",
          config: {
            apiBaseUrl: azureApiBaseUrl,
            apiHost: azureApiHost,
            apiVersion: "2024-10-01-preview",
          },
        },
      },
    },
  };

  // Write as JSON (promptfoo accepts JSON config too)
  const configJsonPath = path.join(reportsDir, `eval-config-${stamp}.json`);
  writeFileSync(configJsonPath, JSON.stringify(promptfooConfig, null, 2));
  console.log(`  Wrote promptfoo config → ${configJsonPath}`);

  // Also save raw results for posterity
  const rawResultsPath = path.join(reportsDir, `eval-raw-${stamp}.json`);
  writeFileSync(
    rawResultsPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        repo: args.repo,
        bot: botLogin,
        timeoutSec: args.timeoutSec,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`  Wrote raw results → ${rawResultsPath}`);

  // Run promptfoo eval
  const outputPath = path.join(reportsDir, `eval-output-${stamp}.json`);
  const localPromptfoo = path.join(process.cwd(), "node_modules", ".bin", "promptfoo");
  const hasLocalPromptfoo = existsSync(localPromptfoo);
  const promptfooCmd = hasLocalPromptfoo ? localPromptfoo : "npx";
  const promptfooArgs = hasLocalPromptfoo
    ? ["eval", "-c", configJsonPath, "-o", outputPath, "--no-cache"]
    : ["promptfoo@latest", "eval", "-c", configJsonPath, "-o", outputPath, "--no-cache"];
  console.log(`  Running: ${promptfooCmd} ${promptfooArgs.join(" ")}\n`);
  const promptfooConfigDir = path.join(reportsDir, ".promptfoo-runtime");
  mkdirSync(promptfooConfigDir, { recursive: true });
  const promptfooCachePath = path.join(promptfooConfigDir, "cache");
  mkdirSync(promptfooCachePath, { recursive: true });

  const promptfooResult = spawnSync(promptfooCmd, promptfooArgs, {
    stdio: "inherit",
    env: {
      ...process.env,
      GITHUB_TOKEN: "",
      GH_TOKEN: "",
      PROMPTFOO_CONFIG_DIR: promptfooConfigDir,
      PROMPTFOO_CACHE_PATH: promptfooCachePath,
      PROMPTFOO_DISABLE_WAL_MODE: "true",
    },
    cwd: process.cwd(),
    encoding: "utf-8",
  });
  if (promptfooResult.error) {
    console.error(`\n  promptfoo invocation failed: ${promptfooResult.error.message}`);
  } else if ((promptfooResult.status ?? 1) !== 0) {
    console.log(`\n  promptfoo exited with code ${promptfooResult.status} (results captured in output file).`);
  } else {
    console.log(`\n  Eval output → ${outputPath}`);
  }
  const promptfooPayload = existsSync(outputPath) ? JSON.parse(readFileSync(outputPath, "utf8")) : {};
  const promptfooCounts = parsePromptfooCounts(promptfooPayload);
  console.log(`Promptfoo summary: ${promptfooCounts.passed} passed, ${promptfooCounts.failed} failed, ${promptfooCounts.errors} errors`);

  // ── Cleanup ───────────────────────────────────────────────────────
  if (!args.keepArtifacts) {
    console.log("\nClosing eval issues...");
    for (const evalCase of EVAL_CASES) {
      const issue = issueMap.get(evalCase.id);
      if (issue) {
        try {
          gh(["issue", "close", String(issue.number), "--repo", args.repo]);
          console.log(`  Closed #${issue.number}`);
        } catch { /* ignore */ }
      }
    }
  }

  // ── Summary ───────────────────────────────────────────────────────
  console.log("\n========================================");
  console.log("         EVAL RESULTS SUMMARY");
  console.log("========================================\n");

  for (const r of results) {
    const status = r.timedOut ? "TIMEOUT" : "COLLECTED";
    console.log(`[${status}] ${r.caseId}`);
    console.log(`  Trigger:   ${r.trigger} (${r.triggerMode})`);
    console.log(`  Progress:  started=${r.agentStarted ? "yes" : "no"} completed=${r.agentCompleted ? "yes" : "no"} (assignment-check=${r.assignmentTriggerCheck})`);
    console.log(`  Issue:    ${r.issueUrl}`);
    console.log(`  Response: ${r.botResponse.slice(0, 120).replace(/\n/g, " ")}...`);
    console.log();
  }

  console.log(`promptfoo config: ${configJsonPath}`);
  console.log(`promptfoo output: ${outputPath}`);
  console.log(`Raw results:      ${rawResultsPath}`);
  console.log(`\nRun 'npx promptfoo view' to see results in browser.\n`);

  const hasPromptfooInvocationError = Boolean(promptfooResult.error) || (promptfooResult.status ?? 1) !== 0;
  if (hasPromptfooInvocationError || promptfooCounts.failed > 0 || promptfooCounts.errors > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
