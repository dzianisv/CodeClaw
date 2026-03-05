---
name: github-mention-e2e-playwriter
description: End-to-end protocol for validating GitHub mention ingestion into OpenClaw and bot replies back to the same GitHub thread.
---

# GitHub Mention E2E (Playwriter)

## Purpose
Run an end-to-end validation that GitHub mentions to the configured app handle are ingested by OpenClaw and replied back to the same GitHub thread by the app bot account.

## When to use
- You changed OpenClaw GitHub hook/channel setup.
- You changed mention transform logic.
- You need a production-like regression check.

## Inputs
- `target_url` (required): Full GitHub issue/discussion/PR URL for the selected test case.
- `app_handle` (required): Mention handle, e.g. `@clawengineer`.
- `bridge_script` (optional): Defaults to `scripts/start-clawengineer-webhook-bridge.ts`.
- `timeout_seconds` (optional): Defaults to `180`.
- `test_case` (required): one of:
  - `issue-assigned`
  - `issue-comment-mention`
  - `discussion-comment-mention`
  - `pr-comment-mention`
  - `pr-review-mention`

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
3. Trigger selected test case in browser:
   - `issue-assigned`:
     - Navigate to `target_url` (issue).
     - Assign issue to app account (`<app_handle>` without `@`).
   - `issue-comment-mention`:
     - Navigate to `target_url` (issue).
     - Add comment: `<app_handle> <marker>`.
     - Submit comment.
   - `discussion-comment-mention`:
     - Navigate to `target_url` (discussion).
     - Add comment: `<app_handle> <marker>`.
     - Submit comment.
   - `pr-comment-mention`:
     - Navigate to `target_url` (PR Conversation tab).
     - Add comment: `<app_handle> <marker>`.
     - Submit comment.
   - `pr-review-mention`:
     - Navigate to `target_url` (PR Files changed tab).
     - Add review comment or review summary body containing `<app_handle> <marker>`.
     - Submit review.
4. Validate ingestion:
   - Poll OpenClaw session logs for marker/event and expected session key shape:
     - issue-assigned / issue-comment-mention: `hook:github:<owner>/<repo>:issue:<id>`
     - discussion-comment-mention: `hook:github:<owner>/<repo>:discussion:<id>`
     - pr-comment-mention / pr-review-mention: `hook:github:<owner>/<repo>:pr:<id>`
5. Validate GitHub reply:
   - In browser, refresh thread until a new comment/reply from `<app_handle>[bot]` (or expected app bot login) appears.
   - Confirm reply text references event/request context.
6. Capture evidence:
   - Record:
     - test_case
     - marker
     - target URL
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
