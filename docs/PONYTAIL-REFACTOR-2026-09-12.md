# Ponytail implementation, 12 September 2026

Implemented on the local `feat/system-agnostic` tree based on `fb0b05c`.

- Seven dialogs use `DialogV2.wait`; cancellation remains distinct from saving an empty note. Form values are read before closing, and persistence is awaited.
- Inventory actions use Foundry's ContextMenu. Compendium actions extend `getItemContextOptions`, preserving native actions and checking active-GM eligibility when the menu opens.
- Seven JSON serializers now import one implementation, preserving sorted keys and JSON handling of undefined values.
- HTML escaping delegates to Foundry with the previous input normalization. The unused compendium escaper is removed.
- Coordinator reverse searches use `Array.findLast` and `Array.findLastIndex`.

Production JavaScript has **434 fewer lines**, including the new shared helper. No dependencies were added.

## Verification

- `npm test`: **149 passed, 0 failed**; syntax checks passed for **88 JavaScript files**. Release metadata and system-boundary checks passed.
- Eight new checks in `tests/native-ui.test.mjs` cover persistence equality, resource results, preference write completion, folder validation, empty notes, cancellation without writes, menu eligibility and compendium routing.
- The installed v13.351 and v14.367 `DialogV2.wait` and `_onSubmit` methods were exercised with EventTarget/DOM doubles. Save, dismissal, false/empty/null results, async callbacks and render callbacks passed. Native HTML escaping and the Item-context hook contract were checked too.
- Local evidence: `artifacts/system-agnostic/audit-2026-09-12/ponytail-test-output.txt` and `ponytail-native-compat.mjs`, relative to the workspace root.
- `git diff --check` passed.

No live-world UI walkthrough or full compatibility matrix was run. The release ZIP was not rebuilt. Nothing was committed, pushed, installed into a world, or published.
