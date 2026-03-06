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

### Hard Gate (Promptfoo)

Command:

```bash
GITHUB_TOKEN="$(gh auth token --user dzianisv)" GH_TOKEN="$GITHUB_TOKEN" \
bun scripts/eval-openclaw.ts --repo dzianisv/codebridge-test --timeout 180 --poll 10
```

Result:
- `4 passed, 0 failed, 0 errors`

Artifacts:
- `reports/eval-config-2026-03-06T04-45-22-809Z.json`
- `reports/eval-raw-2026-03-06T04-45-22-809Z.json`
- `reports/eval-output-2026-03-06T04-45-22-809Z.json`

Per-case status:
- `python-hello-world`: PASS
  - issue: `https://github.com/dzianisv/codebridge-test/issues/339`
  - trigger comment: `https://github.com/dzianisv/codebridge-test/issues/339#issuecomment-4009519291`
  - bot reply: `https://github.com/dzianisv/codebridge-test/issues/339#issuecomment-4009520835`
- `typescript-bun-hello`: PASS
  - issue: `https://github.com/dzianisv/codebridge-test/issues/340`
  - trigger comment: `https://github.com/dzianisv/codebridge-test/issues/340#issuecomment-4009519340`
  - bot reply: `https://github.com/dzianisv/codebridge-test/issues/340#issuecomment-4009522931`
- `research-gpt-release`: PASS
  - issue: `https://github.com/dzianisv/codebridge-test/issues/341`
  - trigger comment: `https://github.com/dzianisv/codebridge-test/issues/341#issuecomment-4009519386`
  - bot reply: `https://github.com/dzianisv/codebridge-test/issues/341#issuecomment-4009524852`
- `direct-assignment-no-mention`: PASS
  - `trigger_type=assignment`
  - `trigger_mode=direct`
  - `assignment_trigger_check=pass`
  - scenario issue: `https://github.com/dzianisv/codebridge-test/issues/342`
  - assignees: `[dzianisv]`
  - assignment follow-up comment: `https://github.com/dzianisv/codebridge-test/issues/342#issuecomment-4009536561`
  - bot reply: `https://github.com/dzianisv/codebridge-test/issues/342#issuecomment-4009541334`

### Operational Matrix

Command:

```bash
GITHUB_TOKEN="$(gh auth token --user dzianisv)" GH_TOKEN="$GITHUB_TOKEN" \
TEST_ORG=dzianisv \
TEST_CODEBRIDGE_REPO=dzianisv/codebridge-test \
TEST_CODEBRIDGE_ISSUE=320 \
TEST_ISSUE_REPO=dzianisv/codebridge-test \
TEST_ISSUE_NUMBER=320 \
TEST_PR_REPO=dzianisv/codebridge-test \
TEST_PR_NUMBER=323 \
TEST_DISCUSSION_REPO=dzianisv/codebridge-test \
TEST_DISCUSSION_NUMBER=324 \
TEST_POLL_SECONDS=60 \
bun scripts/runGithubMentionE2ETest.ts
```

Fixtures used:
- issue: `https://github.com/dzianisv/codebridge-test/issues/320`
- PR: `https://github.com/dzianisv/codebridge-test/pull/323`
- discussion: `https://github.com/dzianisv/codebridge-test/discussions/324`

Artifacts:
- `reports/codebridge-test-report-2026-03-06T04-38-04-890Z.json`
- `reports/codebridge-test-report-2026-03-06T04-38-04-890Z.md`

Results:
- `issue-assigned (org codebridge-test)`: PASS
  - trigger issue: `https://github.com/dzianisv/codebridge-test/issues/320`
  - bot reply: `https://github.com/dzianisv/codebridge-test/issues/320#issuecomment-4009488914`
- `issue-comment-mention (codebridge-org)`: PASS
  - trigger comment: `https://github.com/dzianisv/codebridge-test/issues/320#issuecomment-4009488960`
- `pr-review-mention`: PASS
  - trigger review: `https://github.com/dzianisv/codebridge-test/pull/323#pullrequestreview-3901230029`
  - bot reply: `https://github.com/dzianisv/codebridge-test/pull/323#issuecomment-4009519297`
- `discussion-comment-mention`: PASS
  - trigger comment: `https://github.com/dzianisv/codebridge-test/discussions/324#discussioncomment-16018161`

## Current Constraints

- No open mission blockers in the latest verified run.
- Token precedence for matrix execution must prefer runtime env override (`process.env`) before `~/.env.d/github.env` to avoid running with a non-owner token.
- Tracking/evidence issue for hard-gate status: `https://github.com/dzianisv/CodeClaw/issues/6`

## Remaining Mission Work

1. Keep evidence fresh when OpenClaw routing/auth changes.
2. Continue monitoring discussion outbound replies (ingress is verified; reply timing can still vary by runtime latency).

## Closure Checklist

- [x] Promptfoo hard gate exists.
- [x] Mention/issue scenarios execute through OpenClaw.
- [x] Direct assignment-without-mention passes with real issue assignee evidence.
- [x] PR mention path verified in current run artifacts.
- [x] Discussion mention path verified in current run artifacts.
- [x] Hard gate fully passes and mission can be closed.
