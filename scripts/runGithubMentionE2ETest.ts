#!/usr/bin/env bun
import { createHmac, createSign } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

type TestStatus = "PASS" | "FAIL" | "BLOCKED";

type TestResult = {
  name: string;
  status: TestStatus;
  marker?: string;
  triggerUrl?: string;
  triggerId?: string;
  botReplyUrl?: string;
  botReplyId?: string;
  ingressDetected: boolean;
  ingressSessionKeys: string[];
  notes: string[];
};

type InstallationSummary = {
  appSlug: string;
  appName: string;
  appId: number;
  installations: Array<{
    id: number;
    account: string;
    type: string;
    repositorySelection: string;
  }>;
  orgInstalled: boolean;
  org: string;
};

type RunReport = {
  startedAt: string;
  finishedAt: string;
  appLogin: string;
  botLogins: string[];
  org: string;
  codebridgeRepo: string;
  installation: InstallationSummary;
  bridgeWebhookUrl: string | null;
  tests: TestResult[];
};

type GitHubDiscussionComment = {
  id: string;
  url: string;
  body: string;
  createdAt: string;
  author: {
    login: string;
  } | null;
};

const OPENCLAW_ENV_PATH = path.join(homedir(), ".openclaw", ".env");
const GITHUB_ENV_PATH = path.join(homedir(), ".env.d", "github.env");
const OPENCLAW_SESSIONS_DIR = path.join(homedir(), ".openclaw", "agents", "main", "sessions");
const BRIDGE_CONFIG_PATH = "/tmp/clawengineer-webhook-config.json";
const HOOK_ENDPOINT = process.env.OPENCLAW_HOOK_TARGET?.trim() || "http://127.0.0.1:18789/hooks/github";

const ORG = process.env.TEST_ORG?.trim() || "VibeTechnologies";
const CODEBRIDGE_REPO = process.env.TEST_CODEBRIDGE_REPO?.trim() || `${ORG}/codebridge-test`;
const CODEBRIDGE_ISSUE = Number(process.env.TEST_CODEBRIDGE_ISSUE || "1");

const ISSUE_REPO = process.env.TEST_ISSUE_REPO?.trim() || CODEBRIDGE_REPO;
const ISSUE_NUMBER = Number(process.env.TEST_ISSUE_NUMBER || String(CODEBRIDGE_ISSUE));
const PR_REPO = process.env.TEST_PR_REPO?.trim() || CODEBRIDGE_REPO;
const PR_NUMBER = Number(process.env.TEST_PR_NUMBER || "0");
const DISCUSSION_REPO = process.env.TEST_DISCUSSION_REPO?.trim() || CODEBRIDGE_REPO;
const DISCUSSION_NUMBER = Number(process.env.TEST_DISCUSSION_NUMBER || "0");

const POLL_SECONDS = Number(process.env.TEST_POLL_SECONDS || "150");
const POLL_INTERVAL_MS = 5000;

function hasBinary(name: string): boolean {
  const probe = Bun.spawnSync(["/usr/bin/env", "bash", "-lc", `command -v ${name}`]);
  return probe.exitCode === 0;
}

function parseEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const out: Record<string, string> = {};
  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
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

function requireEnvValue(
  key: string,
  ...candidates: Array<string | undefined>
): string {
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value) return value;
  }
  throw new Error(`Missing required environment value: ${key}`);
}

async function rest<T>(
  token: string,
  method: string,
  endpoint: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "codeclaw-e2e-runner",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as unknown) : {};
  if (!response.ok) {
    const message =
      typeof parsed === "object" && parsed && "message" in parsed
        ? String((parsed as { message?: unknown }).message)
        : text;
    throw new Error(`${method} ${endpoint} failed: HTTP ${response.status} ${message}`);
  }
  return parsed as T;
}

