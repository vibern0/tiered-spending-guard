# Installable Safe 4337 Contract Route Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Locally prove that an eligible existing Safe 1.5 ERC-4337 account can install a route policy making selected reviewed transfer targets usable only through its restricted 4337 path, while preserving X/Y/Z.

**Architecture:** A per-Safe restricted fallback/module delegates only the standard Safe4337Module account methods to an exact pinned implementation and rejects messages. A separate `TieredSpendingGuard4337` variant occupies both Safe guard slots; a bounded nested-call state machine admits one exact AA-wrapped owner transaction or ready Delay execution. The original guard stays byte-for-byte unchanged because its runtime is pinned by existing maintenance. An atomic Safe transaction swaps the old module/fallback and installs both guard slots; a read-only verifier rejects incompatible topology. This is a local research profile and is not an approved replacement for the active vault.

**Tech Stack:** Safe 1.5.0, `@safe-global/safe-4337@0.3.0-1`, EntryPoint 0.7 local fixture, existing passkey 0.2.0, Zodiac Delay 1.1.1, Solidity 0.8.24, Hardhat/viem.

**Spec:** [Installable Safe 4337 routing design](../specs/2026-11-19-installable-safe-4337-contract-routing-design.md).

## Global Constraints

- Local Hardhat only. No network deployment, backend removal, mainnet, production, or audit claim.
- Eligible Safe 1.5 only. No arbitrary ERC-4337 account or Safe without both guard slots.
- Listed actions are existing reviewed native sends and selected ERC-20 `transfer` calls. Deny arbitrary calldata, approvals, batches, delegatecalls, Permit/Permit2, ERC-1271 messages.
- Preserve sole passkey owner, configured contract secondary, X/Y shared counters, Delay Z, cancellation, expiry, freeze, and delayed weakening.
- Pin module package/lock, source, runtime hash, EntryPoint, and exact installer artifacts. Keep unrelated workspace edits.

## Review Focus

- Fallback suffix/direct-call spoof: only Safe-forwarded exact EntryPoint account calls may reach module code; test forged suffix and direct router calls.
- Delegatecall context: `SafeOp` domain must bind the installed router, and Safe module caller must be the router; test mutations and actual local EntryPoint path.
- Nested hooks: one module check, one owner or Delay check, matched successful after-hooks, full rollback; test reentrancy and failure.
- Installation: one transaction must leave both guards, exact fallback, and only approved modules; test failure rollback and post-install verification.
- Old allowances and unsupported assets: reject or report unverifiable existing state; never claim arbitrary funded Safes are safe to adopt.

---

### Task 1: Restricted Safe 4337 fallback/module

**Files:** Create `contracts/Safe4337RestrictedRouter.sol`, `test/integration/safe4337-router.test.ts`; modify `package.json`, root `pnpm-lock.yaml`, `docs/security/dependency-review.md`, `docs/security/call-graph.md`.

**Interfaces:** `constructor(address safe,address standardModule,address entryPoint)`; `fallback()` permits exact `validateUserOp`, `executeUserOp`, `executeUserOpWithErrorString`, plus read-only `getOperationHash` via pinned delegatecall; all ERC-1271/unknown selectors revert. Constructor binds one Safe and exact module runtime/EntryPoint.

- [x] **Step 1: Write RED.** Real Safe 1.5 + passkey + published module: old fallback validates arbitrary ERC-1271; new router rejects it and validates a signed SafeOp from the configured EntryPoint. Direct router calls, forged suffix, wrong Safe/EntryPoint/implementation fail.
- [x] **Step 2: Run RED.** `npm --prefix packages/core test -- test/integration/safe4337-router.test.ts`; expect missing router contract.
- [x] **Step 3: Implement minimal router and exact dependency pin.** No Safe storage delegatecall; router only delegates selected module code in router context. Reject noncanonical account calldata and unknown selectors. Record package/source/runtime/audit scope.
- [x] **Step 4: Run GREEN.** Same focused command; expect all assertions pass.

### Task 2: Route targets and nested guard policy

**Files:** Create `contracts/TieredSpendingGuard4337.sol`, `test/integration/safe4337-route.test.ts`; update `docs/security/call-graph.md`. The original guard must retain its maintenance-pinned runtime hash.

**Interfaces:** `configureAaRouter(address router)` is Safe-only, one-time, before guard installation; `addRouteOnlyTarget(address target)` is Safe-only monotonic tightening. Listed targets admit only exact approved native/selected ERC-20 transfer shapes inside one AA-wrapped Safe `execTransaction`; all direct owner calls to them fail. Existing no-AA guard behavior remains unchanged.

