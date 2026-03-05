# Mission Status

## Objective
- Ensure `scripts/eval-openclaw.ts` does not report PASS when the direct assignment trigger is not real.
- Keep mission status accurate and evidence-driven.

## Current Status
- **IN PROGRESS** (as of 2026-03-05)
- Reason: direct assignment to `clawengineer[bot]` is not actually happening in `dzianisv/codebridge-test`, and hard eval now correctly fails this case.

## Latest Verification
- Command:
```bash
bun scripts/eval-openclaw.ts --repo dzianisv/codebridge-test --timeout 180 --poll 10
```
- Promptfoo summary: **3 passed, 1 failed, 0 errors**
- Failing case: `direct-assignment-no-mention`

## Evidence
- Eval config: `reports/eval-config-2026-03-05T22-54-00-990Z.json`
- Eval raw: `reports/eval-raw-2026-03-05T22-54-00-990Z.json`
- Eval output: `reports/eval-output-2026-03-05T22-54-00-990Z.json`
- Direct assignment scenario issue: `https://github.com/dzianisv/codebridge-test/issues/240`
  - `assignees=[]`
  - timeline contains no `assigned` event for the bot

## Code Changes Applied
- `scripts/eval-openclaw.ts`
  - Removed synthetic assignment success path.
  - Added strict assignee verification from issue state.
  - Assignment case now records fail state without aborting the run.
  - Disabled synthetic assignment retry in timeout flow.
- `docs/testing.md`
  - Updated hard gate rules: assignment trigger must be real/direct and synthetic assignment fallback is not acceptable.
