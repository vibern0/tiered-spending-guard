# Task 2 implementer report

Status: DONE

## Implemented

- Added the closed `ordinary-usdc-recycle-continuation-v1` proposal, approval, authorization, attachment, and admission module.
- Consumed the genuine Task 1 opaque source/certificate and genuine prior proposal/approval lineage.
- Rebuilt only old rows 3–19 through a private literal 17-row mapping. Kept the two confirmed predecessor rows as explicit replay/dependency bridges.
- Recomputed and checked Safe transaction hashes and Delay queue/monitoring fingerprints.
- Bound `currentCheckpoint` and `minimumOuterNonce` into the proposal, approval, storage, and every action commitment.
- Copied the complete predecessor observer unchanged and rejected refreshed, duplicated, flagged, or otherwise mutated observer input.
- Enforced the closed aggregate budget: known charges `124953955544`, remaining allowance `15955630044456`, new reservation `12080584000000`, unused allowance `3875046044456`, and maximum phase outlay `143241710272986` wei.
- Added explicit approval fields `repairAuthority: "NONE"` and the exact shared budget charges.
- Added the fixed 1–5 / 6–10 / 11–14 / 15–17 admission groups and fresh four-bound remaining-time checks.

## TDD evidence

### RED

Command:

```text
cd packages/security-core && npx hardhat test test/unit/security/ordinary-usdc-recycle-continuation-proposal.test.ts
```

Result: exit 1. Expected failure before production implementation:

```text
Error: Cannot find module '../../../scripts/live/ordinary-scenario-usdc-recycle-continuation-proposal'
Require stack:
- .../test/unit/security/ordinary-usdc-recycle-continuation-proposal.test.ts
```

The new focused test loaded the requested public interface, and the interface did not yet exist.

### GREEN

Focused command:

```text
cd packages/security-core && npx hardhat test test/unit/security/ordinary-usdc-recycle-continuation-proposal.test.ts
```

Result: exit 0:

```text
8 passing (380ms)
```

Final affected command:

```text
cd packages/security-core && npx hardhat test test/unit/security/ordinary-usdc-recycle-continuation-proposal.test.ts test/unit/security/ordinary-usdc-recycle-continuation-certificate.test.ts test/unit/security/ordinary-usdc-successor-proposal.test.ts test/unit/security/ordinary-scenario-hashless-continuation.test.ts
```

Result: exit 0:

```text
31 passing (943ms)
```

The run covered the new proposal, the genuine Task 1 certificate, the prior USDC proposal, and the old continuation proposal. Output contained no warnings or failures.

## Additional verification

- `git diff --cached --check`: exit 0.
- Repository-wide `npx tsc --noEmit -p tsconfig.json`: exit 2 on existing dependency, legacy, and unrelated repository errors. It also exposed one comparison in the new test between `bigint` and the certificate's serialized timestamp; that new error was corrected before the final affected run. The repository-wide command remains red on the pre-existing errors.
- No existing proposal, certificate, fixture, plan, spec, ledger, live journal, dependency, Solidity, signer, executor, adapter, CLI, or report implementation was changed.

## Files changed

- `packages/security-core/scripts/live/ordinary-scenario-usdc-recycle-continuation-proposal.ts`
- `packages/security-core/test/unit/security/ordinary-usdc-recycle-continuation-proposal.test.ts`

## Self-review

- Re-read the task brief against the exported interfaces, literal catalog, commitment binding, aggregate accounting, approval exclusions, and admission boundaries.
- Checked that the production module exports no generic action renamer, suffix, retry, or start-index mechanism.
- Checked that all authority objects remain runtime opaque and content-bound through WeakMaps.
- Checked mutations for suffixes, commitments, checkpoint, cap reset, netting, missing invalidation cost, 31m refill, overflow, source/certificate cloning, old approval reuse, observer refresh/duplication, and future-review fields.
- No in-scope defects remained after self-review.

## Commit

`e8678fb feat: bind closed USDC recycle continuation`

## Concerns

None within Task 2 scope. The repository-wide TypeScript baseline remains red as described above; the requested affected suites are green.

## Fix round 1 — literal catalog and opaque storage

Review resolution:

- Preserved strict deadline and receiver-expiry rejection for all four `assertUsdcRecycleContinuationAdmission` phases. The reviewer withdrew the deadline finding because these phases admit only new operations; later historical parsing/store/report and exact known-hash reconciliation use separate non-materializing paths.
- Replaced the generated prefix replacement with 17 explicit private `{ oldId, newId, dependencies }` catalog entries.
- Replaced test-side suffix generation and dependency references with complete literal IDs.
- Added a private unique-symbol brand to `UsdcRecycleContinuationStorage`.
- Changed storage `actions` to a deeply read-only collection of read-only records while keeping structural attached-storage validation for serialized journal inputs.
- Added runtime checks that the attached storage, action collection, and action records are frozen and reject mutation.

Focused command:

```text
cd packages/security-core && npx hardhat test test/unit/security/ordinary-usdc-recycle-continuation-proposal.test.ts
```

Result: exit 0:

```text
8 passing (370ms)
```

Affected regression command:

```text
cd packages/security-core && npx hardhat test test/unit/security/ordinary-usdc-recycle-continuation-proposal.test.ts test/unit/security/ordinary-usdc-recycle-continuation-certificate.test.ts test/unit/security/ordinary-usdc-successor-proposal.test.ts test/unit/security/ordinary-scenario-hashless-continuation.test.ts
```

Result: exit 0:

```text
31 passing (939ms)
```

Diff verification:

```text
git diff --check
```

Result: exit 0, no output.

Fix commit:

`e3ac3c3 fix: close recycle proposal catalog types`

Fix-round concerns: none.
