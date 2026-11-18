# Task 3 implementer report

## Status

DONE

## Implemented

- Added the closed `usdc-recycle-continuation-v1` execution view and the three requested exports.
- Projected exactly the three confirmed native recovery bridges, two confirmed old USDC successor bridges, and 17 new continuation actions.
- Kept old successor row 3 permanently `signed-simulated`; old hashless and old successor selectors reject once the new sibling is attached.
- Extended the atomic codec/store for structural `UsdcRecycleContinuationStorage` validation, checkpoint/minimum-nonce restoration, immutable old 15-entry prefix, immutable old attachments, monotonic new-only action progress, canonical receipt inclusion, and exact live suffix ordering.
- Accepted `M >= minimumOuterNonce` only before materialization, froze the final materialization block/envelope, allowed ordinary newer heads, and stopped only the new row on a proven frozen-block or pre-outer envelope mismatch.
- Applied strict new-operation review/scenario/private/broadcast admission. Durable known-hash reconciliation remains keyless after the period/receiver deadline and cannot sign, prove a rejection, alert, or rebroadcast.
- Forwarded exact canonical ISO observer bounds for the new adapter view.
- Added an honest chain-31337 Safe/guard/real WebAuthn/ECDSA/Delay integration covering transfer, cancellation, expiry, and ready execution. Fixed Sepolia fixtures remain read-only source/certificate evidence.
- Updated `packages/security-core/docs/security/call-graph.md` for the new execution path.

## TDD evidence

### RED

Command:

```text
cd packages/security-core && npx hardhat test test/unit/security/ordinary-usdc-recycle-continuation-executor.test.ts test/integration/ordinary-usdc-recycle-continuation-adapter.test.ts
```

Expected feature failure:

```text
0 passing (229ms)
5 failing
TypeError: createUsdcRecycleContinuationExecutionView is not a function
Error: ordinary scenario journal has unknown or missing fields
TypeError: executeUsdcRecycleContinuationAction is not a function
```

The tests reached genuine Task 1/2 branded source/proposal/approval fixtures; they failed only because the Task 3 APIs and storage projection were absent.

### GREEN focused

Same command, final result:

```text
8 passing (696ms)
```

### GREEN affected suites

Command:

```text
cd packages/security-core && npx hardhat test test/unit/security/ordinary-scenario-executor.test.ts test/unit/security/ordinary-scenario-hashless-executor.test.ts test/unit/security/ordinary-usdc-successor-executor.test.ts test/unit/security/ordinary-usdc-recycle-continuation-executor.test.ts test/unit/security/ordinary-scenario-adapter.test.ts test/integration/ordinary-scenario-adapter.test.ts test/integration/ordinary-scenario-hashless-adapter.test.ts test/integration/ordinary-usdc-successor-adapter.test.ts test/integration/ordinary-usdc-recycle-continuation-adapter.test.ts
```

Result:

```text
83 passing (3s)
```

Additional checks:

```text
git diff --check
# exit 0, no output

npx tsc --noEmit 2>&1 | rg 'ordinary-scenario-(executor|adapter)\.ts|ordinary-usdc-recycle-continuation-(executor|adapter)\.test\.ts|usdc-recycle-continuation-fixture\.ts' || true
# exit 0, no Task 3 diagnostics
```

The unfiltered repository-wide `npx tsc --noEmit` still reports numerous pre-existing diagnostics in unrelated files; Task 3 files produce none.

## Files changed

- `packages/security-core/scripts/live/ordinary-scenario-executor.ts`
- `packages/security-core/scripts/live/ordinary-scenario-adapter.ts`
- `packages/security-core/test/unit/security/ordinary-usdc-recycle-continuation-executor.test.ts`
- `packages/security-core/test/integration/ordinary-usdc-recycle-continuation-adapter.test.ts`
- `packages/security-core/test/support/usdc-recycle-continuation-fixture.ts`
- `packages/security-core/docs/security/call-graph.md`

## Self-review

