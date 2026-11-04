# Phase One Automated PWA Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-deploy and verify the Sepolia PWA vault immediately after secondary-passkey verification. No operator approval files. No extra normal-flow click.

**Architecture:** Browser sends `{}` to one local-only endpoint. Backend builds deterministic plan, writes unsigned review package, asks narrow `ProvisioningAuthorizer`, validates canonical approval, executes seven bounded transactions serially, waits six confirmations each, verifies final topology, returns public projection. Phase One authorizer is backend-trusted. Future KMS replaces only authorizer.

**Tech Stack:** TypeScript, React, Vitest, Hardhat, viem, pnpm.

**Spec:** `docs/superpowers/specs/2026-11-01-phase-one-automated-pwa-provisioning-design.md`

## Global Constraints

- Sepolia only: chain `11155111`.
- `BACKEND_PROFILE=local` only.
- Browser controls no address, calldata, artifact, nonce, gas, fee, approval, or package hash.
- Exact ordered IDs: `primary-signer`, `secondary-signer`, `setup-helper`, `guard`, `delay`, `maintenance`, `safe-proxy`.
- Preserve durable-before-broadcast journal and reconciliation-only uncertain state.
- Hard-stop startup on non-empty provisioning journal.
- Six confirmations before next transaction.
- Aggregate reservation `<= 0.05 ETH`.
- No new Solidity or dependency.
- pnpm only. Never `npm` or `npx`.
- Do not commit.

## Review Focus

- Browser input cannot shape deployment.
- Phase One authorization is labeled backend-trusted, never independent.
- Signed gas/fee fields equal committed authorization. Fresh RPC estimates/fees only admit/reject.
- Duplicate requests cannot create second plan or broadcast.
- Partial/uncertain/restarted execution fails closed.

---

## Task 1: Commit and validate automatic authorization policy

**Files:**

- Create: `packages/security-core/config/sepolia.pwa-provisioning-automation.json`
- Create: `packages/security-core/src/pwa/authorization.ts`
- Modify: `packages/security-core/src/pwa/index.ts`
- Create: `packages/security-core/test/unit/pwa/authorization.test.ts`

- [ ] Write failing tests: exact chain/profile/order/nonces accepted; altered chain/order/id/nonce/plan rejected; caps map every ID; aggregate cap is `50000000000000000` wei; unknown config fields rejected.
- [ ] Run red test:

```bash
pnpm --dir packages/security-core exec hardhat test test/unit/pwa/authorization.test.ts
```

- [ ] Add `ProvisioningAuthorizer` interface. Input: branded plan plus public admission facts only. Output: existing `PwaProvisioningApproval`. No signer, relay, broadcast, journal, or browser input.
- [ ] Add strict committed policy parser and local Phase One implementation. Approval fields derive only from plan plus committed artifact.
- [ ] Export public API.
- [ ] Run green test with same command.

## Task 2: Enforce current gas, fee, reservation, and confirmation facts

**Files:**

- Modify: `packages/security-core/src/pwa/provisioning.ts`
- Modify: `packages/security-core/test/unit/pwa/provisioning-approval.test.ts`

- [ ] Write failing tests: estimate over cap; recommended max fee over signed max; recommended priority fee over signed max; reservation over `0.05 ETH`; fewer than six confirmations; changed receipt block hash; runtime/code drift. Each fails before next signature.
- [ ] Run red test:

```bash
pnpm --dir packages/security-core exec hardhat test test/unit/pwa/provisioning-approval.test.ts
```

- [ ] Extend public RPC boundary with estimate, EIP-1559 fee, confirmed-receipt, head, and canonical receipt facts.
- [ ] Before each signature: verify exact plan/nonce/code; estimate/simulate; compare estimate and current fee recommendation with exact authorized fields; recompute reservation; then sign exact authorized transaction.
- [ ] Wait for six confirmations. Re-read receipt/block identity and expected runtimes before advancing.
- [ ] Preserve pending-hash persistence before broadcast and no blind retry.
- [ ] Run green test with same command.

## Task 3: Replace operator-file provisioner with single-flight authorizer flow

**Files:**

- Modify: `apps/backend/src/provisioner.ts`
- Modify: `apps/backend/src/config.ts`
- Modify: `apps/backend/src/main.ts`
- Modify: `apps/backend/tests/provisioner.test.ts`
- Modify: `apps/backend/tests/config.test.ts`

