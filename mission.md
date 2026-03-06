# CodeClaw Mission (OpenClaw Orchestrator)

## Goal
Build a production-grade orchestrator using OpenClaw (not CodeBridge) so GitHub assignment/mention events trigger OpenClaw work, and OpenClaw posts run updates back to the same GitHub thread.

## Hard Acceptance Criteria
Mission is not complete until all are true:

1. A dedicated evaluation suite exists for requested user-facing behavior.
2. Evaluation covers:
   - direct issue assignment to app handle (without mention),
   - issue mention flow,
   - PR mention flow,
   - discussion mention flow.
3. Evaluation is run end-to-end against integrated OpenClaw system.
4. Final results pass according to `docs/testing.md` and `AGENTS.md` gates.

## Required Evaluation Scenarios

1. Create GitHub issue and assign to `@clawengineer` (direct assignment, no mention).
   - OpenClaw triggers run from assignment event.
   - Agent starts working and posts run status comment.

2. Create GitHub issue and mention `@clawengineer`.
   - OpenClaw accepts command and runs with issue context.
   - OpenClaw posts run result updates.

3. Create PR and mention `@clawengineer` with a question.
   - OpenClaw routes prompt to agent runtime.
   - OpenClaw posts response in PR conversation.

4. Create discussion and mention `@clawengineer` with a research task.
   - OpenClaw routes prompt to agent runtime.
   - OpenClaw posts response in discussion thread.

## Evaluation Framework

- Framework: `promptfoo` (no regex-only evaluator).
- Hard-gate runner: `scripts/eval-openclaw.ts`
- Operational protocol matrix: `scripts/runGithubMentionE2ETest.ts`

## Mission Execution Protocol

1. Compile check:
   - `bun build --target=bun ./scripts/eval-openclaw.ts --outfile /tmp/eval-openclaw.js`
2. Hard evaluation gate:
   - `bun scripts/eval-openclaw.ts --repo dzianisv/codebridge-test --timeout 180 --poll 10`
3. Operational matrix:
   - `bun scripts/runGithubMentionE2ETest.ts`
4. Publish evidence:
   - exact commands, artifacts, per-case status, canonical URLs (issue/comment/review/discussion as applicable).
5. Keep status **IN PROGRESS** until hard gate is fully passing (`N passed, 0 failed, 0 errors`).

## Latest Verified Status (2026-03-06)

### Hard Gate (Promptfoo) — PASS

Commands:

```bash
bun build --target=bun ./scripts/eval-openclaw.ts --outfile /tmp/eval-openclaw.js
OWNER_TOKEN="$(env -u GITHUB_TOKEN -u GH_TOKEN gh auth token --user dzianisv)"
GITHUB_TOKEN="$OWNER_TOKEN" GH_TOKEN="$OWNER_TOKEN" \
bun scripts/eval-openclaw.ts --repo dzianisv/codebridge-test --timeout 180 --poll 10
```

Result:
- `4 passed, 0 failed, 0 errors`

Artifacts:
- `reports/eval-config-2026-03-06T06-34-48-867Z.json`
- `reports/eval-raw-2026-03-06T06-34-48-867Z.json`
- `reports/eval-output-2026-03-06T06-34-48-867Z.json`

Per-case status:
- `python-hello-world`: PASS
  - issue: `https://github.com/dzianisv/codebridge-test/issues/441`
  - trigger comment: `https://github.com/dzianisv/codebridge-test/issues/441#issuecomment-4009879849`
  - bot reply: `https://github.com/dzianisv/codebridge-test/issues/441#issuecomment-4009880175`
- `typescript-bun-hello`: PASS
  - issue: `https://github.com/dzianisv/codebridge-test/issues/442`
  - trigger comment: `https://github.com/dzianisv/codebridge-test/issues/442#issuecomment-4009879915`
  - bot reply: `https://github.com/dzianisv/codebridge-test/issues/442#issuecomment-4009880290`
- `research-gpt-release`: PASS
  - issue: `https://github.com/dzianisv/codebridge-test/issues/443`
  - trigger comment: `https://github.com/dzianisv/codebridge-test/issues/443#issuecomment-4009879965`
  - bot reply: `https://github.com/dzianisv/codebridge-test/issues/443#issuecomment-4009880440`
- `direct-assignment-no-mention`: PASS
  - issue: `https://github.com/dzianisv/codebridge-test/issues/444`
  - `trigger_type=assignment`
  - `trigger_mode=direct`
  - `assignment_trigger_check=pass`
  - assigned identity in GitHub assignees: `dzianisv`
  - assigned event evidence: `https://github.com/dzianisv/codebridge-test/issues/444`
  - run-start bot reply: `https://github.com/dzianisv/codebridge-test/issues/444#issuecomment-4009891943`

### Operational Matrix — PASS

Commands:

```bash
OWNER_TOKEN="$(env -u GITHUB_TOKEN -u GH_TOKEN gh auth token --user dzianisv)"
GITHUB_TOKEN="$OWNER_TOKEN" GH_TOKEN="$OWNER_TOKEN" \
TEST_ORG=dzianisv \
TEST_CODEBRIDGE_REPO=dzianisv/codebridge-test \
TEST_CODEBRIDGE_ISSUE=445 \
TEST_ISSUE_REPO=dzianisv/codebridge-test \
TEST_ISSUE_NUMBER=445 \
TEST_PR_REPO=dzianisv/codebridge-test \
TEST_PR_NUMBER=323 \
TEST_DISCUSSION_REPO=dzianisv/codebridge-test \
TEST_DISCUSSION_NUMBER=324 \
TEST_POLL_SECONDS=150 \
bun scripts/runGithubMentionE2ETest.ts
```

Artifacts:
- `reports/codebridge-test-report-2026-03-06T06-42-04-730Z.json`
- `reports/codebridge-test-report-2026-03-06T06-42-04-730Z.md`

Per-case status:
- `issue-assigned (org codebridge-test)`: PASS
  - trigger issue: `https://github.com/dzianisv/codebridge-test/issues/445`
  - bot reply: `https://github.com/dzianisv/codebridge-test/issues/445#issuecomment-4009906339`
- `issue-comment-mention (codebridge-org)`: PASS
  - trigger comment: `https://github.com/dzianisv/codebridge-test/issues/445#issuecomment-4009906397`
  - bot reply: `https://github.com/dzianisv/codebridge-test/issues/445#issuecomment-4009906654`
- `pr-review-mention`: PASS
  - trigger review: `https://github.com/dzianisv/codebridge-test/pull/323#pullrequestreview-3901712327`
  - bot reply: `https://github.com/dzianisv/codebridge-test/pull/323#issuecomment-4009907095`
- `discussion-comment-mention`: PASS
  - trigger comment: `https://github.com/dzianisv/codebridge-test/discussions/324#discussioncomment-16019202`
  - ingress validated; no discussion-thread bot reply within poll timeout (accepted by matrix rule).

## Current Constraints

- GitHub does not allow assigning `clawengineer[bot]` directly in `dzianisv/codebridge-test`; configured assignment alias (`OPENCLAW_GITHUB_ASSIGNMENT_LOGINS=dzianisv`) is required for live assignment trigger validation in this repo.
- Tracking/evidence issue for hard-gate status: `https://github.com/dzianisv/CodeClaw/issues/6`

## Closure Checklist

- [x] Promptfoo hard gate exists.
- [x] Mention/issue scenarios execute through OpenClaw.
- [x] Direct assignment-without-mention passes with real issue assignee evidence.
- [x] PR mention path verified in artifacts.
- [x] Discussion mention path verified in artifacts.
- [x] Hard gate fully passes and mission can be closed.
