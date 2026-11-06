# Historical PWA Startup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start backend with verified historical vault; writes disabled.

**Architecture:** Committed package pair selects isolated historical verifier. Reuse journal/receipt/lineage checks; verify old topology at common block. Distinct read-only result reaches backend health/read route only.

**Tech Stack:** Existing TypeScript, viem, Hardhat, Vitest; no dependencies.

**Spec:** `packages/security-core/docs/superpowers/specs/2026-11-05-historical-pwa-startup-design.md`

## Global Constraints

- Sepolia only; fixed providers; exact historical hashes; seven successful rows; six confirmations.
- No current provisioning brand, writer, signer, broadcast, upgrade, or artifact substitution.
- Preserve current-profile write gates, prior nonce fix, external files, unrelated changes. No commit/push.

## Review Focus

- Unknown/edited package → reject before compatibility output.
- Pending/incomplete history → no historical restoration.
- Changed receipt/runtime/topology/policy/block → reject.
- Historical result → never accepted as current provisioning capability.
- Injected write callbacks/direct handlers → still blocked.

### Task 1: Verify and Expose Historical Read-Only Vault

**Files:**
- Create: `packages/security-core/config/sepolia.pwa-historical-vault.json`
- Modify: `packages/security-core/src/pwa/provisioning-recovery.ts`
- Create: `packages/security-core/src/pwa/historical-topology.ts`
- Modify: `packages/security-core/src/pwa/backend-api.d.ts`
- Test: `packages/security-core/test/unit/pwa/historical-vault.test.ts`
- Modify: `apps/backend/src/provisioner.ts`, `apps/backend/src/handlers.ts`, `apps/backend/src/server.ts`
- Create: `apps/backend/tests/historical-compatibility.test.ts`
- Modify: security call graph/dependency review and backend README.

**Interfaces:**
- Consumes: existing successful journal/review readers, `verifyProviderPrefix`, `verifyConsumedLineage`, official dependency verifier.
- Produces: `resolveCompletedHistoricalPwaVault(input): Promise<PwaHistoricalVault | undefined>`; distinct `mode: "read-only"` record; backend `historicalVault` property. Current provisioning API unchanged.

- [x] **Step 1: RED historical recovery and write denial**

Synthetic canonical packages plus controlled RPC evidence. Assert exact readonly record; current capability rejects it. Mutate packages, completion, receipts, runtimes, nonces, topology, policy, and block. Assert backend health/current read succeeds and every POST/direct write fails.

Run: `pnpm --dir packages/security-core exec hardhat test test/unit/pwa/historical-vault.test.ts`; `pnpm --dir apps/backend test`.
Expected: new regression FAIL.

- [x] **Step 2: Implement isolated historical verification and backend selection**

Pin exact live original/completed hashes. Read-only verification only. Reuse historical envelope checks; separate topology helper. Never catch failed historical checks into current recovery. Gate health, read projection, and writes.

- [x] **Step 3: GREEN and review**

Run: `pnpm --dir packages/security-core test`; `pnpm --dir apps/backend test`; `pnpm --dir apps/backend typecheck`; changed-file `git diff --check`.
Expected: PASS; report pre-existing skips/whitespace separately. Independent review of changed boundaries.

- [x] **Step 4: Real startup proof**

Use existing external files, real fixed RPCs, actual `createConfiguredBackend` on ephemeral loopback port. Health/read route PASS; POST rejects. Compare operational-file hashes. Stop server. No transaction sent.

## Execution evidence — 2026-11-05

- RED: six missing-core-function failures; three backend compatibility/write-denial regressions.
- GREEN: security-core `813 passing, 2 pending`; backend `71 passing`; backend typecheck PASS. Independent review: no actionable findings; reviewer independently ran nine core and three backend compatibility tests.
- Live: actual configured backend started on an ephemeral loopback port using existing external files and fixed RPC providers. Safe `0x9f27A03c32D6811548d3a69835Fbb758cf4A9086`; completed package `0xec0ea7dea7179b23caa8f72d2c6bf9c6aa05f3cedc0e1c58110122bd7ad4646a`; canonical snapshot block `12068639`; topology report `0xf57c164933966cf5ddc148569bab98bf35836c1a1770ed8f7d877a700dae2ac6`.
- Health: `ok: true`, `writesReady: false`, historical read-only profile. Current-vault GET 200; auto-provision POST 409. Provisioning/submission journals, review packages, and authorization sidecar file hashes unchanged. No signature or transaction. Test server closed.
- Changed-file whitespace PASS. Pre-existing unrelated `.github/instructions/codacy.instructions.md:30` trailing whitespace remains untouched. No commit/push.

### Task 2: Historical Browser Snapshot Compatibility

**Files:**
- Modify: `apps/app/src/lib/vault-chain.ts`, `apps/app/src/lib/vault-store.tsx`, `apps/app/src/components/wallet/topology-alert.tsx`.
- Test: `apps/app/src/lib/vault-chain.test.ts`, `apps/app/src/lib/vault-store.test.tsx`.
- Create: `apps/app/src/lib/historical-guard-test-fixture.ts`.
- Modify: `apps/app/src/lib/vault-activity.test.ts` (two existing policy fixtures lacked required recipient mode).

**Interfaces:**
- Consumes: canonical-block guard code and existing `VaultSnapshot` reads.
- Produces: optional read-only compatibility marker; exact-runtime old ABI; current ABI unchanged.

- [x] **Step 1: RED exact browser regression**

Run: `pnpm --dir apps/app exec vitest run src/lib/vault-chain.test.ts src/lib/vault-store.test.tsx`
Expected: FAIL reproducing `Position 159 ... 128`, discarded balance, missing notice.
Observed: four regressions failed; 27 existing tests passed.

- [x] **Step 2: Select old ABI by pinned runtime; retain read-only state**

Hash actual guard code at snapshot block. Recognized old hash only → four-word ABI and allowlisted policy; never modern decode fallback. Preserve real failures. Project read-only marker; block prepare/approve before callbacks; show neutral compatibility notice.

- [x] **Step 3: Verify full app and live browser**

Run: `pnpm --dir apps/app test`; `pnpm --dir apps/app build`; `pnpm --dir apps/app exec tsc --noEmit`.
Expected: PASS. Read-only browser refresh shows real balance, old limits, explicit notice, no decoder error. No transfer/signing. Independent review.

Task 2 evidence: focused chain/store regressions GREEN; complete app suite `113 passing`; app build PASS; app TypeScript check PASS after explicitly setting the current recipient mode on two existing activity test fixtures. Independent frontend review: no actionable findings; reviewer independently ran 35 chain/store/activity tests. Actual existing browser tab refreshed successfully: balance `20.00 USDC`, first/instant daily limits `1.00/3.00 USDC`, explicit earlier-version read-only notice, and no account-verification decoder error. Screenshot saved locally. No signature, transaction, or backend/core authorization change. Changed-file whitespace PASS; unrelated worktree edits preserved. No commit/push.
