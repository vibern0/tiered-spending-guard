# Secondary Signer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hard-coded product-specific step-up role with a primary-plus-secondary signer model where either a Safe-contract secondary or an ECDSA-extension secondary can satisfy the secondary approval.

**Architecture:** Implement the design proposal's recommended Option B. The Vault Safe has three owners at threshold 1: primary passkey, safe-contract secondary, and ECDSA secondary. `TieredSpendingGuard` remains the policy authority: base transfers require the primary Safe contract-signature slot, while step-up and delayed proposals require the primary plus exactly one enabled secondary of the configured kind. Direct Burner NFC support stays out of scope until a separate spike proves documented HaLo signing.

**Tech Stack:** Solidity, TypeScript, Hardhat, viem, Safe 1.5, Safe-native ERC-1271 passkey signatures, EIP-1193 typed-data signatures.

**Spec:** `docs/superpowers/specs/2026-10-01-secondary-signer-design.md`

## Global Constraints

- Preserve one asset-holding Safe.
- Use Option B: owners are `[primaryPasskey, safeContractSecondary, ecdsaSecondary]`, sorted for Safe setup when required by Safe signature ordering.
- Keep Safe threshold 1; guard policy, not Safe threshold, enforces primary plus one secondary.
- Base transfers require exactly the configured primary Safe contract-signature slot and no secondary extension.
- Step-up transfers, delayed proposals, cancellation, freeze, and delayed maintenance require the primary plus one enabled secondary signer.
- A secondary alone, two secondaries without primary, wrong secondary, disabled secondary, duplicate secondary, mixed-kind secondary, approved-hash signature, and arbitrary message path must fail.
- safe-contract secondary uses a second Safe contract-signature slot validated by Safe/ERC-1271.
- ECDSA secondary uses the existing terminal ECDSA extension over the exact Safe transaction hash.
- Do not add `@arx-research/libhalo` or direct Burner NFC support in this plan.
- Preserve exact authorization binding to chain, Safe, destination, value, calldata, operation, gas/refund fields, and nonce.
- Update call graph, signer-provider evaluation, runbook/research wording, and the active implementation-plan supersession notes from Burner-specific to secondary-signer wording.

## Review Focus

- Signature parsing ambiguity: tests must prove duplicate, mixed-kind, trailing, and secondary-only encodings fail.
- Safe owner ordering: topology tests must prove the configured primary and both secondaries are the only owners regardless of sort order.
- Disabled signer state: guard tests must prove a configured but disabled secondary cannot authorize step-up or delayed work.
- Maintenance blast radius: signer repair tests must prove adding or broadening secondary capability remains delayed, while disabling/removal is immediate only when mechanically tightening.
- Offchain role mixups: signer tests must prove passkey and EIP-1193 secondary adapters declare role/kind and cannot silently produce the wrong encoding for a configured role.

---

### Task 1: Plan and Primary/Secondary Policy Surface

**Files:**
- Create: `docs/superpowers/plans/2026-10-01-secondary-signer-design.md`
- Modify: `src/config/policy.ts`
- Modify: `test/unit/policy/classify.test.ts`

**Interfaces:**
- Produces `VaultPolicy.primary`, `VaultPolicy.secondaries`, `SignerRole`, and `SignerKind`.
- Keeps compatibility aliases only where needed by existing transport fixtures until later tasks migrate callers.

- [ ] **Step 1: Write failing policy validation tests**

Add cases for duplicate primary/secondary signers, zero secondaries, unsupported signer kind, disabled secondary in the policy object, and Option B's two active secondary signer addresses.

- [ ] **Step 2: Run policy tests to verify failure**

Run: `npm run test:unit -- --grep "secondary signer policy"`
Expected: FAIL because the policy model still exposes only the old product-specific signer fields.

- [ ] **Step 3: Implement role-neutral policy types and validation**

Add `SignerRole = "primary" | "secondary"`, `SignerKind = "safe-contract" | "ecdsa-extension"`, and `ConfiguredSigner`. Require one primary and at least one enabled secondary. Keep `0 < X < Y` asset validation unchanged.

- [ ] **Step 4: Verify and commit**

Run: `npm run test:unit -- --grep "secondary signer policy"` and `git diff --check`.
Commit: `docs: plan secondary signer implementation`.

### Task 2: Guard Signature Model

**Files:**
- Modify: `contracts/TieredSpendingGuard.sol`
- Modify: `contracts/libraries/SafeSignatureDecoder.sol`
- Modify: `test/unit/guard/signatures.test.ts`
- Modify: `test/integration/guard-signatures.test.ts`
- Modify: `test/integration/guard-spending.test.ts`
- Modify: `test/integration/delayed-tier.test.ts`
- Modify: `test/integration/adversarial.test.ts`

**Interfaces:**
- Produces Solidity `SignerRole`, `SignerKind`, `SignerConfig`, `SecondarySignerConfig`, and config view fields for primary, safe-contract secondary, ECDSA secondary, Delay, period.
- Keeps the terminal ECDSA envelope format unchanged for ECDSA secondary approvals.

- [ ] **Step 1: Write failing guard signature tests**

Test primary-only base succeeds; primary-only step-up fails; safe-contract secondary alone fails; ECDSA secondary alone fails; two secondaries without primary fails; primary plus safe-contract secondary succeeds; primary plus ECDSA secondary succeeds; wrong/disabled/duplicate/mixed-kind secondaries fail.

- [ ] **Step 2: Run guard tests to verify failure**

Run: `npm run test:unit -- --grep "secondary signer"` and `npm run test:integration -- --grep "secondary signer"`
Expected: FAIL because the guard accepts only the configured ECDSA secondary extension.