function signWebhook(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function graphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "codeclaw-e2e-runner",
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = (await response.json()) as {
    data?: T;
    errors?: Array<{ message?: string }>;
  };
  if (!response.ok || payload.errors?.length) {
    const reasons = payload.errors?.map((entry) => entry.message || "unknown").join("; ");
    throw new Error(`GraphQL request failed: HTTP ${response.status} ${reasons || "unknown error"}`);
  }
  if (!payload.data) throw new Error("GraphQL response missing data");
  return payload.data;
}

function makeMarker(prefix: string): string {
  return `${prefix}-${Date.now()}`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRepo(full: string): { owner: string; repo: string } {
  const [owner, repo] = full.split("/");
  if (!owner || !repo) throw new Error(`Invalid repo format: ${full}`);
  return { owner, repo };
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function findMarkerIngress(marker: string): { detected: boolean; keys: string[]; lines: string[] } {
  const lines = hasBinary("rg")
    ? findMarkerIngressWithRipgrep(marker)
    : findMarkerIngressWithNativeScan(marker);
  if (!lines.length) return { detected: false, keys: [], lines: [] };

  const keyRegex = /hook:github:[a-z0-9_.-]+\/[a-z0-9_.-]+:(?:issue|pr|discussion):\d+/gi;
  const payloadRegex =
    /\\"repository\\":\s*\\"([a-z0-9_.-]+\/[a-z0-9_.-]+)\\"[\s\S]*?\\"kind\\":\s*\\"(issue|pr|discussion)\\"[\s\S]*?\\"threadId\\":\s*\\"(\d+)\\"/i;
  const keys = new Set<string>();
  for (const line of lines) {
    const matches = line.match(keyRegex) || [];
    for (const match of matches) keys.add(match.toLowerCase());
    const payload = line.match(payloadRegex);
    if (payload) {
      keys.add(`hook:github:${payload[1].toLowerCase()}:${payload[2].toLowerCase()}:${payload[3]}`);
    }
  }
  return { detected: true, keys: [...keys], lines };
}

async function waitForMarkerIngress(
  marker: string,
  timeoutSeconds = 45,
): Promise<{ detected: boolean; keys: string[]; lines: string[] }> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let latest = findMarkerIngress(marker);
  while (!latest.detected && Date.now() < deadline) {
    await sleep(2500);
    latest = findMarkerIngress(marker);
  }
  return latest;
}

function findMarkerIngressWithRipgrep(marker: string): string[] {
  const proc = Bun.spawnSync([
    "rg",
    "-n",
    "--no-heading",
    "--hidden",
    "--glob",
    "*.jsonl",
    marker,
    OPENCLAW_SESSIONS_DIR,
  ]);
  const stdout = proc.stdout.toString();
  if (proc.exitCode !== 0 || !stdout.trim()) return [];
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function findMarkerIngressWithNativeScan(marker: string): string[] {
  const out: string[] = [];
  if (!existsSync(OPENCLAW_SESSIONS_DIR)) return out;

  const stack = [OPENCLAW_SESSIONS_DIR];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of readdirSync(current)) {
      const fullPath = path.join(current, entry);
      const stats = statSync(fullPath);
      if (stats.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.endsWith(".jsonl")) continue;
      const content = readFileSync(fullPath, "utf8");
      const rows = content.split(/\r?\n/);
      for (let i = 0; i < rows.length; i += 1) {
        if (!rows[i].includes(marker)) continue;
        out.push(`${fullPath}:${i + 1}:${rows[i]}`);
      }
    }
  }
  return out;
}

function isBotLogin(login: string, botLogins: string[]): boolean {
  return botLogins.includes(login.toLowerCase());
}

