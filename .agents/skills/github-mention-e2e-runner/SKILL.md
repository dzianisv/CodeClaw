---
name: github-mention-e2e-runner
description: Run the TypeScript GitHub mention E2E matrix and generate timestamped JSON/Markdown reports for codebridge-test readiness.
---

# GitHub Mention E2E Runner

## Purpose
Execute a deterministic, script-driven end-to-end matrix for OpenClaw GitHub mention handling and produce a report artifact that can be shared.

## Inputs
- `poll_seconds` (optional): overrides `TEST_POLL_SECONDS`.
- Optional repo/issue overrides via environment (defaults are `VibeTechnologies/codebridge-test` + issue `1`):
  - `TEST_ORG`, `TEST_CODEBRIDGE_REPO`, `TEST_CODEBRIDGE_ISSUE`
  - `TEST_ISSUE_REPO`, `TEST_ISSUE_NUMBER` (defaults to codebridge target)
  - `TEST_PR_REPO`, `TEST_PR_NUMBER` (optional; skipped unless `TEST_PR_NUMBER > 0`)
  - `TEST_DISCUSSION_REPO`, `TEST_DISCUSSION_NUMBER` (optional; skipped unless `TEST_DISCUSSION_NUMBER > 0`)

## Preconditions
1. `bun` is available.
2. OpenClaw setup has been run successfully (`bun scripts/setupOpenClawOrchestrator.ts`).
3. Webhook bridge is running (`bun scripts/start-clawengineer-webhook-bridge.ts`).
4. GitHub token is available in `~/.env.d/github.env` (or env override).

## Protocol
1. Start bridge in one terminal:
   - `bun scripts/start-clawengineer-webhook-bridge.ts`
2. Execute test runner:
   - `bun scripts/runGithubMentionE2ETest.ts`
   - or `TEST_POLL_SECONDS=<n> bun scripts/runGithubMentionE2ETest.ts`
3. Capture report paths from stdout:
   - `reports/codebridge-test-report-<timestamp>.json`
   - `reports/codebridge-test-report-<timestamp>.md`
4. Validate matrix outcomes:
  - `issue-assigned` on `codebridge-test`
  - `issue-comment-mention` on configured `TEST_ISSUE_REPO`/`TEST_ISSUE_NUMBER`
  - `issue-comment-mention (codebridge-org)` (included when configured issue target differs from codebridge)
  - `pr-review-mention` (only when `TEST_PR_NUMBER > 0`)
  - `discussion-comment-mention` (only when `TEST_DISCUSSION_NUMBER > 0`)

## Output
- Timestamped JSON + Markdown report including:
  - app installation state
  - bridge webhook URL
  - trigger URL/id for each test
  - bot reply URL/id when present
  - ingress/session-key evidence
  - pass/fail per test

## Status semantics
- `PASS`: live end-to-end behavior validated.
- `BLOCKED`: behavior is blocked by external/platform constraint (for example app not installed on org repo, or discussion outbound not supported by current GitHub channel target format).
- `FAIL`: unexpected regression in behavior that should work in current environment.
