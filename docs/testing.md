# Testing Requirements

This document defines mandatory testing gates for CodeClaw.

## Scope
- Applies to changes affecting:
  - GitHub mention or assignment trigger handling.
  - OpenClaw webhook intake/routing.
  - Gateway/bridge setup scripts.
  - Evaluation runner behavior or scoring inputs.
- Applies before marking a task complete and before merging PRs.

## Allowed Test Targets
- `dzianisv/codebridge-test`
- `VibeTechnologies/codebridge-test`

Do not run eval/validation against unrelated repositories.
Rationale: these two repos are controlled fixtures used by this project for repeatable trigger and webhook validation.
Exception process: use a different repo only when explicitly required by task scope and record the reason in PR/issue evidence.

## Test Matrix By Change Type
1. `scripts/eval-openclaw.ts` changes:
   - Required: hard evaluation gate.
   - Required: `bun build --target=bun ./scripts/eval-openclaw.ts --outfile /tmp/eval-openclaw.js`.
2. `scripts/runGithubMentionE2ETest.ts` changes:
   - Required: operational E2E matrix run.
   - Required: hard evaluation gate.
3. `scripts/setupOpenClawOrchestrator.ts` or `scripts/start-clawengineer-webhook-bridge.ts` changes:
   - Required: operational E2E matrix run.
   - Required: hard evaluation gate.
4. Docs-only changes:
   - Required: document-only validation (links/paths are correct, no stale references).
   - Runtime E2E is optional unless behavior claims are changed.

## Hard Evaluation Gate (Blocking)
- Command baseline:
```bash
bun scripts/eval-openclaw.ts --repo dzianisv/codebridge-test --timeout 180 --poll 10
```
- Timeout guidance:
  - `180` seconds baseline.
  - Reasoning: this is typically enough for webhook ingestion + bot response under normal tunnel latency.
  - Increase to `--timeout 300` if two or more cases time out waiting for bot replies.
  - After a retry with `--timeout 300`, if required cases still do not collect, the gate is failed.
- Required outcome:
  - Promptfoo summary: `N passed, 0 failed, 0 errors`.
  - All required cases are present and collected:
    - `python-hello-world`
    - `typescript-bun-hello`
    - `research-gpt-release`
    - `direct-assignment-no-mention`
- Assignment trigger acceptance:
  - `trigger_type` must be `assignment`.
  - `trigger_mode` must be `direct`.
  - The target issue must contain a configured OpenClaw assignment identity in `assignees` (real GitHub assignment, not inferred/synthetic).
  - Preferred identity is the app login; when GitHub does not allow assigning the app bot account, use explicit assignment aliases from `OPENCLAW_GITHUB_ASSIGNMENT_LOGINS`.
  - Any synthetic assignment fallback is a hard gate failure.

## Operational E2E Matrix (Readiness, Non-Blocking)
- Command:
```bash
bun scripts/runGithubMentionE2ETest.ts
```
- Artifacts:
  - `reports/codebridge-test-report-<timestamp>.json`
  - `reports/codebridge-test-report-<timestamp>.md`
- Covered use cases:
  - `issue-assigned (org codebridge-test)`
  - `issue-comment-mention (issue)`
  - `issue-comment-mention (codebridge-org)` when target differs
  - `pr-review-mention` (required when `TEST_PR_NUMBER > 0`, otherwise expected `BLOCKED` skip)
  - `discussion-comment-mention` (required when `TEST_DISCUSSION_NUMBER > 0`, otherwise expected `BLOCKED` skip)
- Status semantics:
  - `PASS`: validated behavior.
  - `BLOCKED`: external/platform constraint or intentionally skipped optional path.
  - `FAIL`: regression or unexpected behavior.
- Acceptability rule:
  - `BLOCKED` is acceptable only with clear reason in notes.
  - Any `FAIL` is unacceptable and must be fixed or explicitly scoped before completion.
  - `BLOCKED` is never a substitute for a failing hard evaluation gate.
  - Example:
    - acceptable: matrix shows `BLOCKED` for `discussion-comment-mention` due known outbound limitation, while hard eval passes.
    - not acceptable: hard eval has any `failed` or `error`, even if matrix is mostly `PASS/BLOCKED`.

## Environment Coverage
- Validate default matrix settings (no optional PR/discussion numbers).
- Validate override path when needed using:
  - `TEST_ISSUE_REPO` + `TEST_ISSUE_NUMBER`
  - `TEST_PR_REPO` + `TEST_PR_NUMBER`
  - `TEST_DISCUSSION_REPO` + `TEST_DISCUSSION_NUMBER`
  - `TEST_POLL_SECONDS`

## Access Requirements
- `gh` CLI must be authenticated with repo read/write scope for the allowed test target.
- OpenClaw local credentials must be configured for webhook handling and GitHub app auth.
- If access is missing (for example assignment API returns `403`, or app login is not assignable), capture that in evidence and keep status **IN PROGRESS**.
- Assignment-trigger failures must be fixed at platform/config level; they cannot be waived via synthetic webhook fallback.

## Required Evidence In PR/Issue Updates
- Exact command(s) executed.
- Artifact paths:
  - `reports/eval-config-<timestamp>.json`
  - `reports/eval-raw-<timestamp>.json`
  - `reports/eval-output-<timestamp>.json`
  - `reports/codebridge-test-report-<timestamp>.json`
  - `reports/codebridge-test-report-<timestamp>.md`
- Per-case status summary:
  - Include trigger mode and notes for assignment case.
  - Include `PASS/BLOCKED/FAIL` breakdown for matrix tests.

## Static Checks
- If project-level static checks exist (`lint`, `typecheck`, etc.), run them before completion.
- If checks do not exist, explicitly state that in the completion update.
- Current state: `package.json` defines `eval` and `e2e` scripts only (no lint/typecheck script).

## Enforcement
- Enforcement is currently procedural (PR/issue evidence + reviewer verification).
- Recommended automation follow-up:
  - CI workflow that runs `bun run eval` with repo/timeout parameters.
  - Artifact presence check for required report files.
- Tracking issue: `dzianisv/CodeClaw#5`.

## Completion Rule
- Task is complete only when:
  - hard evaluation gate passes, and
  - required evidence is posted, and
  - no unresolved `FAIL` remains in required runs.
- Failure ownership:
  - The task owner must resolve the `FAIL` or create/link a blocking issue with clear scope and reason the task cannot proceed.
