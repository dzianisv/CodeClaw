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

Commands:

```bash
set -a; source ~/.env.d/github.env >/dev/null 2>&1; set +a
bun build --target=bun ./scripts/eval-openclaw.ts --outfile /tmp/eval-openclaw.js
GITHUB_TOKEN="$GITHUB_TOKEN" GH_TOKEN="$GITHUB_TOKEN" \
bun scripts/eval-openclaw.ts --repo dzianisv/codebridge-test --timeout 180 --poll 10
```

Result:
- `3 passed, 1 failed, 0 errors`
- Mission status: **IN PROGRESS** (hard gate not green)

Artifacts:
- `reports/eval-config-2026-03-06T05-36-52-557Z.json`
- `reports/eval-raw-2026-03-06T05-36-52-557Z.json`
- `reports/eval-output-2026-03-06T05-36-52-557Z.json`

Per-case status:
- `python-hello-world`: PASS
  - issue: `https://github.com/dzianisv/codebridge-test/issues/396`
  - trigger comment: `https://github.com/dzianisv/codebridge-test/issues/396#issuecomment-4009695672`
  - bot reply: `https://github.com/dzianisv/codebridge-test/issues/396#issuecomment-4009697242`
- `typescript-bun-hello`: PASS
  - issue: `https://github.com/dzianisv/codebridge-test/issues/397`
  - trigger comment: `https://github.com/dzianisv/codebridge-test/issues/397#issuecomment-4009695751`
  - bot reply: `https://github.com/dzianisv/codebridge-test/issues/397#issuecomment-4009699330`
- `research-gpt-release`: PASS
  - issue: `https://github.com/dzianisv/codebridge-test/issues/398`
  - trigger comment: `https://github.com/dzianisv/codebridge-test/issues/398#issuecomment-4009695846`
  - bot reply: `https://github.com/dzianisv/codebridge-test/issues/398#issuecomment-4009701276`
- `direct-assignment-no-mention`: FAIL (expected hard gate until platform is fixed)
  - `trigger_type=assignment`
  - `trigger_mode=failed`
  - `assignment_trigger_check=fail`
  - scenario issue: `https://github.com/dzianisv/codebridge-test/issues/399`
  - assignees: `[]`
  - assignment API evidence: `403 Must have admin rights to Repository` for `clawengineer` and `clawengineer[bot]`
  - bot reply: none within timeout

### Operational Matrix

Last verified artifact set (prior run):
- `reports/codebridge-test-report-2026-03-06T04-38-04-890Z.json`
- `reports/codebridge-test-report-2026-03-06T04-38-04-890Z.md`

Current focus remains the hard-gate blocker above; matrix refresh will be rerun after assignment-trigger platform fix.

## Current Constraints

- GitHub assignment API in `dzianisv/codebridge-test` cannot assign `clawengineer`/`clawengineer[bot]` with current permissions.
- `docs/testing.md` forbids synthetic assignment fallback as a waiver; assignment case must stay FAIL until real app assignment works.
- Tracking/evidence issue for hard-gate status: `https://github.com/dzianisv/CodeClaw/issues/6`

## Remaining Mission Work

1. Fix platform/config so app identity is directly assignable in `dzianisv/codebridge-test`.
2. Re-run hard eval until `4 passed, 0 failed, 0 errors`.
3. Refresh operational matrix artifacts after hard gate is green.

## Closure Checklist

- [x] Promptfoo hard gate exists.
- [x] Mention/issue scenarios execute through OpenClaw.
- [ ] Direct assignment-without-mention passes with real issue assignee evidence.
- [x] PR mention path verified in artifacts.
- [x] Discussion mention path verified in artifacts.
- [ ] Hard gate fully passes and mission can be closed.
