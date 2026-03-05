# CodeClaw

OpenClaw localhost deployment helpers for GitHub App mention orchestration.

## Contents
- `scripts/setupOpenClawOrchestrator.ts`
  - Non-interactive localhost setup for OpenClaw gateway/model/hooks/channels.
  - Provisions GitHub mention hook transform and validates localhost readiness.
- `scripts/start-clawengineer-webhook-bridge.ts`
  - Starts local relay + Cloudflare tunnel and patches GitHub App webhook URL.
- `.agents/skills/github-mention-e2e-playwriter/SKILL.md`
  - E2E protocol for mention -> OpenClaw -> GitHub app reply validation.
- `.agents/skills/openclaw-localhost-deploy-verify/SKILL.md`
  - Repeatable localhost deploy + idempotency + live mention verification protocol.

## Prerequisites
- `openclaw`, `bun`, `launchctl`, `gh`, `cloudflared`
- `~/.openclaw/.env` with GitHub App values (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_APP_WEBHOOK_SECRET`)
- Azure model credentials in env (`AZURE_API_KEY` and `AZURE_BASE_URL`)

## Run
```bash
bun scripts/setupOpenClawOrchestrator.ts
```

## Refresh webhook bridge
```bash
bun scripts/start-clawengineer-webhook-bridge.ts
```
