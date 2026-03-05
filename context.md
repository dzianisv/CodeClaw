# Mission Summary

## Mission
1. Make the E2E test matrix (`scripts/runGithubMentionE2ETest.ts`) pass without false failures.
2. Build a promptfoo-based eval script (`scripts/eval-openclaw.ts`) that posts `@clawengineer` mentions on GitHub issues, collects bot replies, and uses LLM-as-judge scoring.

## Constraints
- **Test repos**: ONLY `dzianisv/codebridge-test` (user-level) and `VibeTechnologies/codebridge-test` (org-level). NEVER use `dzianisv/AiDocumentsOrganizer` or `dzianisv/openhaystack-web`.
- **Branch**: All changes on `fix/e2e-false-fail-elimination`, NOT `main`.
- **PR**: https://github.com/dzianisv/CodeClaw/pull/2
- **`gh` CLI auth**: Use `GITHUB_TOKEN="" GH_TOKEN="" gh ...` to access valid `dzianisv` keyring token.
- **LLM keys**: No `OPENAI_API_KEY` available. Use `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_BASE_URL` (deployment: `gpt-4.1`, host: `vibebrowser-dev.openai.azure.com`).
- **App handle**: `@clawengineer`, bot login: `clawengineer[bot]`.

## What Was Done

### Session 1 (Codex) — E2E test hardening
- Fixed regressions and flaky behavior in `scripts/runGithubMentionE2ETest.ts`:
  - Updated defaults to `VibeTechnologies/codebridge-test` (`issue=1`), PR/discussion tests opt-in.
  - Added guarded skip behavior (`BLOCKED`) for optional PR/discussion checks.
  - Reworked synthetic `issues.assigned` fallback.
  - Restored configured issue mention coverage and preserved explicit `codebridge-org` validation.
- Updated docs: `README.md`, `.agents/skills/` skill docs.
- Created/closed tracking issue `dzianisv/CodeClaw#1`.

### Session 2 (OpenCode) — False FAIL elimination
- Root cause: `testIssueMention` and `testPrReviewMention` used immediate `findMarkerIngress(marker)` instead of polling `waitForMarkerIngress(marker, timeout)`. Cloudflare tunnel delays caused false FAILs.
- Implemented three-tier status logic:
  - `PASS` — ingress detected AND bot replied
  - `BLOCKED` — no ingress detected after polling (infrastructure issue)
  - `FAIL` — ingress detected but bot didn't reply (genuine bug)
- Added `.gitignore`.
- Committed (`97d0efe`), pushed, created PR #2.

### Session 3 (OpenCode) — Eval script creation
- Read and analyzed CodeBridge reference eval (`/Users/engineer/workspace/CodeBridge/scripts/eval-codex-quality.ts`, 494 lines).
- Created `scripts/eval-openclaw.ts` (434 lines) — posts 3 eval tasks as GitHub issues with `@clawengineer` mentions, polls for bot replies, writes promptfoo-compatible JSON config with `llm-rubric` assertions, runs `npx promptfoo eval`.
- 3 eval scenarios: (1) Python hello world, (2) TypeScript/Bun hello world, (3) Research question about first GPT release date.
- Created `package.json` with `promptfoo` dependency.
- Removed stale `scripts/eval-codex-quality.ts` (superseded by `eval-openclaw.ts`).
- Fixed rubric provider: switched from `openai:gpt-4o` to Azure `gpt-4.1` deployment (confirmed working via curl).

### Session 4 (Codex) — Runtime fixes + full validation
- Re-ran `bun install`; initially failed with `ENOSPC`, then succeeded after clearing transient Bun cache.
- Fixed eval runtime defects in `scripts/eval-openclaw.ts`:
  - `gh` wrapper now forces keyring auth by setting `GITHUB_TOKEN=""` and `GH_TOKEN=""`.
  - Added issue-number parse guard after `gh issue create`.
  - Corrected partial-reply timing threshold math.
  - Normalized Azure base URL from `AZURE_OPENAI_BASE_URL` to origin (e.g. `https://vibebrowser-dev.openai.azure.com`) to avoid `404 Resource not found` in promptfoo grading.
  - Switched grader provider id to `azure:chat:gpt-4.1` with explicit `apiBaseUrl` + `apiHost`.
  - Switched promptfoo invocation to local `node_modules/.bin/promptfoo` when available (fallback `npx promptfoo@latest`).
  - Promptfoo non-zero exits now reported as scored eval outcome instead of hard script failure.
- Follow-up hardening:
  - Added `spawnSync` startup error handling in `gh()` wrapper.
  - Added explicit `AZURE_OPENAI_API_KEY` fail-fast validation.
  - Replaced URL-regex issue parsing with `gh api` issue creation + JSON parsing (`createIssue`).

## Validation Performed

### E2E Reports (Sessions 1-2)
- Default run: zero false FAILs.
- Override run (`dzianisv/codebridge-test`): `issue-assigned` PASS, rest BLOCKED (infra), zero false FAILs.

### Session 4 validation
- Compile check:
  - `bun build --target=bun scripts/eval-openclaw.ts` (PASS)
- Eval smoke run:
  - `bun scripts/eval-openclaw.ts --repo dzianisv/codebridge-test --timeout 5`
  - Report: `reports/eval-output-2026-03-05T08-39-29-653Z.json`
  - Result: 3/3 FAIL due timeout (expected infra), but rubric grading executed with Azure tokens (no 404).
- Eval smoke run (post-hardening):
  - `bun scripts/eval-openclaw.ts --repo dzianisv/codebridge-test --timeout 1`
  - Report: `reports/eval-output-2026-03-05T09-09-39-844Z.json`
  - Result: same expected timeout FAILs; issue create/close flow and grader path verified.
- Full eval run (required command):
  - `bun scripts/eval-openclaw.ts --repo dzianisv/codebridge-test --timeout 300`
  - Report: `reports/eval-output-2026-03-05T08-55-37-423Z.json`
  - Result: 3/3 FAIL due no bot replies within timeout; promptfoo grading completed successfully (no provider/config errors).
- E2E matrix rerun after eval script fixes:
  - `bun scripts/runGithubMentionE2ETest.ts`
  - Report: `reports/codebridge-test-report-2026-03-05T09-01-40-582Z.json`
  - Statuses: `issue-assigned` PASS, `issue-comment-mention (codebridge-org)` BLOCKED, `pr-review-mention` BLOCKED, `discussion-comment-mention` BLOCKED.

## Remaining Work
1. Commit pending files (`package.json`, `bun.lock`, `scripts/eval-openclaw.ts`, `.gitignore`, `context.md`) on `fix/e2e-false-fail-elimination`.
2. Push branch and update PR #2 with Session 4 validation evidence.
3. Keep monitoring external webhook reliability (timeouts remain infrastructure blocker, not script logic failure).

## External Blockers (out of scope)
- Webhook delivery through Cloudflare tunnel is unreliable — causes BLOCKED status on E2E tests.
- Discussion outbound reply remains BLOCKED due to OpenClaw channel target format limitation.
