# Task 5 report — repair lineage after accepted closed22 recovery

Status: complete. No private material, live RPC, signing, simulation, broadcast, new contract, dependency, EOA, or runtime profile override was used.

## Delivered behavior

- Added the runtime-opaque `VerifiedRepairPredecessor` resolver with exactly two cases: the original terminal 38-action lineage at Safe/Delay `14/6/6`, and the exact terminal 19+22 hashless lineage at `15/7/7`.
- The recovered lineage requires the opaque Task 4 continuation proposal and approval, its attached immutable certificate/proposal/approval identity, all 41 canonical evidence rows, the exact 10 historical plus 14 continuation successful live entries, no pending/reverted predecessor, and the closed 22-action catalog.
- New creation and group artifacts bind predecessor kind, action count, prefix, certificate/proposal/approval hashes, observer identity and observer evidence hash. Persisted repair state carries the same binding, and the store permits repair/hashless coexistence only for the closed accepted lineage.
- Rebased the complete repair spine to queue `Safe15/q7 -> Safe16/q8/tx7`, execute `tx8`, old rejection plus new queue `Safe16/q8 -> Safe17/q9`, cancellation `Safe17 -> Safe18/tx9`, and freeze `Safe18 -> Safe19`, terminal `19/9/9`. Safe digests, adapter nonces, receipt indices, queue timing, cancellation observer evidence, and frozen proofs derive from the reviewed action values.
- Preserved the original terminal-38 route and its `14/6/6 -> 18/8/8` behavior.
- Prefix hashing projects the exact predecessor slices, so later repair live entries cannot rewrite it. The regression appends `repair-signer-create`, re-verifies the same prefix, and then creates the shifted group.
- New-lineage accounting preserves original actual gas plus the exact `60000000000001` wei gross principal, continuation receipt gas, and the exact one-wei replacement principal under the unchanged `0.05 ETH` ceiling. External funder deltas and serialized copied counts are not accounting authority.
- The adapter now reconstructs canonical evidence for the stopped historical row and all 22 continuation rows, re-reading every confirmed receipt from the archive client.
- The atomic store preserves immutable repair predecessor/header fields, monotonic cost/action progress, immutable transaction/evidence hashes, and detached hashless continuation progress while allowing later repair entries.
- Updated the security call graph for the recovered repair route and its authorization boundaries.

## Public interfaces, production flags, and limits

```ts
export function verifyRepairPredecessor(
  proposal: OrdinaryScenarioProposal,
  journal: OrdinaryScenarioJournal,
  evidence: readonly RepairPrefixEvidence[],
  lineage?: Readonly<{
    kind: "expired-hashless-continuation-v1";
    continuation: ExpiredHashlessContinuationProposal;
    approval: ExpiredHashlessContinuationApproval;
  }>,
): VerifiedRepairPredecessor;
```

All five repair commands accept the recovered route only when this complete flag set is present:

```text
--continuation-certificate
--continuation-certificate-hash
--continuation-proposal
--continuation-approval
--continuation-approval-hash
```

No partial set is accepted. These flags are translated to Task 4's exact `submit-one` public-loader arguments. Production calls `createHashlessContinuationProductionDependencies`, `parseHashlessContinuationCliArguments`, and `loadHashlessContinuationPublicInputs`; the loader re-verifies the recorded certificate through the two fixed providers and restores opaque proposal/approval capabilities. `assertContinuationObserverFresh` enforces the Task 4 remaining-lifetime budget.

The shared public loader runs before `createOrdinaryScenarioStore`, because the Task 4 read-only source loader intentionally rejects an existing writer lock. After acquiring the repair lease, every command rereads canonical evidence and calls `verifyRepairPredecessor` before creating or using the new repair route. Creation submission performs this check before persisting its exact repair approval.

Existing caps remain unchanged: phase ceiling `50000000000000000` wei; repair approval wait at most `600000ms`; Safe outer gas at most `2000000`; fee and priority fee at most `1000000`; creation gas `740292`; delayed execution gas `1000000`.

## TDD evidence

RED command before implementation:

```text
npx hardhat test test/unit/security/ordinary-scenario-repair.test.ts test/integration/ordinary-scenario-repair.test.ts
```

Relevant result: `20 passing, 3 failing`. The first two new tests failed because `verifyRepairPredecessor` did not exist. The shifted-spine test failed because the implementation still emitted the terminal-38 `14/6/6` repair values. These were the expected missing-interface and stale-lineage failures.

Focused GREEN after implementation:

```text
npx hardhat test test/unit/security/ordinary-scenario-repair.test.ts test/integration/ordinary-scenario-repair.test.ts
```

Result: `24 passing (7s)`. This includes the real local Safe/WebAuthn rotation, identical-hash old rejection/new success, cancellation, and freeze proof.

Affected executor/store/Task 4 GREEN:

```text
npx hardhat test \
  test/unit/security/ordinary-scenario-repair.test.ts \
  test/integration/ordinary-scenario-repair.test.ts \
  test/unit/security/ordinary-scenario-executor.test.ts \
  test/unit/security/ordinary-scenario-executor-cli.test.ts \
  test/unit/security/ordinary-scenario-hashless-certificate.test.ts \
  test/unit/security/ordinary-scenario-hashless-continuation.test.ts \
  test/unit/security/ordinary-scenario-hashless-executor.test.ts \
  test/unit/security/ordinary-scenario-hashless-continuation-cli.test.ts \
  test/integration/ordinary-scenario-hashless-adapter.test.ts
```

Result: `105 passing (8s)` before the final shared-loader-order regression was added; the final focused run above includes that regression and remains green.

Filtered TypeScript check:

```text
npx tsc --noEmit 2>&1 | rg 'scripts/live/ordinary-scenario-(repair|executor)|ordinary-scenario-hashless' || true
```

Result: no matching production diagnostics. The repository-wide TypeScript command still reports unrelated pre-existing test/config diagnostics, including the two existing `ordinary-scenario-executor.test.ts` fixture typing errors.

`git diff --check` passes.

## Files changed

- `packages/security-core/scripts/live/ordinary-scenario-repair.ts`
- `packages/security-core/scripts/live/ordinary-scenario-repair-adapter.ts`
- `packages/security-core/scripts/live/ordinary-scenario-repair-session.ts`
- `packages/security-core/scripts/live/ordinary-scenario-executor.ts`
- `packages/security-core/test/unit/security/ordinary-scenario-repair.test.ts`
- `packages/security-core/docs/security/call-graph.md`
- `.superpowers/sdd/2026-10-28-ordinary-hashless-continuation/task-5-report.md`

## Self-review and limits

- Reviewed the final diff for copied nonce/count authority, loader/lease ordering, growing-journal prefix drift, accounting resets, mutable repair headers, and accidental private/live paths. The creation-submit approval write was moved after the under-lease predecessor revalidation during self-review.
- The existing large single-file repair/executor modules remain structurally dense; this task kept changes within their established boundaries and did not refactor unrelated code.
- The new production route is wired and tested through the shared loader seam without network access. No live command or provider was invoked.
- The parent retains ownership of plan checkboxes and the task ledger.