- Confirmed no network, private path, key, Sepolia signing/broadcast, authoritative journal, machine approval, dependency, Solidity, plan/spec/ledger, or root-owned live-file change.
- Confirmed new storage decoding validates the full shape before the private branded type is structurally restored.
- Confirmed the source comparison occurs through the locked store load before its own save; later saves compare the frozen prefix to the stable in-memory source and do not reassert a stale raw file snapshot.
- Confirmed old row 3 and the old 16-row tail are byte-structurally frozen once the sibling exists.
- Confirmed durable hashes are reconciled without private callbacks after deadline, and reorg proof affects only the new row.
- No unresolved Task 3 correctness concerns.

## Commit

`4b94312 feat: execute immutable USDC recycle continuation`

## Fix round 1

### Changes

- Classified the exact proven `ordinary scenario selected-block and current funder nonce drift` adapter failure as a permanent recycle-continuation stop. The new row is durably `stopped`; frozen successor row 3 remains `signed-simulated`; no sign or broadcast follows.
- Replaced the attachment smoke test with a real stopped-predecessor flow under the writer lease: compare loaded source, reject a second writer, attach/save once, and reopen from disk without consulting the stale initial loader.
- Added detached-draft, action reset/removal/reorder, mixed-live-suffix, immutable-prefix, persisted-checkpoint/fresh-reopen, canonical-newer-head, post-freeze envelope drift, adapter nonce-drift, and durable-hash-before-sole-31337-broadcast regressions.
- Added keyless known-hash coverage proving receipt inclusion is persisted before an unavailable observer callback, remains pending, and becomes confirmed only after valid confirmation evidence is supplied.
- Split the fixture helper so tests can obtain a genuine authorized but unattached sibling source without weakening the existing approved fixture.

### RED

Command:

```text
cd packages/security-core && npx hardhat test test/unit/security/ordinary-usdc-recycle-continuation-executor.test.ts test/integration/ordinary-usdc-recycle-continuation-adapter.test.ts
```

Result before the executor fix:

```text
8 passing (863ms)
1 failing
AssertionError: expected 'signed-simulated' to equal 'stopped'
```

### GREEN focused

Same command, final result:

```text
14 passing (1s)
```

### GREEN affected suites

Command:

```text
cd packages/security-core && npx hardhat test test/unit/security/ordinary-scenario-executor.test.ts test/unit/security/ordinary-scenario-hashless-executor.test.ts test/unit/security/ordinary-usdc-successor-executor.test.ts test/unit/security/ordinary-usdc-recycle-continuation-executor.test.ts test/unit/security/ordinary-scenario-adapter.test.ts test/integration/ordinary-scenario-adapter.test.ts test/integration/ordinary-scenario-hashless-adapter.test.ts test/integration/ordinary-usdc-successor-adapter.test.ts test/integration/ordinary-usdc-recycle-continuation-adapter.test.ts
```

Result:

```text
89 passing (3s)
```

Additional checks:

```text
npx tsc --noEmit 2>&1 | rg 'ordinary-scenario-(executor|adapter)\.ts|ordinary-usdc-recycle-continuation-(executor|adapter)\.test\.ts|usdc-recycle-continuation-fixture\.ts' || true
# exit 0, no Task 3 diagnostics

git diff --check
# exit 0, no output
```

### Fix-round self-review

- The production change is one exact error classification at the existing permanent-stop boundary; generic provider/private failures still preserve resumability.
- Real-store tests validate atomic attachment and mutations through the production codec/store rather than a context-only stub.
- The adapter drift test exercises the shipped mechanical reader, and the durable-broadcast test uses a real chain-31337 signed EIP-1559 transaction without Sepolia signing or broadcasting.
- Receipt inclusion is asserted on disk before observer confirmation and no private callback, proof, alert, or rebroadcast occurs during known-hash resume.
- No network, private-path, actual-journal, key, Sepolia-signing/broadcasting, machine-approval, root-owned plan/spec/ledger/live-file, dependency, or Solidity change was made.
- No unresolved Task 3 correctness concerns found.