async function pollIssueBotReply(input: {
  token: string;
  repoFull: string;
  issueNumber: number;
  botLogins: string[];
  triggerIso: string;
}): Promise<{ url: string; id: string } | null> {
  const { owner, repo } = parseRepo(input.repoFull);
  const start = Date.now();
  while (Date.now() - start < POLL_SECONDS * 1000) {
    const comments = await rest<Array<{
      id: number;
      html_url: string;
      created_at: string;
      user: { login: string };
    }>>(input.token, "GET", `/repos/${owner}/${repo}/issues/${input.issueNumber}/comments?per_page=100`);
    const match = comments.find((comment) => {
      const created = Date.parse(comment.created_at);
      const trigger = Date.parse(input.triggerIso);
      return created > trigger && isBotLogin(comment.user.login, input.botLogins);
    });
    if (match) {
      return { url: match.html_url, id: String(match.id) };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}

async function pollPrBotReview(input: {
  token: string;
  repoFull: string;
  prNumber: number;
  botLogins: string[];
  triggerIso: string;
}): Promise<{ url: string; id: string } | null> {
  const { owner, repo } = parseRepo(input.repoFull);
  const start = Date.now();
  while (Date.now() - start < POLL_SECONDS * 1000) {
    const reviews = await rest<Array<{
      id: number;
      html_url: string;
      submitted_at: string | null;
      user: { login: string };
    }>>(input.token, "GET", `/repos/${owner}/${repo}/pulls/${input.prNumber}/reviews?per_page=100`);

    const match = reviews.find((review) => {
      const created = Date.parse(review.submitted_at || "");
      const trigger = Date.parse(input.triggerIso);
      return Number.isFinite(created) && created > trigger && isBotLogin(review.user.login, input.botLogins);
    });
    if (match) return { url: match.html_url, id: String(match.id) };

    const issueComments = await rest<Array<{
      id: number;
      html_url: string;
      created_at: string;
      user: { login: string };
    }>>(input.token, "GET", `/repos/${owner}/${repo}/issues/${input.prNumber}/comments?per_page=100`);
    const issueMatch = issueComments.find((comment) => {
      const created = Date.parse(comment.created_at);
      const trigger = Date.parse(input.triggerIso);
      return created > trigger && isBotLogin(comment.user.login, input.botLogins);
    });
    if (issueMatch) return { url: issueMatch.html_url, id: String(issueMatch.id) };
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}

async function pollDiscussionBotReply(input: {
  token: string;
  repoFull: string;
  discussionNumber: number;
  botLogins: string[];
  triggerIso: string;
}): Promise<{ url: string; id: string } | null> {
  const { owner, repo } = parseRepo(input.repoFull);
  const query = `
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        discussion(number: $number) {
          comments(first: 100) {
            nodes {
              id
              url
              createdAt
              body
              author { login }
            }
          }
        }
      }
    }
  `;

  const start = Date.now();
  while (Date.now() - start < POLL_SECONDS * 1000) {
    const data = await graphql<{
      repository: {
        discussion: {
          comments: {
            nodes: GitHubDiscussionComment[];
          };
        } | null;
      } | null;
    }>(input.token, query, { owner, name: repo, number: input.discussionNumber });

    const comments = data.repository?.discussion?.comments.nodes || [];
    const match = comments.find((comment) => {
      const created = Date.parse(comment.createdAt);
      const trigger = Date.parse(input.triggerIso);
      const login = comment.author?.login?.toLowerCase() || "";
      return created > trigger && isBotLogin(login, input.botLogins);
    });
    if (match) return { url: match.url, id: match.id };
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}

function createGitHubAppJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: appId,
    }),
  ).toString("base64url");
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(privateKeyPem).toString("base64url");
  return `${unsigned}.${signature}`;
}

