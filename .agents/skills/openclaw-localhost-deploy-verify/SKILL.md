---
name: openclaw-localhost-deploy-verify
description: Run localhost OpenClaw deployment verification including hooks, channel readiness, idempotency, and live GitHub mention loop.
---

# OpenClaw Localhost Deploy Verify

## Purpose
Validate that `setupOpenClawOrchestrator.ts` can provision and re-provision OpenClaw on localhost with GitHub mention flow enabled.

## When to use
- Deployment/setup script changed.
- OpenClaw local gateway/channel behavior changed.
- Need regression proof that localhost setup still works.

## Inputs
- `setup_script` (optional): default `scripts/setupOpenClawOrchestrator.ts`
- `test_issue` (required): GitHub issue URL in `VibeTechnologies/codebridge-test`
- `app_handle` (required): real app handle (example `@clawengineer`)
- `test_discussion` (optional): GitHub discussion URL for discussion mention test
- `test_pr` (optional): GitHub PR URL for PR mention tests

## Protocol
1. Run setup script (real run, not dry-run):
   - `bun <setup_script>`
2. Validate localhost capability:
   - `openclaw gateway status` must show loopback/127.0.0.1.
   - `openclaw config get hooks.enabled --json` => `true`
   - `openclaw config get hooks.mappings --json` includes `github` -> `github-mentions.ts`
   - `openclaw channels status --json` shows `channels.github.running=true`
3. Validate idempotency:
   - Capture `OPENCLAW_HOOKS_TOKEN` before and after second run; must be stable.
   - Capture transform hash before and after second run; must be unchanged if content unchanged.
4. Validate live GitHub channel flows:
   - `T1 issue assigned`:
     - Assign `test_issue` to the app account (`<app_handle>` without `@`).
     - Confirm OpenClaw receives the event and bot replies in the same issue thread.
     - Confirm hook session key shape `hook:github:<owner>/<repo>:issue:<id>`.
   - `T2 issue mention comment`:
     - Post comment with unique marker `<app_handle> localhost-issue-mention-<epoch_ms>` to `test_issue`.
     - Confirm bot reply comment appears in the same issue thread from `<app>[bot]`.
     - Confirm marker appears in OpenClaw session logs under `hook:github:<owner>/<repo>:issue:<id>`.
   - `T3 discussion mention comment` (optional):
     - Post comment with unique marker `<app_handle> localhost-discussion-mention-<epoch_ms>` to `test_discussion`.
     - Confirm OpenClaw ingests `discussion_comment` event and produces a reply/ack path as configured.
     - Confirm hook session key shape `hook:github:<owner>/<repo>:discussion:<id>`.
   - `T4 PR mention conversation` (optional):
     - Post PR issue-comment mention `<app_handle> localhost-pr-comment-<epoch_ms>` on `test_pr`.
     - Post PR review-comment or submitted-review-body mention `<app_handle> localhost-pr-review-<epoch_ms>` on `test_pr`.
     - Confirm bot replies in PR thread and hook sessions use `hook:github:<owner>/<repo>:pr:<id>`.
5. Capture artifacts for each test:
   - setup JSON output
   - user trigger URL/id
   - bot reply URL/id
   - session key/log path

## Pass criteria
- All localhost checks pass.
- Idempotency checks pass.
- `T1` issue-assigned event triggers OpenClaw and in-thread bot response.
- `T2` issue mention triggers OpenClaw and in-thread bot response.
- If configured, `T3` discussion mention is ingested with correct discussion session key.
- If configured, `T4` PR mention paths (issue-comment and review/review-comment) trigger OpenClaw with PR session keys and thread replies.
