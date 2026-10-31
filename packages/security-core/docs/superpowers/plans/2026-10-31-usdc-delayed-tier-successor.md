# USDC Delayed-Tier Successor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish missing Sepolia USDC expiry and ready Z evidence with one five-row append-only successor.

**Architecture:** Add distinct certificate, proposal, storage sibling, execution view, CLI, report. Reuse reviewed delayed-completion adapters and one-action executor. Freeze all predecessor bytes.

**Tech Stack:** TypeScript, viem, Hardhat, Mocha, Chai, existing Sepolia harness.

**Spec:** `packages/security-core/docs/superpowers/specs/2026-10-31-usdc-delayed-tier-successor-design.md`

## Global Constraints

- Preserve old delayed-completion attachment byte-for-byte. Row 9 stays hashless `signed-simulated` at outer nonce `916`.
- Five rows only. Three broadcasts. Two proofs. No extra USDC. No repair.
- New gross USDC `31,000,000`; aggregate gross USDC `51,000,000`; inward USDC `0`.
- New reservation `2,600,000,000,000` wei. Whole phase below `0.05 ETH`.
- One attempt per broadcast row. Exact artifact review before approval and live execution.
- Use TDD. Update call graph and evidence.

## Review Focus

- Any predecessor-byte change, old-row regression, deleted old attachment, or second successor must reject.
- Source must require exact progressed state: 19 live entries, rows 1–8 terminal, row 9 stopped, rows 10–13 untouched.
- Expired and early proofs must never materialize, sign, or broadcast.
- Outer nonce drift after materialization must freeze only selected successor row.
- Period deadline, observer expiry, queue mismatch, receipt reorg, or cap drift must stop before broadcast.

---

### Task 1: Certificate and Five-Row Proposal

**Files:**
- Create: `packages/security-core/scripts/live/ordinary-scenario-usdc-delayed-successor-certificate.ts`
- Create: `packages/security-core/scripts/live/ordinary-scenario-usdc-delayed-successor-proposal.ts`
- Create: `packages/security-core/test/support/usdc-delayed-successor-fixture.ts`
- Create: `packages/security-core/test/unit/security/ordinary-usdc-delayed-successor-certificate.test.ts`
- Create: `packages/security-core/test/unit/security/ordinary-usdc-delayed-successor-proposal.test.ts`

**Interfaces:** Produce opaque `VerifiedUsdcDelayedSuccessorCertificate`, exact `UsdcDelayedSuccessorProposal`, opaque approval, attachment builder.

- [x] **Step 1: Write failing source/certificate tests.** Assert exact predecessor rows/statuses, 19-entry suffix, `13/6/5`, balances `31/9`, expired queue 5, two-provider agreement, nonce lower-bound, production/test authority separation.
- [x] **Step 2: Run certificate test.** Expected: fail because module/API does not exist.
- [x] **Step 3: Implement certificate.** Source hash includes entire predecessor journal. Production loader pins exact public identities and stopped row.
- [x] **Step 4: Run certificate test.** Expected: pass.
- [x] **Step 5: Write failing proposal tests.** Assert literal five rows, exact transactions/signers/dependencies, `13/6/5` to `14/7/7`, `31/9` to `0/40`, reservation, 31/51 caps, no funding, no repair, approval binding, duplicate attachment rejection.
- [x] **Step 6: Run proposal test.** Expected: fail because proposal API does not exist.
- [x] **Step 7: Implement proposal, parser, approval, attachment.** No generic catalog builder.
- [x] **Step 8: Run focused predecessor plus successor tests.** Expected: pass.
- [x] **Step 9: Commit.** Message: `feat: add delayed tier successor proposal`.

### Task 2: Atomic Execution, CLI, Report

**Files:**
- Modify: `packages/security-core/scripts/live/ordinary-scenario-executor.ts`
- Modify: `packages/security-core/scripts/live/ordinary-scenario-adapter.ts`
- Create: `packages/security-core/scripts/live/ordinary-scenario-usdc-delayed-successor-cli.ts`
- Create: `packages/security-core/scripts/live/ordinary-scenario-usdc-delayed-successor-report.ts`
- Create: `packages/security-core/test/unit/security/ordinary-usdc-delayed-successor-executor.test.ts`
- Create: `packages/security-core/test/integration/ordinary-usdc-delayed-successor-adapter.test.ts`
- Create: `packages/security-core/test/unit/security/ordinary-usdc-delayed-successor-cli.test.ts`
- Create: `packages/security-core/test/unit/security/ordinary-usdc-delayed-successor-report.test.ts`

