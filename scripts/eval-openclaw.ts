#!/usr/bin/env bun
/**
 * OpenClaw Eval: Agent Task Execution Quality
 *
 * Posts 3 test tasks as GitHub issues with @clawengineer mentions,
 * waits for the bot to reply, writes a promptfoo-compatible vars file,
 * then runs `npx promptfoo eval` for LLM-as-judge scoring.
 *
 * Usage:
 *   bun scripts/eval-openclaw.ts [--repo owner/repo] [--timeout 300] [--keep]
 *
 * Requires:
 *   - OpenClaw gateway running (hooks enabled)
 *   - Webhook bridge running (start-clawengineer-webhook-bridge.ts)
 *   - gh CLI authenticated (keyring, not GITHUB_TOKEN env)
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/* ------------------------------------------------------------------ */
/*  Types & Config                                                     */
/* ------------------------------------------------------------------ */

type EvalCase = {
  id: string;
  title: string;
  /** The mention body posted as a comment */
  prompt: string;
  /** Instructions for the LLM judge (used in promptfoo llm-rubric) */
  judgeCriteria: string;
};

const EVAL_CASES: EvalCase[] = [
  {
    id: "python-hello-world",
    title: "Create a Python hello world",
    prompt:
      "@clawengineer Create a file called hello.py that prints 'Hello, World!' to stdout. Only create the file, nothing else.",
    judgeCriteria: [
      "The bot MUST have created or shown a Python file (hello.py) that prints 'Hello, World!'.",
      "The response should mention the file was created or show its contents.",
      "If the response contains error messages about network failures, gh CLI, or GitHub API — that is a FAILURE even if partial output is present.",
      "Score 0-10: 10 = file created correctly with clean output, 5 = correct logic but noisy output, 0 = wrong or no useful output.",
    ].join("\n"),
  },
  {
    id: "typescript-bun-hello",
    title: "Create a TypeScript/Bun hello world",
    prompt:
      "@clawengineer Create a file called hello.ts that uses console.log to print 'Hello from Bun!' — it should be valid TypeScript runnable with `bun run hello.ts`. Only create the file, nothing else.",
    judgeCriteria: [
      "The bot MUST have created or shown a TypeScript file (hello.ts) that prints 'Hello from Bun!' via console.log.",
      "The file should be valid TypeScript that runs under Bun.",
      "If the response contains error messages about network failures, gh CLI, or GitHub API — that is a FAILURE even if partial output is present.",
      "Score 0-10: 10 = file created correctly with clean output, 5 = correct logic but noisy output, 0 = wrong or no useful output.",
    ].join("\n"),
  },
  {
    id: "research-gpt-release",
    title: "Research: first GPT model release date",
    prompt:
      "@clawengineer Research and tell me: when was the first GPT model released by OpenAI? Provide the year and month if possible, and a one-sentence summary.",
    judgeCriteria: [
      "The bot should state that GPT-1 was released in June 2018 (the paper 'Improving Language Understanding by Generative Pre-Training' by Radford et al.).",
      "Acceptable: mentioning 2018 as the year. Bonus for mentioning June 2018.",
      "If the bot says GPT-2 (2019), GPT-3 (2020), or ChatGPT (2022) as the FIRST model, that is wrong.",
      "If the response contains error messages about network failures, gh CLI, or GitHub API — deduct points but still evaluate the factual content if present.",
      "Score 0-10: 10 = correct date + clean summary, 7 = correct year but vague, 3 = wrong model/date, 0 = no useful answer.",
    ].join("\n"),
  },
];

/* ------------------------------------------------------------------ */
/*  CLI Args                                                           */
/* ------------------------------------------------------------------ */

type Args = {
  repo: string;
  appHandle: string;
  timeoutSec: number;
  pollSec: number;
  keepArtifacts: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    repo: "dzianisv/codebridge-test",
    appHandle: "@clawengineer",
    timeoutSec: 300,
    pollSec: 10,
    keepArtifacts: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--repo" && next) { args.repo = next; i++; }
    else if (arg === "--app-handle" && next) { args.appHandle = next.startsWith("@") ? next : `@${next}`; i++; }
    else if (arg === "--timeout" && next) { args.timeoutSec = Number(next); i++; }
    else if (arg === "--poll" && next) { args.pollSec = Number(next); i++; }
    else if (arg === "--keep") { args.keepArtifacts = true; }
  }
  return args;
}

/* ------------------------------------------------------------------ */
/*  GitHub helpers (via gh CLI, keyring auth)                           */
/* ------------------------------------------------------------------ */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function gh(ghArgs: string[]): string {
  const result = spawnSync("gh", ghArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "" },
    encoding: "utf-8",
  });
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

/**
 * Wait for bot reply on an issue. Polls until "complete" appears in a
 * bot comment or timeout is reached (returns partial if available).
 */
