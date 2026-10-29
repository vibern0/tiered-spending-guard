### Spec Compliance

- ❌ Issues found: the implementation rejects every phase at the period deadline or receiver expiry, so it cannot admit the explicitly allowed historical/keyless known-hash proofs after those bounds (`packages/security-core/scripts/live/ordinary-scenario-usdc-recycle-continuation-proposal.ts:308`); it derives the new catalog through a generic prefix replacement instead of the required private literal old-row-3–19 → exact-17 mapping (`packages/security-core/scripts/live/ordinary-scenario-usdc-recycle-continuation-proposal.ts:51`); and `UsdcRecycleContinuationStorage` is exported as an ordinary structural type rather than an opaque capability (`packages/security-core/scripts/live/ordinary-scenario-usdc-recycle-continuation-proposal.ts:108`).

### Strengths

- The implementation consumes the opaque Task 1 source/certificate, checks their content binding and the exact current nonce checkpoint, and keeps creation restricted to the clean stopped predecessor (`packages/security-core/scripts/live/ordinary-scenario-usdc-recycle-continuation-proposal.ts:168`).
- Safe transaction hashes and both Delay fingerprints are independently recomputed before descriptor reuse, and each fresh commitment binds the complete descriptor plus `currentCheckpoint` and `minimumOuterNonce` (`packages/security-core/scripts/live/ordinary-scenario-usdc-recycle-continuation-proposal.ts:192`, `packages/security-core/scripts/live/ordinary-scenario-usdc-recycle-continuation-proposal.ts:203`, `packages/security-core/scripts/live/ordinary-scenario-usdc-recycle-continuation-proposal.ts:208`).
- The proposal closes the gas and principal accounting with the required old charge, 869 invalidation charge, remaining allowance, continuation reservation, separate gross USDC directions, and phase ceiling (`packages/security-core/scripts/live/ordinary-scenario-usdc-recycle-continuation-proposal.ts:212`).
- Approval parsing is exact-shape, hash-bound, proposal-bound, checkpoint-bound, commitment-bound, one-attempt, and explicitly excludes repair authority (`packages/security-core/scripts/live/ordinary-scenario-usdc-recycle-continuation-proposal.ts:265`).
- The fresh four-bound remaining-time calculation, group budgets, and strict queue margin are otherwise implemented directly (`packages/security-core/scripts/live/ordinary-scenario-usdc-recycle-continuation-proposal.ts:310`, `packages/security-core/scripts/live/ordinary-scenario-usdc-recycle-continuation-proposal.ts:315`).
- Reported TDD evidence is clean: focused RED was the missing module; focused GREEN was 8 passing; affected proposal/certificate/continuation suites were 31 passing with no warnings. Per review instructions, tests were not rerun.

### Issues

#### Critical (Must Fix)

- None.

#### Important (Should Fix)

- `packages/security-core/scripts/live/ordinary-scenario-usdc-recycle-continuation-proposal.ts:308`: unconditional deadline and receiver-expiry rejection applies before action/phase-specific handling. This contradicts the required exception for historical/keyless known-hash proof admission after D/expiry and can prevent the closed scenario from recording its terminal non-authorizing proofs. Classify those exact proof actions explicitly and allow only their keyless known-hash path after the bounds; retain the hard stop for review, new private materialization, signing, and broadcast. Add exact post-D and post-expiry positive tests plus negative tests for every materializing phase.
- `packages/security-core/scripts/live/ordinary-scenario-usdc-recycle-continuation-proposal.ts:51`: `OLD_IDS.map(...replace(...))` is a generic renaming rule. The brief requires a private literal mapping and globally forbids a generic suffix mechanism, because catalog closure must remain reviewable row by row. Replace this with 17 explicit `{ oldId, newId, dependencies }` entries and validate/rebuild from those entries. Make the test assert literal IDs directly rather than generating them from the same naming convention (`packages/security-core/test/unit/security/ordinary-usdc-recycle-continuation-proposal.test.ts:25`).
- `packages/security-core/scripts/live/ordinary-scenario-usdc-recycle-continuation-proposal.ts:108`: `UsdcRecycleContinuationStorage` has no private brand and its `actions` member is typed as a mutable `Array` (`packages/security-core/scripts/live/ordinary-scenario-usdc-recycle-continuation-proposal.ts:123`). Callers can structurally counterfeit the exported storage type and mutate its action collection at compile time, contrary to the requested opaque storage interface. Add a private unique-symbol brand and use a deeply readonly action collection; preserve the existing structural revalidation boundary for serialized journal loading.

#### Minor (Nice to Have)

- None.

### Assessment

**Task quality:** Needs fixes

**Reasoning:** The implementation correctly binds the genuine lineage, transaction identities, checkpoint, approval, and closed budget, and its reported affected suites are clean. The unconditional time cutoff breaks an explicit terminal-proof capability, while the generated ID mapping and structural storage type miss two deliberate closure requirements.

### Scoped Clarification

- **Finding at `ordinary-scenario-usdc-recycle-continuation-proposal.ts:308` withdrawn.** The four `assertUsdcRecycleContinuationAdmission` phases are gates for new review/scenario/private/broadcast operations. No Task 2 path calls this API for historical parsing, report/store reopening, or the exact-one known-hash keyless reconciliation; `parseUsdcRecycleContinuationProposal` and attached-storage validation have no wall-clock freshness gate. Requiring a post-D exception inside this API would broaden new-operation admission and would need an architectural phase/API change not requested by Task 2. The historical/keyless exception remains a later reconciliation-path requirement and must not admit fresh rejection-proof actions, private loading, materialization, signing, broadcast, alerts, or authority.
- **Corrected verdict:** ❌ Issues found; **Task quality: Needs fixes** solely for the literal mapping and opaque/deeply-readonly storage findings at lines 51 and 108/123.
