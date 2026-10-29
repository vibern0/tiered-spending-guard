# Task 1 report — closed recycle source and canonical certificate

Status: DONE

Commit: `2b9fcdb056c2c3d84f95be5d20c2f5c4d7fa01cf` (`feat: verify stopped USDC recycle source`)

## TDD evidence

RED command:

```text
cd packages/security-core && npx hardhat test test/unit/security/ordinary-usdc-recycle-continuation-certificate.test.ts
```

Result: failed as expected because `ordinary-scenario-usdc-recycle-continuation-certificate` did not exist.

Final GREEN command:

```text
cd packages/security-core && npx hardhat test \
  test/unit/security/ordinary-usdc-recycle-continuation-certificate.test.ts \
  test/unit/security/ordinary-usdc-successor-certificate.test.ts \
  test/unit/security/ordinary-scenario-hashless-certificate.test.ts \
  test/unit/security/ordinary-usdc-successor-proposal.test.ts
```

Result: 37 passing, 0 failing (7 new certificate tests plus 30 affected regression tests).

`git diff --check` and `git diff --cached --check` both passed before commit.

## Changes

- Added the closed read-only source loader and opaque recycle continuation certificate with exact source-byte/structural bindings, genuine old opaque authority, exact three-file primary evidence, two-provider min-head-minus-five checkpoint, old two-receipt revalidation, exact legacy nonce-869 invalidation, strict serialization, and pinned re-verification.
- Restored the prior certificate/proposal/approval through the existing public APIs using public fixture evidence. The legacy nonce-869 test provider reconstructs its canonical signed transaction and recovers the sender from public `r/s/v`.
- Added an immutable content-bound accessor for the genuine old approval public body. It checks opaque identity and recomputes the retained approval hash; clones and caller mutation cannot gain authority or alter the retained snapshot.
- Added the eight exact vetted public fixtures and adversarial tests for source drift/file hazards, authority cloning, receipt/envelope/poststate/cost mutations, matching-tuple reconciliation, confirmation depth, provider/reorg/checkpoint disagreement, primary proof drift, and pinned-history restoration.
- Updated the call graph with the new non-authorizing evidence boundary.

## Fixture review

The eight fixture SHA-256 values match the approved inputs, including source `3d860cf927ccbdd6cfe45864aa42cd60577f8e7745db046e061613e6d3242dae`, nonce-869 `344220211726cf4febf830c388e5af05b75b68f34a3c115aeb813ebcdcd08b2d`, manifest `e1978a45917c1f0caab4574e4a61460493a1c9a10a979f96860ab2ae5c23ec7b`, ledger `2582059e3f914c16fbf1de029658da992dd0b9e1444384eab11dc0bc4dc92eb9`, and acknowledgement `230b8576b3056ac8480f3e60cf0170e5aed35914195e3426f4c3d3d4a5ffd43d`. Recursive key scanning found no secret or raw signed transaction fields.

## Self-review and concerns

Reviewed the full staged allowlist and security-sensitive source/proposal diffs. No caller boolean, cloned structural authority, summary-only proof, network/RPC access, signing, submission, broadcast, private/config material, or authoritative journal mutation was introduced. Pinned mode preserves the original byte fact and validates only the frozen historical prefix while allowing the specified later sibling/live suffix.

No Task 1 implementation concerns remain. The root-owned plan edit was deliberately excluded from this commit.

## Fix round 1/5 — predecessor lineage authentication

Status: DONE

Commit: `652221768e89843a41b6e90aa7a717e4bf0a4b6b` (`fix: authenticate USDC recycle predecessor lineage`)

Reviewer issue fixed: the recycle source now reasserts the genuine original-to-recovery lineage and opaque recovery approval capability used by the predecessor certificate. Its canonical source hash binds the complete public `original`, `recovery`, and `recoveryApproval` objects instead of five selected header hashes. Cloned/mutated original, recovery, and recovery approval contexts are covered adversarially.

RED command:

```text
cd packages/security-core && npx hardhat test \
  test/unit/security/ordinary-usdc-recycle-continuation-certificate.test.ts \
  --grep exact_partial_source
```

RED result: 0 passing, 1 failing. The changed-recipient clone did not throw at `ordinary-usdc-recycle-continuation-certificate.test.ts:43`, reproducing the review finding.

GREEN command:

```text
cd packages/security-core && npx hardhat test \
  test/unit/security/ordinary-usdc-recycle-continuation-certificate.test.ts \
  test/unit/security/ordinary-usdc-successor-certificate.test.ts \
  test/unit/security/ordinary-scenario-hashless-continuation.test.ts
```

GREEN result: 24 passing, 0 failing. This covers the amended recycle suite, predecessor certificate suite, and predecessor lineage/authorization suite. `git diff --check` and staged diff checks passed. No provider-factory change was made; fixed production provider construction remains Task 4 as recorded by the reviewer.
