### Spec Compliance

- ❌ Issues found: the implementation does not freeze or authenticate the complete predecessor `UsdcSuccessorSource` context. `sourceHashValue` records only five hashes from `source.prior.original`, `source.prior.recovery`, and `source.prior.recoveryApproval`, while `assertSource` authenticates only the later successor certificate/proposal/approval capabilities (`packages/security-core/scripts/live/ordinary-scenario-usdc-recycle-continuation-certificate.ts:178-207`). This misses the binding requirement to freeze the full source/old opaque contexts and contradicts the call-graph claim that the complete original/recovery lineage is required (`packages/security-core/docs/security/call-graph.md:127`).
- ⚠️ Cannot verify from diff: the two production RPC identities are fixed by later CLI work; Task 1 correctly consumes a two-provider interface but does not construct those providers.

### Strengths

- The approved approval-body extension preserves the existing opaque approval object and serialization shape, stores the validated public document in a private `WeakMap`, rechecks its content hash on access, returns a deep-frozen defensive clone, and rejects structural clones (`packages/security-core/scripts/live/ordinary-scenario-usdc-successor-proposal.ts:34-35,125-141`; regression coverage at `packages/security-core/test/unit/security/ordinary-usdc-successor-proposal.test.ts:118-129`).
- The certificate separates the fixed source-byte SHA from the structural source hash, snapshots a direct stable file before proof, rereads it after provider evidence, and restricts initial versus pinned descendants (`packages/security-core/scripts/live/ordinary-scenario-usdc-recycle-continuation-certificate.ts:125-168,195-209,396-402`).
- Canonical evidence handling is strong: min-head-minus-five selection, exact controlled state, `snapshot == latest == pending >= 870`, two-provider equality, receipt-block rereads, six-confirmation checks, exact old type-2 receipts/poststates, and the fixed DIFFERENT-869 receipt/cost/poststate are all enforced (`packages/security-core/scripts/live/ordinary-scenario-usdc-recycle-continuation-certificate.ts:244-322,404-423`).
- Focused named-risk check — legacy sender recovery: the unchanged production provider reconstructs the legacy signed envelope from `r/s/v`, recovers its sender, and only then exposes `from`; the certificate is therefore not trusting raw RPC `from` (`packages/security-core/scripts/live/ordinary-scenario-usdc-successor-cli.ts:158-166`).
- Focused named-risk check — new approval accessor surface: repository call-site search found only the recycle certificate and its regression test, so the readonly accessor has not been adopted as authority elsewhere.
- The vetted fixture helper independently reconstructs the canonical legacy nonce-869 transaction and checks recovered sender equality (`packages/security-core/test/support/usdc-recycle-continuation-fixture.ts:135-157`). The reported focused and regression run is complete and clean: 37 passing, 0 failing; it was not rerun per reviewer instructions.

### Issues

#### Critical (Must Fix)

None.

#### Important (Should Fix)

- `packages/security-core/scripts/live/ordinary-scenario-usdc-recycle-continuation-certificate.ts:178-207` — `source.prior` is not authenticated as the genuine predecessor context. `assertOpaqueAuthority` proves only the old successor certificate and proposal-bound approval; it never invokes the predecessor lineage/authorization assertions that the old certificate uses. Meanwhile `sourceHashValue` replaces the full `original`, `recovery`, and `recoveryApproval` contexts with five header hashes. A caller can clone `source.prior`, alter a non-hashed field such as `original.recipient`, retain the genuine later certificate/proposal/approval, and leave `hashUsdcRecycleContinuationSource` unchanged; those altered fields then flow into `validatePrimary` and `expectedCurrentState` at lines 211-252. This breaks the required full-source freeze and makes the certificate semantics depend on unbranded caller data. Reassert the original→recovery lineage and recovery approval capability, bind the complete canonical public predecessor contexts into the source hash, and add adversarial tests for cloned/mutated `original`, `recovery`, and `recoveryApproval` objects.

#### Minor (Nice to Have)

None.

### Assessment

**Task quality:** Needs fixes

**Reasoning:** The file, canonical-chain, approval-body, and historical-evidence boundaries are carefully implemented, but the missing predecessor-context authentication violates an explicit Task 1 security property and must be closed before this certificate can be trusted.
