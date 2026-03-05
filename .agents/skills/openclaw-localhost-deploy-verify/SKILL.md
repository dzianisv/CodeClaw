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
- `test_issue` (required): GitHub issue URL for mention loop test
- `app_handle` (required): real app handle (example `@clawengineer`)

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
4. Validate live mention loop:
   - Post comment with unique marker `<app_handle> localhost-e2e-<epoch_ms>` to `test_issue`.
   - Confirm bot reply comment appears in same thread from `<app>[bot]`.
   - Confirm marker appears in OpenClaw session logs under `hook:github:<owner>/<repo>:issue:<id>`.
5. Capture artifacts:
   - setup JSON output
   - user comment URL/id
   - bot comment URL/id
   - session key/log path

## Pass criteria
- All localhost checks pass.
- Idempotency checks pass.
- Mention comment triggers bot reply in same issue thread.