- [ ] Write failing tests: review package written before authorize; authorize before sign; duplicate calls share one promise/result; altered credential pair rejected; retired approval envs rejected; non-empty journal startup rejected; local Sepolia only.
- [ ] Run red tests:

```bash
pnpm --dir apps/backend exec vitest run tests/provisioner.test.ts tests/config.test.ts
```

- [ ] Replace `plan()`/`execute()` public provisioner with `provision(credentials)`.
- [ ] Inject `ProvisioningAuthorizer`; default to committed local Phase One implementation.
- [ ] Remove approval JSON/hash reads and config requirements. Do not delete old external files.
- [ ] Add single-flight cache for in-flight and verified result.
- [ ] Add startup journal freshness guard.
- [ ] Adapt viem RPC: estimate, fee recommendation, six-confirmation receipt wait, canonical re-read.
- [ ] Run green tests with same command.

## Task 4: Close backend API to one empty-body operation

**Files:**

- Modify: `apps/backend/src/handlers.ts`
- Modify: `apps/backend/src/server.ts`
- Modify: `apps/backend/tests/handlers.test.ts`
- Modify: `apps/backend/tests/server.test.ts`
- Modify: `apps/backend/tests/backend-surface.test.ts`

- [ ] Write failing tests: `POST /v1/vaults/auto-provision` accepts only exact `{}`; uses stored verified credentials; unavailable outside local profile; duplicates single-flight; old plan/execute routes absent; browser fields rejected.
- [ ] Run red tests:

```bash
pnpm --dir apps/backend exec vitest run tests/handlers.test.ts tests/server.test.ts tests/backend-surface.test.ts
```

- [ ] Add closed handler and route.
- [ ] Remove supported `/v1/vaults/plan` and `/v1/vaults` provisioning routes.
- [ ] Return verified public vault projection only.
- [ ] Run green tests with same command.

## Task 5: Trigger provisioning after secondary passkey

**Files:**

- Modify: `apps/app/src/lib/vault-store.tsx`
- Modify: `apps/app/src/routes/onboarding.tsx`
- Modify: `apps/app/src/lib/vault-store.test.tsx`
- Add or modify: `apps/app/src/routes/onboarding.test.tsx`

- [ ] Write failing tests: secondary registration persists public credential ID, then auto-calls empty-body endpoint; no plan/approval/provision button; config persists only after verified result; failure stays unfunded/unready and exposes explicit retry; duplicate UI action does not duplicate backend execution.
- [ ] Run red tests:

```bash
pnpm --dir apps/app exec vitest run src/lib/vault-store.test.tsx src/routes/onboarding.test.tsx
```

- [ ] Replace browser API methods with `autoProvisionVault(): Promise<VerifiedVaultProjection>`.
- [ ] Replace `ready-to-plan`/`awaiting-operator`/`approved` with automatic `provisioning` and terminal success/failure state.
- [ ] Call auto-provision immediately after verified secondary registration.
- [ ] Remove normal-flow buttons. Keep fail-closed retry only after failure.
- [ ] Run green tests with same command.

## Task 6: Update security and operator documentation

**Files:**

- Modify: `packages/security-core/docs/security/call-graph.md`
- Modify: `packages/security-core/docs/superpowers/plans/2026-09-16-personal-vault-security-core.md`
- Modify: `apps/backend/README.md`
- Modify: `apps/app/README.md`

- [ ] Document new browser-to-backend path, authorizer boundary, seven serial transactions, six confirmations, journal stop, final topology gate.
- [ ] Mark prior per-package human approval requirement superseded for local Sepolia Phase One only.
- [ ] State compromise limitation: backend authorization is consistency/cost bounding, not independent approval.
- [ ] Document retained envs and retired env rejection.
- [ ] Use pnpm-only startup/test commands.

## Task 7: Verify full affected surface

- [ ] Security-core typecheck and PWA tests:

```bash
pnpm --dir packages/security-core exec tsc --noEmit
pnpm --dir packages/security-core exec hardhat test test/unit/pwa/*.test.ts
```

- [ ] Backend typecheck and tests:

```bash
pnpm --dir apps/backend exec tsc --noEmit
pnpm --dir apps/backend exec vitest run
```

- [ ] App typecheck, tests, build:

```bash
pnpm --dir apps/app exec tsc --noEmit
pnpm --dir apps/app exec vitest run
pnpm --dir apps/app exec vite build
```

- [ ] Inspect `git diff --check` and `git status --short`.
- [ ] Confirm no commit created.
