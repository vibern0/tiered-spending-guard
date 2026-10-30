# USDC Delayed-Tier Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete only Sepolia USDC Z/cancel/expiry/ready evidence with one closed 13-row append-only continuation.

**Architecture:** Reuse fresh-source providers, action templates, atomic store, adapter, signer loader, observer, submission, and reporter patterns. Add one opaque certificate/proposal and one sibling. Freeze all predecessor bytes. No contract or signer change.

**Tech Stack:** TypeScript, viem, Hardhat, Mocha/Chai, existing Sepolia harness.

**Spec:** `packages/security-core/docs/superpowers/specs/2026-10-30-usdc-delayed-tier-completion-design.md`

## Global Constraints

- Same Safe, guard, Delay, USDC, funder, recipient, primary, contract secondary.
- 31 USDC inward, 31 new gross outward, 51 aggregate gross outward, zero native principal.
- Reservation `9340292000000` wei; phase below `0.05 ETH`.
- One attempt per row. No reset, retry, repair, ECDSA path, X/Y replay, generic catalog, or provider override.
- Use TDD. Update call graph and evidence. Exact artifact review precedes approval and live execution.

## Review Focus

- Stopped fresh row mutation or omission must reject before new attachment.
- A 30-USDC-or-less delayed transfer must reject; exact 31 USDC must classify above Y with stale counters.
- Any second delayed-completion attachment, mixed live suffix, or status regression must reject.
- Early, cancelled, and expired execution must remain read-only rejection proof with zero broadcast.
- Observer expiry, period deadline, nonce split, receipt reorg, or cap drift must stop before signing/broadcast.

---

### Task 1: Closed certificate and 13-row proposal

**Files:**
- Create: `packages/security-core/scripts/live/ordinary-scenario-usdc-delayed-completion-certificate.ts`
- Create: `packages/security-core/scripts/live/ordinary-scenario-usdc-delayed-completion-proposal.ts`
- Create: `packages/security-core/test/support/usdc-delayed-completion-fixture.ts`
- Create: `packages/security-core/test/unit/security/ordinary-usdc-delayed-completion-certificate.test.ts`
- Create: `packages/security-core/test/unit/security/ordinary-usdc-delayed-completion-proposal.test.ts`

**Interfaces:** Produce opaque `VerifiedUsdcDelayedCompletionCertificate`, exact `UsdcDelayedCompletionProposal`, opaque approval, and attachment builder.

- [x] RED: exact stopped source, canonical two-provider state, 13 literal rows, 7 broadcasts, 6 proofs, `10/4/4 → 14/7/7`, `0/40 → 0/40`, 31/51 accounting, reservation.
- [x] Run focused tests; require missing APIs/catalog failures.
- [x] GREEN: minimal closed certificate/proposal/parser/approval/attachment.
- [x] Run focused and fresh predecessor families. Commit.

### Task 2: Atomic execution, CLI, and report

**Files:**
- Modify: `packages/security-core/scripts/live/ordinary-scenario-executor.ts`
- Modify: `packages/security-core/scripts/live/ordinary-scenario-adapter.ts`
- Create: `packages/security-core/scripts/live/ordinary-scenario-usdc-delayed-completion-cli.ts`
- Create: `packages/security-core/scripts/live/ordinary-scenario-usdc-delayed-completion-report.ts`
- Create: `packages/security-core/test/unit/security/ordinary-usdc-delayed-completion-executor.test.ts`
- Create: `packages/security-core/test/integration/ordinary-usdc-delayed-completion-adapter.test.ts`
- Create: `packages/security-core/test/unit/security/ordinary-usdc-delayed-completion-cli.test.ts`
- Create: `packages/security-core/test/unit/security/ordinary-usdc-delayed-completion-report.test.ts`

**Interfaces:** Produce closed execution view, append-only store projection, `review|submit-one|resume-one`, and pure terminal renderer.

- [x] RED: predecessor freeze, one sibling, one selected row, durable hash, keyless pending reconciliation, proof zero-broadcast, stale-counter 31-USDC classification, terminal report.
- [x] Run focused tests; require missing execution/CLI/report failures.
- [x] GREEN: minimal projection and production composition using existing harness/providers.
- [x] Run focused plus fresh/legacy executor, adapter, CLI, report families. Commit.

### Task 3: Docs, review, and exact code gate

**Files:**
- Modify: `packages/security-core/docs/security/call-graph.md`
- Modify: `packages/security-core/docs/security/testnet-runbook.md`
- Modify: `packages/security-core/docs/evidence/2026-10-30-usdc-fresh-successor.md`

- [x] Document only the new Z-only path and stopped predecessor.
- [ ] Request independent review; fix every Critical/Important with RED/GREEN; rereview.
- [ ] Run `npm --prefix packages/security-core run security:check`, normal build, backend tests, `git diff --check`; bind exact clean product HEAD and hashes.

### Task 4: Observer, artifacts, approval, and live Z evidence

- [ ] Provision/revalidate a receiver with at least 3600 seconds schedule coverage.
- [ ] Generate fresh two-provider certificate, unsigned proposal, RPC proof, and wrapper binding. No private callback or broadcast.
- [ ] Independently replay exact artifacts. Create exact approval only after ACCEPT.
- [ ] Execute one selected row per invocation. Reconcile six confirmations and required alert acknowledgement before the next row. Preserve real 120-second cooldown and 720-second expiry.
- [ ] Render and independently review terminal public evidence. Update only completed checkboxes.

## Completion Boundary

13 terminal rows; 7 new canonical receipts; 22 total live entries; terminal `14/7/7`; Safe/funder USDC `0/40`; 31 new and 51 aggregate gross outflow; 31 inward; accepted lifecycle alerts. Repair and native AA remain open.
