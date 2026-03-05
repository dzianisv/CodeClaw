# CodeClaw

OpenClaw localhost deployment helpers for GitHub App mention orchestration.

## Contents
- `scripts/setupOpenClawOrchestrator.ts`
  - Non-interactive localhost setup for OpenClaw gateway/model/hooks/channels.
  - Provisions GitHub mention hook transform and validates localhost readiness.
- `scripts/start-clawengineer-webhook-bridge.ts`
  - Starts local relay + Cloudflare tunnel and patches GitHub App webhook URL.
- `scripts/runGithubMentionE2ETest.ts`
  - Executes mention-channel E2E matrix and writes JSON/Markdown reports under `reports/`.
- `.agents/skills/github-mention-e2e-playwriter/SKILL.md`
  - E2E protocol for mention -> OpenClaw -> GitHub app reply validation.
- `.agents/skills/openclaw-localhost-deploy-verify/SKILL.md`
  - Repeatable localhost deploy + idempotency + live mention verification protocol.
- `.agents/skills/github-mention-e2e-runner/SKILL.md`
  - One-command script-driven E2E test protocol and report generation.

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

## Run E2E Report Matrix
```bash
bun scripts/runGithubMentionE2ETest.ts
```
Optional environment overrides:
- `TEST_POLL_SECONDS` (default `150`)
- `TEST_ORG` / `TEST_CODEBRIDGE_REPO` / `TEST_CODEBRIDGE_ISSUE`
- `TEST_ISSUE_REPO` / `TEST_ISSUE_NUMBER` (defaults to codebridge target)
- `TEST_PR_REPO` / `TEST_PR_NUMBER` (optional; skipped unless `TEST_PR_NUMBER > 0`)
- `TEST_DISCUSSION_REPO` / `TEST_DISCUSSION_NUMBER` (optional; skipped unless `TEST_DISCUSSION_NUMBER > 0`)

Report status codes:
- `PASS` validated end-to-end
- `BLOCKED` external/platform constraint
- `FAIL` unexpected regression