async function loadInstallationSummary(openclawEnv: Record<string, string>): Promise<InstallationSummary> {
  const appId = requireEnvValue("GITHUB_APP_ID", process.env.GITHUB_APP_ID, openclawEnv.GITHUB_APP_ID);
  const privateKeyPath = requireEnvValue(
    "GITHUB_APP_PRIVATE_KEY_PATH",
    process.env.GITHUB_APP_PRIVATE_KEY_PATH,
    openclawEnv.GITHUB_APP_PRIVATE_KEY_PATH,
  );
  const privateKeyPem = readFileSync(privateKeyPath, "utf8");
  const jwt = createGitHubAppJwt(appId, privateKeyPem);

  const app = await rest<{
    id: number;
    slug: string;
    name: string;
  }>(jwt, "GET", "/app");

  const installs = await rest<
    Array<{
      id: number;
      repository_selection: string;
      account: { login: string; type: string };
    }>
  >(jwt, "GET", "/app/installations?per_page=100");

  const normalizedOrg = ORG.toLowerCase();
  const orgInstalled = installs.some((entry) => entry.account.login.toLowerCase() === normalizedOrg);

  return {
    appSlug: app.slug,
    appName: app.name,
    appId: app.id,
    installations: installs.map((entry) => ({
      id: entry.id,
      account: entry.account.login,
      type: entry.account.type,
      repositorySelection: entry.repository_selection,
    })),
    orgInstalled,
    org: ORG,
  };
}

function readBridgeWebhookUrl(): string | null {
  if (!existsSync(BRIDGE_CONFIG_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(BRIDGE_CONFIG_PATH, "utf8")) as {
      webhookUrl?: unknown;
      url?: unknown;
    };
    if (typeof parsed.webhookUrl === "string") return parsed.webhookUrl;
    if (typeof parsed.url === "string") return parsed.url;
    return null;
  } catch {
    return null;
  }
}

async function testIssueAssigned(input: {
  token: string;
  appLogin: string;
  botLogins: string[];
  issueRepoFull: string;
  issueNumber: number;
  webhookSecret: string;
  hooksToken: string;
  installationId: number;
  installedAccounts: string[];
}): Promise<TestResult> {
  const notes: string[] = [];
  const { owner, repo } = parseRepo(CODEBRIDGE_REPO);
  const syntheticTarget = parseRepo(input.issueRepoFull);
  const syntheticTargetInstalled = input.installedAccounts.includes(
    syntheticTarget.owner.toLowerCase(),
  );
  try {
    const assigneeCheck = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/assignees/${input.appLogin}`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${input.token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "codeclaw-e2e-runner",
        },
      },
    );
    if (assigneeCheck.status === 404) {
      const marker = makeMarker("e2e-assigned-synthetic");
      const issueUrl = `https://github.com/${syntheticTarget.owner}/${syntheticTarget.repo}/issues/${input.issueNumber}`;
      const syntheticPayload = {
        action: "assigned",
        repository: {
          name: syntheticTarget.repo,
          owner: {
            login: syntheticTarget.owner,
          },
        },
        issue: {
          number: input.issueNumber,
          title: `Synthetic assigned test ${marker}`,
          html_url: issueUrl,
          body: `${marker} synthetic issues.assigned event`,
        },
        assignee: {
          login: input.appLogin,
          type: "Bot",
        },
        sender: {
          login: "OpenCodeEngineer",
          type: "User",
        },
        installation: {
          id: input.installationId,
        },
      };
      const rawBody = JSON.stringify(syntheticPayload);
      const deliveryId = `synthetic-${Date.now()}`;
      const triggerIso = new Date().toISOString();
      const hookResponse = await fetch(HOOK_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openclaw-token": input.hooksToken,
          "x-github-event": "issues",
          "x-github-delivery": deliveryId,
          "x-hub-signature-256": signWebhook(input.webhookSecret, rawBody),
        },
        body: rawBody,
      });
      if (!hookResponse.ok) {
        const text = await hookResponse.text();
        return {
          name: "issue-assigned (org codebridge-test)",
          status: "FAIL",
          ingressDetected: false,
          ingressSessionKeys: [],
          notes: [
            `App handle is not assignable on ${CODEBRIDGE_REPO}. Synthetic fallback webhook failed: HTTP ${hookResponse.status} ${text}`,
          ],
        };
      }

      const ingressAfterPoll = await waitForMarkerIngress(marker, 20);
      let botReply: { url: string; id: string } | null = null;
      if (syntheticTargetInstalled) {
        botReply = await pollIssueBotReply({
          token: input.token,
          repoFull: input.issueRepoFull,
          issueNumber: input.issueNumber,
          botLogins: input.botLogins,
          triggerIso,
        });
      } else {
        notes.push(
          `Synthetic issues.assigned reply check skipped: app is not installed on ${input.issueRepoFull}.`,
        );
      }
      if (!ingressAfterPoll.detected) notes.push("Synthetic issues.assigned did not appear in OpenClaw logs.");
      if (syntheticTargetInstalled && !botReply) {
        notes.push("Synthetic issues.assigned produced no bot reply within poll timeout.");
      }
      notes.push(
        `Live assignment unsupported for app handle '${input.appLogin}' on ${CODEBRIDGE_REPO}; validated assignment flow via signed synthetic webhook.`,
      );
      let status: TestStatus = "FAIL";
      if (ingressAfterPoll.detected) {
        status = syntheticTargetInstalled ? (botReply ? "PASS" : "FAIL") : "BLOCKED";
      }
      return {
        name: "issue-assigned (org codebridge-test)",
        status,
        marker,
        triggerUrl: issueUrl,
        triggerId: String(input.issueNumber),
        botReplyUrl: botReply?.url,
        botReplyId: botReply?.id,
        ingressDetected: ingressAfterPoll.detected,
        ingressSessionKeys: ingressAfterPoll.keys,
        notes,
      };
    }

    const response = await rest<{
      html_url: string;
      number: number;
      assignees: Array<{ login: string }>;
    }>(input.token, "POST", `/repos/${owner}/${repo}/issues/${CODEBRIDGE_ISSUE}/assignees`, {
      assignees: [input.appLogin],
    });
    const assigned = response.assignees.some((assignee) => assignee.login.toLowerCase() === input.appLogin);
    if (!assigned) notes.push("Assignment call succeeded but app login not present in assignees array.");
    return {
      name: "issue-assigned (org codebridge-test)",
      status: assigned ? "PASS" : "FAIL",
      triggerUrl: response.html_url,
      triggerId: String(response.number),
      ingressDetected: false,
      ingressSessionKeys: [],
      notes,
    };
  } catch (error) {
    notes.push(error instanceof Error ? error.message : String(error));
    return {
      name: "issue-assigned (org codebridge-test)",
      status: "FAIL",
      ingressDetected: false,
      ingressSessionKeys: [],
      notes,
    };
  }
}

