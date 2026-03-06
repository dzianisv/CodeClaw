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
bun scripts/eval-openclaw.ts --repo dzianisv/codebridge-test --timeout 180 --poll 10
```

Result:
- `4 passed, 0 failed, 0 errors`

Artifacts:
- `reports/eval-config-2026-03-06T03-26-38-919Z.json`
- `reports/eval-raw-2026-03-06T03-26-38-919Z.json`
- `reports/eval-output-2026-03-06T03-26-38-919Z.json`

Per-case status:
- `python-hello-world`: PASS
  - issue: `https://github.com/dzianisv/codebridge-test/issues/312`
  - trigger comment: `https://github.com/dzianisv/codebridge-test/issues/312#issuecomment-4009277842`
  - bot reply: `https://github.com/dzianisv/codebridge-test/issues/312#issuecomment-4009279309`
- `typescript-bun-hello`: PASS
  - issue: `https://github.com/dzianisv/codebridge-test/issues/313`
  - trigger comment: `https://github.com/dzianisv/codebridge-test/issues/313#issuecomment-4009277911`
  - bot reply: `https://github.com/dzianisv/codebridge-test/issues/313#issuecomment-4009280704`
- `research-gpt-release`: PASS
  - issue: `https://github.com/dzianisv/codebridge-test/issues/314`
  - trigger comment: `https://github.com/dzianisv/codebridge-test/issues/314#issuecomment-4009277993`
  - bot reply: `https://github.com/dzianisv/codebridge-test/issues/314#issuecomment-4009282596`
- `direct-assignment-no-mention`: PASS
  - `trigger_type=assignment`
  - `trigger_mode=direct`
  - `assignment_trigger_check=pass`
  - scenario issue: `https://github.com/dzianisv/codebridge-test/issues/315`
  - assignees: `[dzianisv]`
  - assignment follow-up comment: `https://github.com/dzianisv/codebridge-test/issues/315#issuecomment-4009292282`
  - bot reply: `https://github.com/dzianisv/codebridge-test/issues/315#issuecomment-4009296341`

### Operational Matrix

Command:

```bash
TEST_POLL_SECONDS=30 bun scripts/runGithubMentionE2ETest.ts
```

Artifacts:
- `reports/codebridge-test-report-2026-03-06T03-28-49-215Z.json`
- `reports/codebridge-test-report-2026-03-06T03-28-49-215Z.md`

Results:
- `issue-assigned (org codebridge-test)`: PASS
  - trigger issue: `https://github.com/VibeTechnologies/codebridge-test/issues/1`
- `issue-comment-mention (codebridge-org)`: PASS
  - trigger comment: `https://github.com/VibeTechnologies/codebridge-test/issues/1#issuecomment-4009299058`
- `pr-review-mention`: BLOCKED (`TEST_PR_NUMBER` not configured)
- `discussion-comment-mention`: BLOCKED (`TEST_DISCUSSION_NUMBER` not configured)

## Current Constraints

- Hard gate is currently green.
- PR and discussion matrix paths remain `BLOCKED` in this run because `TEST_PR_NUMBER` and `TEST_DISCUSSION_NUMBER` are unset.
- Tracking/evidence issue for hard-gate status: `https://github.com/dzianisv/CodeClaw/issues/6`

## Remaining Mission Work

1. Configure executable PR/discussion fixtures and re-run matrix with both paths active.
2. Keep PR/issue status aligned with artifacts and gate outcomes.
3. Keep hard-gate proof fresh when trigger routing changes.

## Closure Checklist

- [x] Promptfoo hard gate exists.
- [x] Mention/issue scenarios execute through OpenClaw.
- [x] Direct assignment-without-mention passes with real issue assignee evidence.
- [ ] PR mention path verified in current run artifacts.
- [ ] Discussion mention path verified in current run artifacts.
- [x] Hard gate fully passes and mission can be closed.
