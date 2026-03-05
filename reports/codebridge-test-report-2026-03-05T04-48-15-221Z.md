# CodeClaw GitHub Channel E2E Report

- startedAt: 2026-03-05T04:45:49.666Z
- finishedAt: 2026-03-05T04:48:15.220Z
- appLogin: clawengineer
- botLogins: clawengineer, clawengineer[bot]
- org: VibeTechnologies
- codebridgeRepo: VibeTechnologies/codebridge-test
- bridgeWebhookUrl: https://creative-pipes-performance-files.trycloudflare.com/github
- orgInstalled: false

## Installation

- installation 114064405: dzianisv (User) selection=all

## Tests

### issue-assigned (org codebridge-test)
- status: FAIL
- ingressDetected: false
- ingressSessionKeys: none
- note: GitHub reports 'clawengineer' is not an assignable user on VibeTechnologies/codebridge-test; app handles cannot be assigned via issues assignee API.

### issue-comment-mention (issue)
- status: PASS
- marker: e2e-issue-1772685949869
- triggerUrl: https://github.com/dzianisv/AiDocumentsOrganizer/issues/6#issuecomment-4002161238
- triggerId: 4002161238
- ingressDetected: true
- ingressSessionKeys: hook:github:dzianisv/aidocumentsorganizer:issue:6
- botReplyUrl: https://github.com/dzianisv/AiDocumentsOrganizer/issues/6#issuecomment-4002161536
- botReplyId: 4002161536

### pr-review-mention
- status: PASS
- marker: e2e-pr-review-1772685955977
- triggerUrl: https://github.com/dzianisv/AiDocumentsOrganizer/pull/4#pullrequestreview-3893668712
- triggerId: 3893668712
- ingressDetected: true
- ingressSessionKeys: hook:github:dzianisv/aidocumentsorganizer:pr:4
- botReplyUrl: https://github.com/dzianisv/AiDocumentsOrganizer/pull/4#issuecomment-4002161869
- botReplyId: 4002161869

### discussion-comment-mention
- status: FAIL
- marker: e2e-discussion-1772685968316
- triggerUrl: https://github.com/dzianisv/openhaystack-web/discussions/2#discussioncomment-16005222
- triggerId: DC_kwDOKbPgRc4A9Dhm
- ingressDetected: true
- ingressSessionKeys: hook:github:dzianisv/openhaystack-web:discussion:2
- note: No bot discussion reply detected within poll timeout.

### issue-comment-mention (codebridge-org)
- status: FAIL
- marker: e2e-codebridge-org-1772686032442
- triggerUrl: https://github.com/VibeTechnologies/codebridge-test/issues/1#issuecomment-4002165285
- triggerId: 4002165285
- ingressDetected: false
- ingressSessionKeys: none
- note: No OpenClaw session log entry found for marker.
- note: No bot issue reply detected within poll timeout.