async function waitForBotReply(input: {
  repo: string;
  issueNumber: number;
  botLogin: string;
  timeoutSec: number;
  pollSec: number;
}): Promise<{ comments: BotComment[]; combinedBody: string }> {
  const deadline = Date.now() + input.timeoutSec * 1000;
  const botLogin = input.botLogin.toLowerCase();

  while (Date.now() < deadline) {
    const raw = gh(["api", `repos/${input.repo}/issues/${input.issueNumber}/comments?per_page=100`]);
    const all = JSON.parse(raw) as BotComment[];
    const botComments = all.filter((c) => (c.user?.login ?? "").toLowerCase() === botLogin);

    const isComplete = botComments.some((c) => /\bcomplete\b/i.test(c.body));
    if (isComplete) {
      return {
        comments: botComments,
        combinedBody: botComments.map((c) => c.body).join("\n\n---\n\n"),
      };
    }

    // If we have any bot comments at all after a while, that's progress
    if (botComments.length > 0 && Date.now() > deadline - input.timeoutSec * 1000 * 0.5) {
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

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

type EvalResult = {
  caseId: string;
  title: string;
  prompt: string;
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = Date.now();
  const botLogin = args.appHandle.replace(/^@/, "") + "[bot]";
  const azureApiBaseUrl = normalizeAzureBaseUrl(process.env.AZURE_OPENAI_BASE_URL);
  const azureApiHost = new URL(azureApiBaseUrl).host;

  console.log(`\n=== OpenClaw Eval: Agent Task Quality ===`);
  console.log(`Repo: ${args.repo}`);
  console.log(`Bot: ${botLogin}`);
  console.log(`Azure API base: ${azureApiBaseUrl}`);
  console.log(`Timeout: ${args.timeoutSec}s per task`);
  console.log(`Cases: ${EVAL_CASES.length}\n`);

  // ── Phase 1: Create issues and post mentions ──────────────────────
  console.log("--- Phase 1: Creating issues and posting mentions ---\n");
  const issueMap = new Map<string, { url: string; number: number }>();

  for (const evalCase of EVAL_CASES) {
    const title = `[eval] ${evalCase.title} (${now})`;
    const url = gh([
      "issue", "create",
      "--repo", args.repo,
      "--title", title,
      "--body", `Automated eval case: ${evalCase.id}`,
    ]);
    const issueNumber = Number(url.match(/\/issues\/(\d+)/)?.[1]);
    if (!Number.isFinite(issueNumber) || issueNumber <= 0) {
      throw new Error(`Failed to parse issue number from URL: ${url}`);
    }
    issueMap.set(evalCase.id, { url, number: issueNumber });
    console.log(`  Created ${evalCase.id} → ${url}`);

    // Post the mention comment
    gh([
      "issue", "comment",
      String(issueNumber),
      "--repo", args.repo,
      "--body", evalCase.prompt,
    ]);
    console.log(`  Posted mention on #${issueNumber}`);
  }

  // ── Phase 2: Wait for bot replies ─────────────────────────────────
  console.log("\n--- Phase 2: Waiting for bot replies ---\n");
  const results: EvalResult[] = [];

  for (const evalCase of EVAL_CASES) {
    const issue = issueMap.get(evalCase.id)!;
    console.log(`  Waiting for reply on #${issue.number} (${evalCase.id})...`);

    const reply = await waitForBotReply({
      repo: args.repo,
      issueNumber: issue.number,
      botLogin,
      timeoutSec: args.timeoutSec,
      pollSec: args.pollSec,
    });

    const timedOut = reply.comments.length === 0;
    if (!timedOut) {
      console.log(`  Got ${reply.comments.length} comment(s) on #${issue.number}`);
    } else {
      console.log(`  TIMEOUT on #${issue.number}`);
    }

    const fileChanges = getIssueFileChanges(args.repo, issue.number);
    if (fileChanges) {
      console.log(`  Found PR diff for #${issue.number}`);
    }

    results.push({
      caseId: evalCase.id,
      title: evalCase.title,
      prompt: evalCase.prompt,
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
      task_prompt: r.prompt,
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
    ],
  }));

  // Write dynamic promptfoo config with collected results
  const promptfooConfig = {
    description: `OpenClaw Agent Eval – ${new Date().toISOString()}`,
    prompts: [
      [
        "## Task",
        "Title: {{task_title}}",
        "Prompt: {{task_prompt}}",
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

  const promptfooResult = spawnSync(promptfooCmd, promptfooArgs, {
    stdio: "inherit",
    env: { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "" },
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
    console.log(`  Issue:    ${r.issueUrl}`);
    console.log(`  Response: ${r.botResponse.slice(0, 120).replace(/\n/g, " ")}...`);
    console.log();
  }

  console.log(`promptfoo config: ${configJsonPath}`);
  console.log(`promptfoo output: ${outputPath}`);
  console.log(`Raw results:      ${rawResultsPath}`);
  console.log(`\nRun 'npx promptfoo view' to see results in browser.\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