**Interfaces:** Consume Task 1 artifacts. Produce closed execution view, atomic projection, `review|submit-one|resume-one`, terminal renderer.

- [x] **Step 1: Write failing executor/store tests.** Assert predecessor freeze, one sibling, one selected row, durable hash, keyless resume, proof zero-broadcast, drift stop, exact live suffix.
- [x] **Step 2: Run executor test.** Expected: fail because successor execution API/storage field does not exist.
- [x] **Step 3: Implement journal parser, monotonic store, selector, execution view.** Reuse core executor. No retry path.
- [x] **Step 4: Run executor plus delayed-completion tests.** Expected: pass.
- [x] **Step 5: Write failing adapter/CLI/report tests.** Assert production composition, no provider override, exact approval, one action, terminal receipts/proofs/accounting, honest old-row reporting.
- [x] **Step 6: Run tests.** Expected: fail because CLI/report APIs do not exist.
- [x] **Step 7: Implement adapter integration, CLI, report.** Reuse reviewed signer, RPC, observer, broadcast boundaries.
- [x] **Step 8: Run focused successor plus predecessor families.** Expected: pass.
- [x] **Step 9: Commit.** Message: `feat: execute delayed tier successor`.

### Task 3: Docs, Independent Review, Exact Gate

**Files:**
- Modify: `packages/security-core/docs/security/call-graph.md`
- Modify: `packages/security-core/docs/security/testnet-runbook.md`
- Modify: `packages/security-core/docs/evidence/2026-10-30-usdc-fresh-successor.md`

**Interfaces:** Consume Task 2 implementation. Produce reviewed exact code head for Task 4.

- [x] **Step 1: Document successor only.** Record stopped row, new sibling, three-broadcast/two-proof path, no repair.
- [x] **Step 2: Run focused tests.** Expected: pass.
- [x] **Step 3: Request fresh whole-change review.** Fix every Critical/Important via RED/GREEN. Expected: ACCEPT.
- [x] **Step 4: Run exact gate.** `npm --prefix packages/security-core run security:check`; normal build; backend tests; `git diff --check`. Expected: pass with documented baseline only.
- [x] **Step 5: Bind clean HEAD/tree/log hashes.** No signing or broadcast.
- [x] **Step 6: Commit.** Message: `docs: bind delayed tier successor gate`.

### Task 4: Fresh Artifacts and Live Five-Row Evidence

**Files:**
- Create ignored workspace artifacts only until terminal public evidence is reviewed.
- Modify tracked evidence only after verified terminal state.

**Interfaces:** Consume exact Task 3 head. Produce fresh observer, certificate, unsigned proposal, proof bundle, independent artifact verdict, exact approval, three receipts, two rejection proofs, terminal report.

- [x] **Step 1: Revalidate observer coverage and current two-provider state.** Expected: exact source; fresh current/pending nonce agreement.
- [x] **Step 2: Generate unsigned certificate/proposal/RPC proof/binding.** Expected: five rows, no signing, no broadcast.
- [x] **Step 3: Independently replay artifacts.** Expected: ACCEPT; no Critical/Important.
- [x] **Step 4: Mint exact approval after ACCEPT.** Bind user authority, caps, code head, observer, no repair.
- [x] **Step 5: Execute one row per invocation.** Reconcile six confirmations and required observer acknowledgement before next broadcast. Preserve real 120-second wait.
- [x] **Step 6: Render and independently review terminal report.** Expected: 22 live entries; `14/7/7`; Safe/funder USDC `0/40`; old stopped rows unchanged.
- [x] **Step 7: Update evidence and completed checkboxes only.** Commit verified public evidence.

## Completion Boundary

Five terminal successor rows. Three canonical receipts. Two zero-broadcast proofs. 22 live entries. Terminal `14/7/7`. Safe/funder USDC `0/40`. 31 new and 51 aggregate gross USDC. No repair. Native AA remains blocked until remaining ordinary gates close.
