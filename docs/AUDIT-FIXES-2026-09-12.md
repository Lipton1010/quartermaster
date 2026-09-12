# Audit fixes, 12 September 2026

The four defects reproduced on `6274ef6` are fixed in the local `feat/system-agnostic` working tree. Nothing has been merged, pushed, published, or installed into a production world.

| Finding | Result | Regression coverage |
| --- | --- | --- |
| F1: transfer versus GM hide/reveal race | Transfers, hide/reveal, and relevant deletes share an Item mutation lock. Transfers refresh their source after waiting; player requests recheck authorization. The Item lock is acquired before the separate storage/logging lock. | Transfer versus hide in both orders, staged delete versus transfer, ownership changes while queued, and preservation of the low-level GM fixture API. |
| F2: cancelled currency writes consume staged loot | D&D and PF2e adapters verify normal write results; the currency facade also verifies native/custom balances. Cancelled reveals retain their entries and can retry safely. Partial writes retain the staged entry, private recovery evidence, and a durable result that blocks retries. | Cancellation, partial writes, and errors after successful writes across D&D 5e, PF2e, and the generic/custom currency path. Retry and cache-reset cases included. |
| F3: create succeeds then throws | Transfers and staging moves inspect the predicted destination ID after creation errors and complete the move when it exists. Source-delete failures still compensate; failed compensation preserves full recovery data. | Cancellation, errors before/after create, compensation, failed compensation, and hide/reveal/staging creation. |
| F4: applied currency changes reported as failed after log errors | Currency and resource mutations preserve their committed success result when the commit log fails. They return a finalization warning and attempt a private recovery record. The coordinator stores the committed result for replay. | Both currency and resources, including recovery-log failure and replay after clearing the memory cache. |

## Verification

- `npm test`: **141 passed, 0 failed**, including **24 new regression tests** in `tests/audit-regressions.test.mjs`.
- Syntax checks: **86 JavaScript files** passed.
- Release metadata and system-boundary checks passed.
- `git diff --check` passed.
- Updated older adapter/currency mocks to persist their writes. Their former no-op implementations could not detect a falsely acknowledged balance change.

Tests use the actual branch modules with in-memory Foundry document doubles and controlled concurrency/failure injection. The live Foundry matrix, UI walkthroughs, and restart checks have not been rerun for this working tree. Historical matrix results remain attached to the previous package.

The existing `artifacts/system-agnostic/module.zip` remains the old `48c4af2f…` candidate. It does not contain these fixes. Package rebuilding, live validation, and release approval are separate from this local code change.
