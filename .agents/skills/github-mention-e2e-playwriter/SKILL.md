# GitHub Mention E2E (Playwriter)

## Purpose
Run an end-to-end validation that GitHub mentions to the configured app handle are ingested by OpenClaw and replied back to the same GitHub thread by the app bot account.

## When to use
- You changed OpenClaw GitHub hook/channel setup.
- You changed mention transform logic.
- You need a production-like regression check.

## Inputs
- `issue_url` (required): Full GitHub issue URL to test.
- `app_handle` (required): Mention handle, e.g. `@clawengineer`.
- `bridge_script` (optional): Defaults to `scripts/start-clawengineer-webhook-bridge.sh`.
- `timeout_seconds` (optional): Defaults to `180`.

## Preconditions
1. OpenClaw gateway is healthy.
2. Hook config is enabled and mapping exists.
3. Browser tab has Playwriter enabled by user.
4. User is logged into GitHub in the browser profile used by Playwriter.

## Protocol
1. Start/refresh bridge:
   - Run bridge script so GitHub App webhook points to current tunnel URL.
   - Keep bridge process alive for the full test.
2. Generate marker:
   - Build unique marker `pw-e2e-<epoch_ms>`.
3. Post mention in browser:
   - Navigate to `issue_url`.
   - Add comment: `<app_handle> <marker>`.
   - Submit comment.
4. Validate ingestion:
   - Poll OpenClaw session logs for `marker` and hook session key shape `hook:github:<owner>/<repo>:issue:<id>`.
5. Validate GitHub reply:
   - In browser, refresh issue comments until a new comment from `<app_handle>[bot]` (or expected app bot login) appears.
   - Confirm reply text references event/request context.
6. Capture evidence:
   - Record:
     - marker
     - issue URL
     - user comment URL/id
     - bot reply URL/id
     - OpenClaw session key
     - pass/fail for each stage

## Expected outputs
- `PASS` if all stages succeed.
- `FAIL` if any stage fails, with failing stage and exact artifact/log excerpt.

## Failure handling
- If mention comment posts but no bot reply:
  - Check bridge logs.
  - Check OpenClaw hook/channel status.
  - Check OpenClaw session `.jsonl` for marker and outbound errors.
- If browser is not authenticated:
  - Fail with explicit auth prerequisite message.
