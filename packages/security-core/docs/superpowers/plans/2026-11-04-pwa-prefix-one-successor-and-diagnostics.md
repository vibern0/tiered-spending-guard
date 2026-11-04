# PWA Prefix-One Successor and Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resume the exact Sepolia PWA deployment after unrelated nonce `1031`, and expose useful redacted backend/frontend failure context.

**Architecture:** Security-core admits multiple committed successor lineages. This lineage preserves confirmed primary signer nonce `1030`, proves unrelated nonce `1031` through two fixed providers, then rebases only missing rows to `1032..1037`. Backend emits redacted structured request/RPC diagnostics; frontend retains actionable public error code, request ID, and stage.

**Tech Stack:** TypeScript, viem, Node HTTP, React, Vitest, Hardhat, pnpm.

**Spec:** `packages/security-core/docs/superpowers/plans/2026-11-01-dynamic-pwa-provisioning-envelope-and-recovery.md`

## Global Constraints

- Sepolia only; no mainnet.
- Preserve exact confirmed journal rows; never rewrite or replay nonce `1030`.
- Skip nonce `1031` only after both fixed providers verify committed hash `0xe146a16cd246241b86cdb0ce44dc93dd02ff3bd339102620fdff33eb0760db35`, exact envelope, canonical successful receipt, and six confirmations.
- Missing suffix nonces are exactly `1032..1037`.
- Keep previous `959..960` / `961..963` / `964..968` successor recoverable.
- Logs exclude RPC URLs, private keys, passkey material, signatures, request bodies, and raw 32-byte secret-shaped values.
- pnpm only. Do not commit.

## Review Focus

- Prefix-one rebase moves secondary signer, not setup-helper, to `1032`; Task 1 tests exact IDs/nonces.
- Wrong committed nonce/hash/provider receipt stops before authorization; Task 1 adversarial tests.
- Multiple successor records select only by exact original package; Task 1 tests ambiguity/rejection.
- Backend logs useful route/stage/code/request ID without sensitive values; Task 2 redaction tests.
- Frontend shows action, code, and request ID while logging one safe structured error; Task 2 UI/store tests.

---

### Task 1: Generalized Committed Successor Recovery

**Files:**
- Create: `packages/security-core/config/sepolia.pwa-provisioning-successor-1031.json`
- Modify: `packages/security-core/src/pwa/provisioning-recovery.ts`
- Modify: `packages/security-core/src/pwa/provisioning.ts`
- Modify: `packages/security-core/src/pwa/backend-api.d.ts`
- Modify: `apps/backend/src/provisioner.ts`
- Modify: `packages/security-core/test/unit/pwa/provisioning-recovery.test.ts`
- Modify: `packages/security-core/test/integration/pwa-provisioning.test.ts`
- Modify: `apps/backend/tests/provisioner.test.ts`

**Interfaces:**
- Produces `loadCommittedPwaProvisioningSuccessors(): readonly PwaProvisioningSuccessor[]`.
- Adds `successorStartingNonce?: bigint`; suffix row `i >= confirmedPrefixLength` uses `successorStartingNonce + (i - confirmedPrefixLength)`.

- [x] **Step 1: RED prefix-one and multi-lineage tests**

Assert preserved row `primary-signer@1030`; rebased rows `secondary-signer@1032`, `setup-helper@1033`, `guard@1034`, `delay@1035`, `maintenance@1036`, `safe-proxy@1037`; previous successor unchanged; mutations reject.

- [x] **Step 2: Run RED**

Run: `pnpm --dir packages/security-core exec hardhat test test/unit/pwa/provisioning-recovery.test.ts test/integration/pwa-provisioning.test.ts`

Expected: FAIL because prefix-one successors and multiple committed lineages are unsupported.

- [x] **Step 3: Implement minimal generalized rebase**

Allow committed prefix lengths `1..2`; validate suffix length/count from prefix; select exact package lineage; preserve prefix bytes; rebase only missing rows. Backend loads no environment/browser successor override.

- [x] **Step 4: Run GREEN**

Run Task 1 focused tests plus `pnpm --dir apps/backend test -- tests/provisioner.test.ts`.

Expected: PASS.

### Task 2: Redacted Backend and Frontend Diagnostics

**Files:**
- Modify: `apps/backend/src/server.ts`
- Modify: `apps/backend/src/provisioner.ts`
- Modify: `apps/backend/tests/server.test.ts`
- Modify: `apps/backend/tests/provisioner.test.ts`
- Modify: `apps/app/src/lib/vault-store.tsx`
- Modify: `apps/app/src/lib/provisioning-errors.ts`
- Modify: `apps/app/src/lib/provisioning-errors.test.ts`
- Modify: `apps/app/src/lib/vault-store.test.tsx`

**Interfaces:**
- Backend error response: `{ error, code, stage, requestId }`; header `x-request-id` matches.
- Backend log: one JSON event `{ level, requestId, method, route, status, code, stage, message }`.
- Frontend `BackendRequestError` retains status/code/stage/requestId and logs one redacted object.

- [x] **Step 1: RED observability tests**

Assert nonce mismatch identifies expected/observed public nonces and transaction ID; route failures log once; RPC URL/hash/private material redacted; frontend error text includes safe next action plus code/request ID.

- [x] **Step 2: Run RED**

Run: `pnpm --dir apps/backend test -- tests/server.test.ts tests/provisioner.test.ts && pnpm --dir apps/app test -- src/lib/provisioning-errors.test.ts src/lib/vault-store.test.tsx`

Expected: FAIL because structured diagnostics are absent.

- [x] **Step 3: Implement narrow diagnostics**

Classify provisioning stages at backend seams; preserve sanitized cause category/status only. Never return or log endpoints, bodies, credentials, signatures, or full hashes.

- [x] **Step 4: Run GREEN**

Run Task 2 focused tests.

Expected: PASS.

### Task 3: Documentation, Full Verification, and Vivaldi Resume

**Files:**
- Modify: `packages/security-core/docs/security/call-graph.md`
- Modify: `packages/security-core/docs/superpowers/plans/2026-11-01-dynamic-pwa-provisioning-envelope-and-recovery.md`
- Modify: `apps/backend/README.md`

**Interfaces:** Documents both committed lineages and structured redacted diagnostics.

- [x] **Step 1: Update docs**

Record prefix-one lineage and no-authority logging boundary.

- [x] **Step 2: Run full gates**

Run security-core PWA/full tests, backend tests/typecheck, app tests/build, and `git diff --check`.

Expected: all task-relevant gates pass; report any unrelated pre-existing failure exactly.

- [x] **Step 3: Restart backend and verify read-only recovery**

Startup must recover prefix one, verify nonce `1031`, select `secondary-signer@1032`, and broadcast nothing before the user-triggered retry.

- [x] **Step 4: Retry in Vivaldi and persist**

Click `Retry automatic provisioning`; wait six confirmations per missing row; stop on divergence; verify final topology and visible provisioned UI. Do not commit.