async function testIssueMention(input: {
  token: string;
  appHandle: string;
  botLogins: string[];
  repoFull: string;
  issueNumber: number;
  label: string;
  blockReason?: string;
}): Promise<TestResult> {
  const marker = makeMarker(`e2e-${input.label}`);
  const body = `${input.appHandle} ${marker} please acknowledge this test.`;
  const notes: string[] = [];
  const { owner, repo } = parseRepo(input.repoFull);

  const trigger = await rest<{
    id: number;
    html_url: string;
    created_at: string;
  }>(input.token, "POST", `/repos/${owner}/${repo}/issues/${input.issueNumber}/comments`, {
    body,
  });

  if (input.blockReason) {
    const ingress = findMarkerIngress(marker);
    notes.push(input.blockReason);
    notes.push("Skipped strict reply expectation because this path is currently blocked.");
    return {
      name: `issue-comment-mention (${input.label})`,
      status: "BLOCKED",
      marker,
      triggerUrl: trigger.html_url,
      triggerId: String(trigger.id),
      ingressDetected: ingress.detected,
      ingressSessionKeys: ingress.keys,
      notes,
    };
  }

  const ingress = findMarkerIngress(marker);
  const botReply = await pollIssueBotReply({
    token: input.token,
    repoFull: input.repoFull,
    issueNumber: input.issueNumber,
    botLogins: input.botLogins,
    triggerIso: trigger.created_at,
  });
  const ingressAfterPoll = ingress.detected ? ingress : findMarkerIngress(marker);

  if (!ingressAfterPoll.detected) notes.push("No OpenClaw session log entry found for marker.");
  if (!botReply) notes.push("No bot issue reply detected within poll timeout.");

  return {
    name: `issue-comment-mention (${input.label})`,
    status: ingressAfterPoll.detected && Boolean(botReply) ? "PASS" : "FAIL",
    marker,
    triggerUrl: trigger.html_url,
    triggerId: String(trigger.id),
    botReplyUrl: botReply?.url,
    botReplyId: botReply?.id,
    ingressDetected: ingressAfterPoll.detected,
    ingressSessionKeys: ingressAfterPoll.keys,
    notes,
  };
}

