# PWA Successor Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify the consumed Sepolia nonce lineage, derive a new unsigned plan for the remaining five PWA deployments at nonces `964..968`, and execute it through the existing dynamic authorization boundary.

**Architecture:** Strict committed successor artifact binds old package plus consumed hashes. Recovery verifies old prefix and consumed lineage through both providers, rebuilds old plan and successor plan separately, then existing backend execution writes successor review and authorizes only missing rows.

**Tech Stack:** TypeScript, Hardhat, viem, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-11-01-pwa-successor-provisioning-design.md`

## Global Constraints

- Sepolia/local only; no dependency or Solidity change.
- Preserve journal/reviews; append only new review/authorization/execution evidence.
- Committed hashes are public evidence only; two providers reverify every byte/state claim.
- Dynamic envelope and `0.05 ETH` ceiling unchanged.
- pnpm only; no commit.

## Review Focus

- Consumed hashes cannot authorize altered deployment bytes.
- Old package and successor package remain distinct and content-bound.
- Noncontiguous plan nonces cannot skip unverified journal rows.
- Old/successor future address collisions fail before signing.
- Live command sends only five successor rows.

---

### Task 1: Successor Lineage and Plan Reconstruction

**Files:**
- Create: `packages/security-core/config/sepolia.pwa-provisioning-successor.json`
- Modify: `packages/security-core/src/pwa/provisioning-recovery.ts`
- Modify: `packages/security-core/src/pwa/provisioning.ts`
- Modify: `packages/security-core/src/config/deployments.ts`
- Modify: `packages/security-core/src/pwa/backend-api.d.ts`
- Modify: `packages/security-core/src/pwa/index.ts`
- Modify: `packages/security-core/test/unit/pwa/provisioning-recovery.test.ts`
- Modify: `packages/security-core/test/integration/pwa-provisioning.test.ts`

**Interfaces:** Produces strict `loadCommittedPwaProvisioningSuccessor()` and recovery result whose plan nonces are `959,960,964,965,966,967,968`.

- [x] **Step 1: RED strict artifact and valid successor**

Test exact committed shape; original package/prefix/nonce binding; two-provider consumed transaction/receipt validation; distinct successor package; preserved signer rows; rebased five-row suffix.

- [x] **Step 2: RED adversarial lineage**

Reject missing/wrong/reordered hashes, wrong sender/chain/type/nonce, provider disagreement, failed/<6-confirmation/reorged receipts, old-intent match, old/successor code collision, and latest/pending split.

- [x] **Step 3: Run RED**

Run: `pnpm --dir packages/security-core exec hardhat test test/unit/pwa/provisioning-recovery.test.ts test/integration/pwa-provisioning.test.ts`

Expected: FAIL.

- [x] **Step 4: Implement strict successor reconstruction**

Add separate current nonce and prerequisite starting nonce. Original reconstruction keeps `961`; successor derivation uses the committed expected-next nonce (`964` after the latest verified lineage extension). Execution prefix uses the next plan row nonce, never arithmetic contiguity.

- [x] **Step 5: Run GREEN**

Run prior command. Expected: PASS.

### Task 2: Backend Composition and Live Preflight

**Files:**
- Modify: `apps/backend/src/provisioner.ts`
- Modify: `apps/backend/tests/provisioner.test.ts`
- Modify: `apps/backend/tests/backend-surface.test.ts`
- Modify: `apps/backend/README.md`
- Modify: `packages/security-core/docs/security/call-graph.md`
- Modify: `packages/security-core/docs/security/dependency-review.md`

**Interfaces:** Configured backend consumes only committed successor lineage; `preflight()` reports next ID `setup-helper` and nonce `964` without writes.

- [x] **Step 1: RED committed-only composition**

Test configured recovery loads successor automatically; no environment/browser override; preflight opens no writer, signs nothing, broadcasts nothing.

- [x] **Step 2: Run RED**

Run: `pnpm --dir apps/backend exec vitest run tests/provisioner.test.ts tests/backend-surface.test.ts`

Expected: FAIL.

- [x] **Step 3: Implement composition/docs**

Pass committed successor evidence into recovery. Keep normal exact-prefix recovery unchanged for every other package/state.

- [x] **Step 4: Run GREEN and full verification**

Run focused suites, backend typecheck, app tests/build, clean core compile, full core tests, and `git diff --check`. Expected: PASS except recorded pre-existing whitespace.

### Task 3: Authorized Live Successor Execution

**Files:** External review/journal/authorization evidence only; never edit or delete old files.

**Interfaces:** Empty auto-provision trigger executes only missing successor suffix.

- [x] **Step 1: Read-only preflight**

Require unique old package, verified prefix, verified consumed lineage, nonce `964`, next ID `setup-helper`, dynamic quote, budget PASS, zero sends.

- [x] **Step 2: Execute once**

Start backend with existing external files and call empty auto-provision once. Wait six confirmations each. Stop on divergence.

- [x] **Step 3: Evidence**

Report five hashes/blocks/gas, final topology hash, rebind requirement, tests, dirty tree. No commit.
