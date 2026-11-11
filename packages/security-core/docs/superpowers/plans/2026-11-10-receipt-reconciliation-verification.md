# Receipt Reconciliation and Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Reconcile durable receipts automatically; reduce verification reads; preserve all security checks.

**Architecture:** Backend read-only worker owns durable reconciliation. Browser tracks known submission status. Provider-local pinned collections batch/deduplicate reads; every authorization boundary stays fresh.

**Tech Stack:** Existing TypeScript, React, viem, Vitest, Hardhat, Safe/Zodiac. No new dependencies.

**Spec:** `packages/security-core/docs/superpowers/specs/2026-11-10-receipt-reconciliation-verification-design.md`

## Global Constraints

- Preserve all security checks. Two providers, six canonical confirmations, successful-execution observation proof remain required.
- No signing or broadcasting from reconciliation. No live transaction tests.
- No contract, dependency, provisioning sequence, signer, session or policy change.
- Never cache head, chain identity or block-anchor reads; never reuse a collection across approvals, signing, broadcast, providers or accounts.
- Preserve deterministic topology report ordering and hashes.

## Review Focus

- Restart with pending evidence: reconcile exact retained hash, never resubmit.
- Disagreement/reorg/provider failure: leave journal unresolved and payer blocked; retry boundedly.
- Logout/account switch/unmount: ignore old responses; stop obsolete polling.
- Missing/malformed batch members: fail closed; no signature/broadcast.
- State changes after approval or signing: fresh original-block and semantic checks still reject drift.

---

### Task 1: Durable backend reconciliation

**Files:** Backend account gateway/main, submission service, new receipt worker, backend tests.

**Interfaces:** Add `AccountGateway.reconcilePending?(): Promise<void>`; worker returns async stop/drain. Existing `status(accountId, id)` remains exact-hash non-authorizing.

- [x] Write worker/gateway/service regressions; verify RED.
- [x] Implement single-flight pending-only sweep, isolated account errors, bounded retry, shutdown drain and concurrent status coalescing.
- [x] Run `npm run backend:test` and `npm run backend:typecheck`; expect PASS.

### Task 2: Browser status reconciliation

**Files:** App vault store, Activity and Send status consumers, focused app tests.

**Interfaces:** Existing `submission(id)` GET remains the only status capability. Expose account-scoped statuses from vault provider as needed.

- [x] Write restored/new pending, retry, terminal-stop, account-switch and unmount regressions; verify RED.
- [x] Implement non-overlapping status refresh for known submissions; no signing/resubmission; terminal refresh once.
- [x] Run `npm run app:test`, app TypeScript and build; expect PASS.

### Task 3: Verification reads and complete proof

**Files:** Backend read adapters/submission runtime; security-core pinned reads, topology verifier; corresponding tests; call graph and README.

**Interfaces:** Provider-local explicit-block read scope; `revalidate` may return fresh snapshot internally while public callback stays compatible.

- [x] Add isolation, batching, duplicate-read, report-equivalence and pre-broadcast drift tests; verify RED.
- [x] Batch submission reads; parallelize independent topology reads; deduplicate only within a pinned collection; reuse immediately returned revalidated snapshot.
- [x] Update call graph/read policy and this plan's checkboxes.
- [x] Run `npm test`, backend/app TypeScript, app build and `git diff --check`; expect PASS; report existing deferred gates accurately.
- [x] Independent review; fix material findings with RED→GREEN proof. Leave changes reviewable on task branch.

## Verification

- `npm test`: 853 security-core passed; 2 existing deferred tests; 165 backend passed; 213 app passed. Landing: existing no-tests gate passes.
- `npm run backend:typecheck`: PASS.
- `npx tsc --project apps/app/tsconfig.json --noEmit`: PASS.
- `npm run app:build`: PASS; existing bundler warning remains.
- `git diff --check`: PASS.
- Local transport: three concurrent reads use one HTTP batch. Base send: eight full state collections reduced to six. Real local Safe tier/lifecycle and changed-guard-after-signing rejection pass.
- Independent review: two material findings fixed with RED→GREEN regressions: restored first-terminal snapshot coverage; invalid batch response ID sets. No findings deferred.
- No live signing, broadcasting or deployment. Existing live/audit gates remain open. Changes remain on the task branch for review.