async function testPrReviewMention(input: {
  token: string;
  appHandle: string;
  botLogins: string[];
  repoFull: string;
  prNumber: number;
}): Promise<TestResult> {
  const marker = makeMarker("e2e-pr-review");
  const body = `${input.appHandle} ${marker} please validate PR review mention flow.`;
  const notes: string[] = [];
  const { owner, repo } = parseRepo(input.repoFull);

  const trigger = await rest<{
    id: number;
    html_url: string;
    submitted_at: string | null;
  }>(input.token, "POST", `/repos/${owner}/${repo}/pulls/${input.prNumber}/reviews`, {
    event: "COMMENT",
    body,
  });

  const triggerIso = trigger.submitted_at || new Date().toISOString();
  const ingress = findMarkerIngress(marker);
  const botReply = await pollPrBotReview({
    token: input.token,
    repoFull: input.repoFull,
    prNumber: input.prNumber,
    botLogins: input.botLogins,
    triggerIso,
  });
  const ingressAfterPoll = ingress.detected ? ingress : findMarkerIngress(marker);

  if (!ingressAfterPoll.detected) notes.push("No OpenClaw session log entry found for marker.");
  if (!botReply) notes.push("No bot PR review/reply detected within poll timeout.");

  return {
    name: "pr-review-mention",
    status: ingressAfterPoll.detected && Boolean(botReply) ? "PASS" : "FAIL",
    marker,
    triggerUrl: trigger.html_url,
    triggerId: String(trigger.id),
    botReplyUrl: botReply?.url,
    botReplyId: botReply?.id,
    ingressDetected: ingressAfterPoll.detected,
    ingressSessionKeys: ingressAfterPoll.keys,
    notes,
  };
}

async function testDiscussionMention(input: {
  token: string;
  appHandle: string;
  botLogins: string[];
  repoFull: string;
  discussionNumber: number;
}): Promise<TestResult> {
  const marker = makeMarker("e2e-discussion");
  const body = `${input.appHandle} ${marker} please validate discussion mention flow.`;
  const notes: string[] = [];
  const { owner, repo } = parseRepo(input.repoFull);

  const lookup = await graphql<{
    repository: {
      discussion: {
        id: string;
        url: string;
      } | null;
    } | null;
  }>(
    input.token,
    `
      query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          discussion(number: $number) {
            id
            url
          }
        }
      }
    `,
    { owner, name: repo, number: input.discussionNumber },
  );
  const discussionId = lookup.repository?.discussion?.id;
  if (!discussionId) {
    return {
      name: "discussion-comment-mention",
      status: "FAIL",
      ingressDetected: false,
      ingressSessionKeys: [],
      notes: ["Discussion not found; cannot trigger discussion test."],
    };
  }

  const trigger = await graphql<{
    addDiscussionComment: {
      comment: {
        id: string;
        url: string;
        createdAt: string;
      };
    };
  }>(
    input.token,
    `
      mutation($discussionId: ID!, $body: String!) {
        addDiscussionComment(input: { discussionId: $discussionId, body: $body }) {
          comment {
            id
            url
            createdAt
          }
        }
      }
    `,
    { discussionId, body },
  );

  const triggerComment = trigger.addDiscussionComment.comment;
  const ingressAfterPoll = await waitForMarkerIngress(marker, 45);
  if (!ingressAfterPoll.detected) {
    notes.push("No OpenClaw session log entry found for marker.");
    return {
      name: "discussion-comment-mention",
      status: "FAIL",
      marker,
      triggerUrl: triggerComment.url,
      triggerId: triggerComment.id,
      ingressDetected: false,
      ingressSessionKeys: [],
      notes,
    };
  }

  notes.push(
    "Discussion mention ingress validated. Thread reply remains blocked because OpenClaw GitHub outbound target format currently supports issue/PR style owner/repo#number only.",
  );
  return {
    name: "discussion-comment-mention",
    status: "BLOCKED",
    marker,
    triggerUrl: triggerComment.url,
    triggerId: triggerComment.id,
    ingressDetected: true,
    ingressSessionKeys: ingressAfterPoll.keys,
    notes,
  };
}

