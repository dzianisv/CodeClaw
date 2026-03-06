# AGENTS

## Acceptance Criteria (Mandatory)
- Mission is **NOT** complete unless the evaluation test passes end-to-end.
- `scripts/eval-openclaw.ts` must produce a passing outcome for required evaluation scenarios.
- Timeouts, infrastructure instability, webhook delivery gaps, or missing bot replies are **NOT** acceptable exceptions.
- If evaluation is failing for any reason, status must remain **IN PROGRESS** until fixed and re-verified.

## Verification Requirement
- Required proof before completion:
  - Exact command used.
  - Report artifact path(s).
  - Pass/fail summary with per-case status.
  - Canonical GitHub URLs for every evaluated trigger/artifact:
    - Issue URL for issue-based scenarios.
    - PR URL for PR review scenarios.
    - Discussion URL for discussion scenarios.
    - Comment/review URL when the trigger is a comment/review event.
- Do not mark complete on “script ran successfully” if eval assertions failed.
