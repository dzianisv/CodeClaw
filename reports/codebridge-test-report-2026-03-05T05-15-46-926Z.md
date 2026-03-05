# CodeClaw GitHub Channel E2E Report

- startedAt: 2026-03-05T05:14:59.129Z
- finishedAt: 2026-03-05T05:15:46.926Z
- appLogin: clawengineer
- botLogins: clawengineer, clawengineer[bot]
- org: VibeTechnologies
- codebridgeRepo: VibeTechnologies/codebridge-test
- bridgeWebhookUrl: https://developed-thesis-wondering-settled.trycloudflare.com/github
- orgInstalled: false

## Installation

- installation 114064405: dzianisv (User) selection=all

## Tests

### issue-assigned (org codebridge-test)
- status: PASS
- marker: e2e-assigned-synthetic-1772687699328
- triggerUrl: https://github.com/dzianisv/AiDocumentsOrganizer/issues/6
- triggerId: 6
- ingressDetected: true
- ingressSessionKeys: hook:github:dzianisv/aidocumentsorganizer:issue:6
- botReplyUrl: https://github.com/dzianisv/AiDocumentsOrganizer/issues/6#issuecomment-4002261083
- botReplyId: 4002261083
- note: Live assignment unsupported for app handle 'clawengineer' on VibeTechnologies/codebridge-test; validated assignment flow via signed synthetic webhook.

### issue-comment-mention (issue)
- status: PASS
- marker: e2e-issue-1772687710581
- triggerUrl: https://github.com/dzianisv/AiDocumentsOrganizer/issues/6#issuecomment-4002261400
- triggerId: 4002261400
- ingressDetected: true
- ingressSessionKeys: hook:github:dzianisv/aidocumentsorganizer:issue:6
- botReplyUrl: https://github.com/dzianisv/AiDocumentsOrganizer/issues/6#issuecomment-4002261912
- botReplyId: 4002261912

### pr-review-mention
- status: PASS
- marker: e2e-pr-review-1772687722461
- triggerUrl: https://github.com/dzianisv/AiDocumentsOrganizer/pull/4#pullrequestreview-3893814446
- triggerId: 3893814446
- ingressDetected: true
- ingressSessionKeys: hook:github:dzianisv/aidocumentsorganizer:pr:4
- botReplyUrl: https://github.com/dzianisv/AiDocumentsOrganizer/pull/4#issuecomment-4002262662
- botReplyId: 4002262662

### discussion-comment-mention
- status: BLOCKED
- marker: e2e-discussion-1772687729598
- triggerUrl: https://github.com/dzianisv/openhaystack-web/discussions/2#discussioncomment-16005407
- triggerId: DC_kwDOKbPgRc4A9Dkf
- ingressDetected: true
- ingressSessionKeys: hook:github:dzianisv/openhaystack-web:discussion:2
- note: Discussion mention ingress validated. Thread reply remains blocked because OpenClaw GitHub outbound target format currently supports issue/PR style owner/repo#number only.

### issue-comment-mention (codebridge-org)
- status: BLOCKED
- marker: e2e-codebridge-org-1772687746378
- triggerUrl: https://github.com/VibeTechnologies/codebridge-test/issues/1#issuecomment-4002263944
- triggerId: 4002263944
- ingressDetected: false
- ingressSessionKeys: none
- note: GitHub App 'clawengineer' is not installed on org 'VibeTechnologies', so webhook delivery from VibeTechnologies/codebridge-test cannot reach OpenClaw yet.
- note: Skipped strict reply expectation because this path is currently blocked.