function renderMarkdown(report: RunReport): string {
  const lines: string[] = [];
  lines.push(`# CodeClaw GitHub Channel E2E Report`);
  lines.push("");
  lines.push(`- startedAt: ${report.startedAt}`);
  lines.push(`- finishedAt: ${report.finishedAt}`);
  lines.push(`- appLogin: ${report.appLogin}`);
  lines.push(`- botLogins: ${report.botLogins.join(", ")}`);
  lines.push(`- org: ${report.org}`);
  lines.push(`- codebridgeRepo: ${report.codebridgeRepo}`);
  lines.push(`- bridgeWebhookUrl: ${report.bridgeWebhookUrl ?? "null"}`);
  lines.push(`- orgInstalled: ${report.installation.orgInstalled}`);
  lines.push("");
  lines.push(`## Installation`);
  lines.push("");
  for (const install of report.installation.installations) {
    lines.push(
      `- installation ${install.id}: ${install.account} (${install.type}) selection=${install.repositorySelection}`,
    );
  }
  lines.push("");
  lines.push(`## Tests`);
  lines.push("");
  for (const test of report.tests) {
    lines.push(`### ${test.name}`);
    lines.push(`- status: ${test.status}`);
    if (test.marker) lines.push(`- marker: ${test.marker}`);
    if (test.triggerUrl) lines.push(`- triggerUrl: ${test.triggerUrl}`);
    if (test.triggerId) lines.push(`- triggerId: ${test.triggerId}`);
    lines.push(`- ingressDetected: ${test.ingressDetected}`);
    lines.push(`- ingressSessionKeys: ${test.ingressSessionKeys.join(", ") || "none"}`);
    if (test.botReplyUrl) lines.push(`- botReplyUrl: ${test.botReplyUrl}`);
    if (test.botReplyId) lines.push(`- botReplyId: ${test.botReplyId}`);
    if (test.notes.length) {
      for (const note of test.notes) lines.push(`- note: ${note}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const openclawEnv = parseEnvFile(OPENCLAW_ENV_PATH);
  const githubEnv = parseEnvFile(GITHUB_ENV_PATH);
  const githubToken = requireEnvValue(
    "GITHUB_TOKEN",
    githubEnv.GITHUB_TOKEN,
    process.env.GITHUB_TOKEN,
    process.env.GH_TOKEN,
    openclawEnv.GITHUB_TOKEN,
    openclawEnv.GH_TOKEN,
  );

  const appLogin = requireEnvValue(
    "GITHUB_APP_LOGIN",
    process.env.GITHUB_APP_LOGIN,
    openclawEnv.GITHUB_APP_LOGIN,
  ).toLowerCase();
  const appHandle = `@${appLogin}`;
  const botLogins = [appLogin, `${appLogin}[bot]`].map((entry) => entry.toLowerCase());
  const hooksToken = requireEnvValue(
    "OPENCLAW_HOOKS_TOKEN",
    process.env.OPENCLAW_HOOKS_TOKEN,
    openclawEnv.OPENCLAW_HOOKS_TOKEN,
  );
  const webhookSecret = requireEnvValue(
    "GITHUB_APP_WEBHOOK_SECRET",
    process.env.GITHUB_APP_WEBHOOK_SECRET,
    openclawEnv.GITHUB_APP_WEBHOOK_SECRET,
  );

  const installation = await loadInstallationSummary(openclawEnv);
  const issueOwner = parseRepo(ISSUE_REPO).owner.toLowerCase();
  const issueInstallation =
    installation.installations.find((entry) => entry.account.toLowerCase() === issueOwner) ||
    installation.installations[0];
  if (!issueInstallation) {
    throw new Error("No GitHub App installation found for synthetic assignment fallback.");
  }
  const startedAt = new Date().toISOString();

  const results: TestResult[] = [];
  results.push(
    await testIssueAssigned({
      token: githubToken,
      appLogin,
      botLogins,
      issueRepoFull: ISSUE_REPO,
      issueNumber: ISSUE_NUMBER,
      webhookSecret,
      hooksToken,
      installationId: issueInstallation.id,
      installedAccounts: installation.installations.map((entry) => entry.account.toLowerCase()),
    }),
  );
  const issueTargetIsCodebridge =
    ISSUE_REPO.toLowerCase() === CODEBRIDGE_REPO.toLowerCase() && ISSUE_NUMBER === CODEBRIDGE_ISSUE;
  const codebridgeBlockReason = installation.orgInstalled
    ? undefined
    : `GitHub App '${installation.appSlug}' is not installed on org '${ORG}', so webhook delivery from ${CODEBRIDGE_REPO} cannot reach OpenClaw yet.`;
  results.push(
    await testIssueMention({
      token: githubToken,
      appHandle,
      botLogins,
      repoFull: ISSUE_REPO,
      issueNumber: ISSUE_NUMBER,
      label: issueTargetIsCodebridge ? "codebridge-org" : "issue",
      blockReason: issueTargetIsCodebridge ? codebridgeBlockReason : undefined,
    }),
  );
  if (!issueTargetIsCodebridge) {
    results.push(
      await testIssueMention({
        token: githubToken,
        appHandle,
        botLogins,
        repoFull: CODEBRIDGE_REPO,
        issueNumber: CODEBRIDGE_ISSUE,
        label: "codebridge-org",
        blockReason: codebridgeBlockReason,
      }),
    );
  }
  if (isPositiveInteger(PR_NUMBER)) {
    results.push(
      await testPrReviewMention({
        token: githubToken,
        appHandle,
        botLogins,
        repoFull: PR_REPO,
        prNumber: PR_NUMBER,
      }),
    );
  } else {
    results.push({
      name: "pr-review-mention",
      status: "BLOCKED",
      ingressDetected: false,
      ingressSessionKeys: [],
      notes: [
        "Skipped PR review mention test: TEST_PR_NUMBER is not configured (>0).",
      ],
    });
  }
  if (isPositiveInteger(DISCUSSION_NUMBER)) {
    results.push(
      await testDiscussionMention({
        token: githubToken,
        appHandle,
        botLogins,
        repoFull: DISCUSSION_REPO,
        discussionNumber: DISCUSSION_NUMBER,
      }),
    );
  } else {
    results.push({
      name: "discussion-comment-mention",
      status: "BLOCKED",
      ingressDetected: false,
      ingressSessionKeys: [],
      notes: [
        "Skipped discussion mention test: TEST_DISCUSSION_NUMBER is not configured (>0).",
      ],
    });
  }

  const report: RunReport = {
    startedAt,
    finishedAt: new Date().toISOString(),
    appLogin,
    botLogins,
    org: ORG,
    codebridgeRepo: CODEBRIDGE_REPO,
    installation,
    bridgeWebhookUrl: readBridgeWebhookUrl(),
    tests: results,
  };

  const reportsDir = path.join(process.cwd(), "reports");
  mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(reportsDir, `codebridge-test-report-${stamp}.json`);
  const mdPath = path.join(reportsDir, `codebridge-test-report-${stamp}.md`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(mdPath, renderMarkdown(report));

  console.log(
    JSON.stringify(
      {
        jsonPath,
        mdPath,
        orgInstalled: installation.orgInstalled,
        tests: results.map((entry) => ({ name: entry.name, status: entry.status })),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
