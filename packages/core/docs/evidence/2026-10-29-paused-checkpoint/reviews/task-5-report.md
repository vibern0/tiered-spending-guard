# Task 5 implementer report

Status: DONE

## Implemented

- Added the closed `usdc-recycle-continuation-v1` repair predecessor without financial repair authority.
- Bound the exact `original19 + native3 + old2 + new17 = 41` semantic lineage, 24 successful live records, Safe/Delay start `15/7/7`, canonical gas/principal facts, effective period, terminal recycle receipts/inclusions/evidence, and frozen old successor row 3.
- Added the literal creation dependency `usdc-recycle-continuation-queue-ready-execute` and retained the existing repair spine ending `19/9/9`.
- Added most-specific all-or-none repair CLI routing through `loadUsdcRecycleContinuationPublicInputs` before the old successor route.
- Extended the production adapter and atomic journal decoder only for the narrow recycle-plus-repair coexistence case.
- Documented the execution path and historical-only expiry behavior in the call graph.
- Added no signer, broadcast, financial approval, network, key, journal, or machine-approval capability.

## TDD evidence

RED command:

`cd packages/security-core && npx hardhat test test/unit/security/ordinary-usdc-recycle-continuation-repair.test.ts`

RED result: exit 3, `0 passing, 3 failing`; all failures reached `repair continuation lineage kind is unsupported`, proving the new closed route was absent.

GREEN command:

`cd packages/security-core && npx hardhat test test/unit/security/ordinary-usdc-recycle-continuation-repair.test.ts test/unit/security/ordinary-scenario-repair.test.ts test/unit/security/ordinary-usdc-recycle-continuation-executor.test.ts test/unit/security/ordinary-usdc-recycle-continuation-cli.test.ts test/integration/ordinary-scenario-repair-usdc-successor.test.ts && git diff --check && git status --short`

GREEN result: exit 0, `60 passing (2s)`; diff check clean; worktree clean.

## Files changed

- `packages/security-core/scripts/live/ordinary-scenario-repair.ts`
- `packages/security-core/scripts/live/ordinary-scenario-repair-session.ts`
- `packages/security-core/scripts/live/ordinary-scenario-repair-adapter.ts`
- `packages/security-core/scripts/live/ordinary-scenario-executor.ts`
- `packages/security-core/test/unit/security/ordinary-usdc-recycle-continuation-repair.test.ts`
- `packages/security-core/test/unit/security/ordinary-usdc-recycle-continuation-cli.test.ts`
- `packages/security-core/docs/security/call-graph.md`

## Self-review

- Existing three predecessor cases remain green.
- The route rejects incomplete recycle flags before invoking a loader and chooses the recycle loader when the complete old-plus-recycle set is present.
- The disk reopen test proves the decoder preserves the first 15 live entries and old row 3 while admitting only the new predecessor kind.
- Source attachments and first 15 live entries are compared to the opaque public-loader source; the stopped row evidence is recomputed from the genuine source rather than accepted from caller evidence.

## Composition follow-up

- Added one composed `runRepairCommand(createRepairCommandRuntime(...))` proof through the actual recycle public loader, genuine opaque source files, actual reviewed-plan reconstruction, production repair adapter, and atomic store attachment/reopen.
- The fixture checks canonical pre-rotation `15/7/7` and post-rotation `16/8/8` state through the production adapter. Sign and broadcast counters remain zero.
- The proof exposed and fixed one exact production gap: post-rotation profile verification added obsolete top-level `policy.safeContractSecondary`, rejected by the canonical policy parser. The adapter now replaces only the canonical `secondaries` entry.
- Fixed all new TypeScript diagnostics in the two Task 5 test files. Repository-wide unrelated pre-existing diagnostics remain outside scope.

Follow-up RED command:

`cd packages/security-core && npx hardhat test test/unit/security/ordinary-usdc-recycle-continuation-cli.test.ts --grep "composes the actual recycle loader"`

Follow-up RED results, successively: exit 1 with `USDC recycle continuation live suffix is orphaned, reordered, or mixed`; then exit 1 with `policy.safeContractSecondary is not allowed` after reaching the post-rotation production adapter.

Follow-up GREEN command:

`cd packages/security-core && npx hardhat test test/unit/security/ordinary-usdc-recycle-continuation-repair.test.ts test/unit/security/ordinary-scenario-repair.test.ts test/unit/security/ordinary-usdc-recycle-continuation-executor.test.ts test/unit/security/ordinary-usdc-recycle-continuation-cli.test.ts test/integration/ordinary-scenario-repair-usdc-successor.test.ts && npx tsc --noEmit --pretty false 2>&1 | rg "ordinary-usdc-recycle-continuation-(repair|cli)\\.test\\.ts|ordinary-scenario-repair-adapter\\.ts" || true; git diff --check; git status --short`

Follow-up GREEN result: exit 0, `61 passing (2s)`; filtered Task 5 TypeScript output empty; diff check clean; only the three intended follow-up files modified before commit.

## Commit

`1efb917 feat: verify recycle continuation repair lineage`

Follow-up commit: `bc4db9e test: compose recycle repair production path`

## Review fix round 1

- Rebound every immutable persisted recycle header field to the opaque loader proposal/approval before repair creation: source/certificate/proposal/approval, checkpoint, minimum nonce, period/deadline, commitments, maximum reservation, aggregate known charge, and broadcast-attempt cap.
- Persisted `continuationHeaderHash` in the repair predecessor and made the atomic decoder recompute it on every recycle-plus-repair reopen. Mutating any security field now fails closed after attachment as well as before creation.
- Added table-driven rejection for mutated/forged/mixed source, gas and live-total drift, missing receipt inclusion, old approval drift, period, reservation, and exact 869 aggregate-charge drift.
- Extended the actual loader → production adapter → atomic store command test: fresh creation is rejected after receiver expiry before repository/harness/submit; one exact known pending creation hash remains keylessly observable after expiry with zero signing, broadcast, authority handoff, or alert files.

Round 1 RED command:

`cd packages/security-core && npx hardhat test test/unit/security/ordinary-usdc-recycle-continuation-repair.test.ts --grep "security-relevant persisted"`

Round 1 RED result: exit 1, `0 passing, 1 failing`; the mutated checkpoint header did not throw.

Round 1 GREEN command:

`cd packages/security-core && npx hardhat test test/unit/security/ordinary-usdc-recycle-continuation-repair.test.ts test/unit/security/ordinary-scenario-repair.test.ts test/unit/security/ordinary-usdc-recycle-continuation-executor.test.ts test/unit/security/ordinary-usdc-recycle-continuation-cli.test.ts test/integration/ordinary-scenario-repair-usdc-successor.test.ts && npx tsc --noEmit --pretty false 2>&1 | rg "ordinary-usdc-recycle-continuation-(repair|cli)\\.test\\.ts" || true; git diff --check; git status --short`

Round 1 GREEN result: exit 0, `63 passing (2s)`; filtered new Task 5 test diagnostics empty; diff check clean; five intended files modified before commit.

Round 1 commit: `d572920 fix: bind recycle repair header`