- [ ] **Step 3: Implement bounded secondary signature parsing**

Parse the primary Safe contract-signature slot first. For step-up paths, accept exactly one configured secondary: either a second Safe contract-signature slot with no extension, or the terminal ECDSA extension. Call Safe `checkNSignatures(..., 2)` for primary plus Safe-contract secondary and `checkNSignatures(..., 1)` for primary plus ECDSA extension. Reject approved-hash, raw EOA owner substitutions, mixed duplicate secondary forms, disabled secondary, and trailing bytes.

- [ ] **Step 4: Verify and commit**

Run the guard unit/integration suites touched by the task and `git diff --check`.
Commit: `feat: support configured secondary guard signers`.

### Task 3: Topology, Maintenance, and Verification

**Files:**
- Modify: `contracts/GuardReplacementMaintenance.sol`
- Modify: `contracts/SafeAtomicSetupHelper.sol`
- Modify: `src/topology/build.ts`
- Modify: `src/topology/verify.ts`
- Modify: `src/topology/evidence.ts`
- Modify: `scripts/plan-deployment.ts`
- Modify: `scripts/verify-deployment.ts`
- Modify: `test/unit/topology/build.test.ts`
- Modify: `test/unit/topology/verify.test.ts`
- Modify: `test/integration/topology.test.ts`
- Modify: `test/integration/atomic-setup-helper.test.ts`
- Modify: `test/integration/two-owner-maintenance.test.ts`

**Interfaces:**
- Consumes guard primary/secondary config from Task 2.
- Produces deterministic Option B setup with owners `[primaryPasskey, safeContractSecondary, ecdsaSecondary]`, threshold 1, and verifier checks for both secondary paths.

- [ ] **Step 1: Write failing topology and maintenance tests**

Update snapshots and integration tests for three owners, primary plus two configured secondaries, no secondary-only transfer path, delayed broadening rotation, and immediate disabling only when it removes capability.

- [ ] **Step 2: Run topology tests to verify failure**

Run: `npm run test:unit -- --grep "topology"` and `npm run test:integration -- --grep "maintenance|atomic setup|topology"`
Expected: FAIL because current planning and verification require exactly two owners.

- [ ] **Step 3: Implement Option B topology**

Update atomic setup helper calldata, deterministic plan hashing, topology verification, maintenance role checks, and deployment examples to use primary plus both secondaries.

- [ ] **Step 4: Verify and commit**

Run the topology/maintenance suites and `git diff --check`.
Commit: `feat: build option b secondary signer topology`.

### Task 4: Role-Neutral Signer Adapters

**Files:**
- Modify: `src/signers/types.ts`
- Modify: `src/signers/passkey.ts`
- Modify: `src/signers/passkey-core.ts`
- Modify: `src/signers/eip1193.ts`
- Modify: `test/unit/signers/passkey.test.ts`
- Modify: `test/unit/signers/eip1193.test.ts`
- Modify: `test/integration/signer-flow.test.ts`

**Interfaces:**
- Produces `VaultSigner` with `address`, `role`, `kind`, and `sign(request)`.
- Produces `createEip1193SecondarySigner` as the public ECDSA secondary adapter name, with Burner-named factories kept as deprecated compatibility aliases inside this PR.

- [ ] **Step 1: Write failing signer adapter tests**

Assert passkey signer can be configured as primary or secondary safe-contract, EIP-1193 secondary signer is secondary ecdsa-extension, role/kind mismatches fail in composition, and duplicate hash/user rejection/provider mutation behavior remains hard-fail.

- [ ] **Step 2: Run signer tests to verify failure**

Run: `npm run test:unit -- --grep "VaultSigner|WalletConnect|secondary"`
Expected: FAIL because adapters still expose only `SafeSigner`.

- [ ] **Step 3: Implement role-neutral signer boundary**

Add `VaultSigner` and role/kind options while preserving exact SafeTx snapshotting and signature formats. Keep direct Burner NFC unimplemented.

- [ ] **Step 4: Verify and commit**

Run signer unit tests and signer-flow integration tests, then `git diff --check`.
Commit: `feat: make signer adapters role neutral`.

### Task 5: Documentation and Gates

**Files:**
- Modify: `docs/research/2026-09-16-personal-vault-research.md`
- Modify: `docs/security/call-graph.md`
- Modify: `docs/security/signer-provider-evaluation.md`
- Modify: `docs/security/testnet-runbook.md`
- Modify: `docs/superpowers/plans/2026-09-16-personal-vault-security-core.md`
- Modify: `config/sepolia.example.json`
- Modify: `deployments/sepolia.example.json`

**Interfaces:**
- Consumes Option B code/config from Tasks 2-4.
- Produces documentation that says "one configured secondary signer" instead of "Burner" wherever the property is role-generic.

- [ ] **Step 1: Write/update documentation assertions**

Update invariant and runbook tests where present so stale two-owner/product-specific secondary wording fails.

- [ ] **Step 2: Run documentation/invariant tests to verify failure**

Run: `npm run test:invariant -- --grep "call graph"` and `npm run package:sepolia-rehearsal`
Expected: FAIL until docs and examples match Option B.

- [ ] **Step 3: Update docs and examples**

Describe primary plus safe-contract secondary-or-ECDSA secondary, direct Burner NFC as future spike, three-owner Safe topology, and no production/audit claim.

- [ ] **Step 4: Final verification and commit**

Run: `npm run build`, `npm test`, `npm run test:invariant`, `npm run package:sepolia-rehearsal`, and `git diff --check`.
Commit: `docs: describe secondary signer vault model`.