- [ ] **Step 1: Write RED.** Direct owner listed native/ERC-20 action fails; exact module wrapper with real passkey succeeds and consumes X/Y; wrong module, direct module transfer, mutated inner SafeTx, wrong signature, nested call, delegatecall, prefund, failed transfer, and unlisted action cannot bypass existing policy.
- [ ] **Step 2: Run RED.** `npm --prefix packages/core test -- test/integration/safe4337-route.test.ts`; expect missing route interface/behavior.
- [x] **Step 3: Implement bounded phase machine.** Bind canonical outer call, exact inner SafeTx hash/nonce, module hash, and ordered after-hooks; preserve token balance proof and rollback. Route additions are immediate tightening; delayed removal remains an open gate.
- [ ] **Step 4: Run GREEN.** Focused route plus existing guard spending/signatures/adversarial tests; expect all pass.

### Task 3: Delayed route and existing-Safe installation

**Files:** Modify guard; create `test/integration/safe4337-install.test.ts`, `test/integration/safe4337-ready-delay.test.ts`; update topology verifier/build helpers only for separate local research profile, `docs/security/call-graph.md`.

**Interfaces:** Exact AA outer call to `Delay.executeNextTx` admits only current queued head after Z; direct public Delay execution to a listed target is rejected. Installer builds one **unsigned** Safe MultiSendCallOnly transaction from a compatible existing Safe to enable router as module, disable standard module, install restricted fallback and both guards; read-only verifier checks before and after topology and pins the call-only runtime.

- [ ] **Step 1: Write RED.** Existing Safe with standard module installs atomically; failed mutation rolls back. Listed over-Y direct call fails; queue, cancellation, expiry, ready execution through router, and independent direct public Delay execution obey Z and preserve counters.
- [ ] **Step 2: Run RED.** `npm --prefix packages/core test -- test/integration/safe4337-install.test.ts test/integration/safe4337-ready-delay.test.ts`; expect missing installer/ready branch.
- [ ] **Step 3: Implement exact ready branch and local installer/verifier.** Reject other modules, fallback, guard slots, owner, runtime hash, pre-existing allowance, or unknown target policy. No network write path.
- [ ] **Step 4: Run GREEN.** Focused install/Delay tests plus existing delayed-tier/topology tests; expect all pass.

### Task 4: Security regression and evidence

**Files:** Update `docs/security/call-graph.md`, `docs/security/dependency-review.md`, focused design status; create local-only evidence report under `docs/evidence/`.

**Interfaces:** Local evidence records exact artifacts, path tests, failures, limits, and unproved provider/browser/live gates.

- [ ] **Step 1: Add adversarial matrix.** Mutate all signer, nonce, target, value, calldata, operation, module, fallback suffix, guard hook, queue, timing, and policy-change inputs. Prove two guard slots and no ERC-1271 route.
- [x] **Step 2: Run full local gate.** `npm --prefix packages/core run security:check`, `npm --prefix apps/backend test`, `git diff --check`; record exact results and any failures.
- [x] **Step 3: Report limits.** No claim for arbitrary ERC-4337 accounts, arbitrary contract calls, existing unreviewed approvals, live sponsorship, browser passkeys, or completed ordinary-Safe live gate.

## Local progress and open gates

- Restricted router, exact dependency pins, real passkey SafeOp validation and both ERC-1271 rejections: implemented and focused test passed. Direct router call, forged caller, wrong module and wrong EntryPoint reject.
- Separate guard variant: listed ERC-20 transfer via AA passes; direct owner, direct AA module and direct Delay listed-target paths reject. Local EntryPoint 0.7 `handleOps` passes with an external deposit. Approval rejects; queue, Z, cancellation and expiry pass. Broader mutation/reentrancy/invariant review is still open.
- Atomic existing-Safe installation and rollback pass locally through pinned MultiSendCallOnly. The read-only verifier checks exact Safe modules/slots/runtime anchors and core bindings, but does not certify historical approvals, complete asset policy, same-block consistency, or all Delay upstream modules in the local fixture.
- The original maintenance helper cannot replace this guard variant. Delayed handler/profile replacement and recovery are missing. Keep this profile local and unfunded until a separate reviewed maintenance design, adversarial tests, sponsorship/browser/monitoring gates, and the ordinary-Safe live gate are complete.
