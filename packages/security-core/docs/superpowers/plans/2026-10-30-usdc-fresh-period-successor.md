# Fresh-Period USDC Successor Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build, review, approve, execute, report one closed 18-action Sepolia USDC successor for period `1793318400`, within 51-USDC aggregate outflow and unchanged ETH ceilings.

**Architecture:** New closed certificate/proposal/CLI/report modules. Reuse journal, state reader, signer loader, adapter, executor, atomic store, providers. Add one sibling. Old lineage frozen. Fresh base alone establishes new USDC window. No Solidity, dependency, EOA, signer, WalletConnect, generic retry, repair change.

**Tech Stack:** TypeScript 5, Hardhat 2, viem 2, Mocha/Chai, existing Sepolia RPC/observer harness.

---

## Fixed authority and evidence

- User approved focused successor, faucet request, 31 new / 51 aggregate gross USDC outflow.
- Keep `0.05 ETH` phase ceiling. Remaining gas allowance: `15955630044456` wei.
- Faucet tx `0x6230026c81cc67ce4aa3cf713838875c7b1d770cbe0f9b48b7b4b3b49f1a59fa`.
- Faucet block `12026817`, hash `0x8bda9049010367bff921be7b89c281c6f30367af9534743463a61859aefe1d83`.
- Both fixed providers: status 1, exact 20-USDC transfer, funder 40 USDC, eight confirmations.
- Scope `ordinary-usdc-fresh-period-successor-v1`.
- Reservation `15340292000000` wei. Spare `615338044456` wei.
- Repair authority: none.

## Task 1: Freeze design and plan

**Files:**
- Add: `packages/security-core/docs/superpowers/specs/2026-10-30-usdc-fresh-period-successor-design.md`
- Add: `packages/security-core/docs/superpowers/plans/2026-10-30-usdc-fresh-period-successor.md`

- [x] Verify builder findings resolved: liquidity, 51-USDC cap, stale-window transition, action/live counts.
- [x] Run `git diff --check`.
- [x] Commit.

```bash
git add packages/security-core/docs/superpowers/specs/2026-10-30-usdc-fresh-period-successor-design.md packages/security-core/docs/superpowers/plans/2026-10-30-usdc-fresh-period-successor.md
git commit -m "docs: design fresh-period USDC successor"
```

## Task 2: Closed source and canonical certificate

**Files:**
- Add: `packages/security-core/scripts/live/ordinary-scenario-usdc-fresh-successor-certificate.ts`
- Add: `packages/security-core/test/unit/security/ordinary-usdc-fresh-successor-certificate.test.ts`
- Add: `packages/security-core/test/support/usdc-fresh-successor-fixture.ts`

- [x] RED: exact journal/source manifest; old 2+stopped lineage; no recycle/repair sibling; faucet receipt/log; six confirmations; funder 40; Safe 0; Safe nonce 10; Delay 4/4; stale raw tuple; equal latest/pending outer nonce; two-provider snapshot/re-read.
- [x] RED: mutate faucet recipient/token/amount/block/hash/balance; old receipt; counter tuple; nonce; runtime; provider agreement; journal suffix; writer files. Fail before opaque certificate.
- [x] Run. Confirm missing-module failures.
```bash
cd packages/security-core && npx hardhat test test/unit/security/ordinary-usdc-fresh-successor-certificate.test.ts
```
- [x] GREEN: strict loader, source hash, primary-evidence parser, two-provider verifier, opaque certificate, serializer/reverifier.
- [x] Derive period only from agreed snapshot. Require later than `1793232000`.
- [x] Bind faucet as source evidence, not successor action or budget credit.
- [x] Run focused and certificate-family tests.
```bash
cd packages/security-core && npx hardhat test test/unit/security/*certificate.test.ts
```
- [x] Scoped review. Fix Critical/Important. Re-run. Commit.
```bash
git add packages/security-core/scripts/live/ordinary-scenario-usdc-fresh-successor-certificate.ts packages/security-core/test/unit/security/ordinary-usdc-fresh-successor-certificate.test.ts packages/security-core/test/support/usdc-fresh-successor-fixture.ts
git commit -m "feat: verify fresh USDC successor source"
```

## Task 3: Exact proposal, catalog, approval

**Files:**
- Add: `packages/security-core/scripts/live/ordinary-scenario-usdc-fresh-successor-proposal.ts`
- Add: `packages/security-core/test/unit/security/ordinary-usdc-fresh-successor-proposal.test.ts`

- [x] RED: literal 18 IDs; 10 broadcasts; 8 proofs; dependencies; Safe nonces 10–16; Delay 4–7; Safe hashes; queue fingerprints; stale prefund tuple; fresh `10/10`, `10/20`, `10/30`; balances; 51 aggregate outflow; reservation.
- [x] RED: old approval/period/commitments; reordered/extra/missing action; arbitrary array; start index; cap increase/reset; wrong terminal `17/7/7`; observer mismatch; deadline/TTL shortage.
- [x] Run. Confirm missing implementation failure.
```bash
cd packages/security-core && npx hardhat test test/unit/security/ordinary-usdc-fresh-successor-proposal.test.ts
```
- [x] GREEN: closed builder, parser, opaque exact approval, attachment/header hash, admission budgets.
- [x] Proposal `authorization: NONE`. Approval binds user authority and `repairAuthority: NONE`.
- [x] Run focused plus old successor/recycle proposal tests.
- [x] Scoped review. Fix Critical/Important. Re-run. Commit.
```bash
git add packages/security-core/scripts/live/ordinary-scenario-usdc-fresh-successor-proposal.ts packages/security-core/test/unit/security/ordinary-usdc-fresh-successor-proposal.test.ts
git commit -m "feat: bind fresh USDC successor approval"
```

## Task 4: Journal, executor, adapter

**Files:**
- Modify: `packages/security-core/scripts/live/ordinary-scenario-executor.ts`
- Modify: `packages/security-core/scripts/live/ordinary-scenario-adapter.ts`
- Add: `packages/security-core/test/unit/security/ordinary-usdc-fresh-successor-executor.test.ts`
- Add: `packages/security-core/test/integration/ordinary-usdc-fresh-successor-adapter.test.ts`

- [x] RED: exact sibling only. Freeze original/recovery/old successor/first15 live. Reject delete, reorder, mixed suffix, header drift, regression, detached mutation, second writer, repair coexistence.
- [x] RED: prefund pre/post and base prestate require certificate stale tuple. Historical base excluded from active-window discovery. Fresh base establishes period. Later rows require fresh period. No generic stale exception.
- [x] RED: one private load/sign/durable hash/broadcast. Drift permanently stops. Known hash reconciles keylessly. Proof rows never broadcast.
- [x] RED: real reader/adapter/store composition uses 18-action view and new live suffix only.
- [x] Run expected failures.
```bash
cd packages/security-core && npx hardhat test test/unit/security/ordinary-usdc-fresh-successor-executor.test.ts test/integration/ordinary-usdc-fresh-successor-adapter.test.ts
```
- [x] GREEN: journal type/decoder/store, execution view, scope mapper, selection, state assertions, receipt transition, adapter projection.
- [x] Preserve old successor/recycle behavior.
- [x] Run focused plus executor/adapter family.
- [x] Scoped review. Fix Critical/Important. Re-run. Commit.
```bash
git add packages/security-core/scripts/live/ordinary-scenario-executor.ts packages/security-core/scripts/live/ordinary-scenario-adapter.ts packages/security-core/test/unit/security/ordinary-usdc-fresh-successor-executor.test.ts packages/security-core/test/integration/ordinary-usdc-fresh-successor-adapter.test.ts
git commit -m "feat: execute fresh USDC successor"
```

## Task 5: Production one-action CLI

**Files:**
- Add: `packages/security-core/scripts/live/ordinary-scenario-usdc-fresh-successor-cli.ts`
- Add: `packages/security-core/test/unit/security/ordinary-usdc-fresh-successor-cli.test.ts`
- Modify: `packages/security-core/package.json` only for closed script entry.

- [x] RED: review rejects private env, creates no authority, uses fixed providers and real loader/reader/store.
- [x] RED: submit/resume require exact artifact hashes, observer evidence, next row, writer lease, period/time/state, signer key match.
- [x] RED: offline real composition reaches one materialization/sign callback then controlled wrong-key failure, zero broadcasts. Chain31337 proves one sign/broadcast.
- [x] RED: expired observer, insufficient group budget, pending hash, wrong faucet source, stale tuple, old-window discovery, second invocation fail closed.
- [x] Run expected failure.
```bash
cd packages/security-core && npx hardhat test test/unit/security/ordinary-usdc-fresh-successor-cli.test.ts
```
- [x] GREEN: implement `review`, `submit-one`, `resume-one`; reuse harness/closed signer loader; sanitize output.
- [x] Run focused plus recycle CLI tests.
- [x] Scoped review. Fix Critical/Important. Re-run. Commit.
```bash
git add packages/security-core/scripts/live/ordinary-scenario-usdc-fresh-successor-cli.ts packages/security-core/test/unit/security/ordinary-usdc-fresh-successor-cli.test.ts packages/security-core/package.json
git commit -m "feat: add fresh USDC one-action CLI"
```

## Task 6: Pure report and docs

**Files:**
- Add: `packages/security-core/scripts/live/ordinary-scenario-usdc-fresh-successor-report.ts`
- Add: `packages/security-core/test/unit/security/ordinary-usdc-fresh-successor-report.test.ts`
- Modify: `packages/security-core/docs/security/call-graph.md`
- Modify: `packages/security-core/docs/security/testnet-runbook.md`
- Modify: `packages/security-core/docs/evidence/2026-10-29-paused-checkpoint.md`
- Add: `packages/security-core/docs/evidence/2026-10-30-usdc-fresh-successor.md`

- [x] RED: report original10, native3, oldUSDC2, stopped869, superseded tails, fresh0–18, repair separate.
- [x] RED: completion requires 25 live, 18 terminal fresh actions, 31 new/51 aggregate outflow, 31 inward, gas, fresh-period receipts, kind-specific alerts, terminal `17/7/7`, Safe0/funder40.
- [x] RED: late receipt, missing inclusion, gas mutation, netting, wrong faucet, header drift, old-row completion, observer mismatch.
- [x] Run expected failure.
```bash
cd packages/security-core && npx hardhat test test/unit/security/ordinary-usdc-fresh-successor-report.test.ts
```
- [x] GREEN: pure renderer. Update call graph/runbook/checkpoint/evidence. No RPC/filesystem/signing.
- [x] Run report tests. Scoped review. Fix Critical/Important. Re-run. Commit.
```bash
git add packages/security-core/scripts/live/ordinary-scenario-usdc-fresh-successor-report.ts packages/security-core/test/unit/security/ordinary-usdc-fresh-successor-report.test.ts packages/security-core/docs/security/call-graph.md packages/security-core/docs/security/testnet-runbook.md packages/security-core/docs/evidence/2026-10-29-paused-checkpoint.md packages/security-core/docs/evidence/2026-10-30-usdc-fresh-successor.md
git commit -m "docs: report fresh USDC successor"
```

## Task 7: Whole-change review and code gate

- [ ] Fresh whole-change reviewer. Fix Critical/Important with RED/GREEN. Rereview.
- [ ] Run full gate. Save raw log outside Git. Restore normal artifacts.
```bash
npm --prefix packages/security-core run security:check
npm --prefix packages/security-core run build
npm --prefix apps/backend test
git diff --check
git status --short
```
- [ ] Record exact HEAD, counts, artifact/log hashes, warnings, skips. Require clean tracked state.

## Task 8: Observer and unsigned artifacts

- [ ] Provision independent receiver. URL/token mode0600 outside repo.
- [ ] Capture startup/probe. Verify official list/raw. Record only public hashes/times/expiry.
- [ ] Require `requiredThrough = readyAt + 11640`; deadline/expiry exceed it.
- [ ] Reverify faucet receipt/transfer with both providers, six confirmations or more.
- [ ] Run production review. Capture RPC proof, certificate, proposal, decoded catalog, caps, reservation, source bytes, HEAD.
- [ ] Confirm no private callback, signing, approval, broadcast.
- [ ] Independent exact-artifact review. Any code change requires new code gate/artifacts.
- [ ] Persist exact machine approval after `ACCEPT`. Bind all hashes. `repairAuthority: NONE`.

## Task 9: One-action live execution

- [ ] One CLI invocation per next approved row.
- [ ] Before financial row: canonical state, period/time, observer, cap, nonce, quote, fee, signer, dependency, pending-hash checks.
- [ ] Broadcast: persist hash first. Reconcile receipt. Wait six confirmations. Validate period/effect/gas.
- [ ] Observer delivery/official acknowledgement only for alert-producing rows. Keylessly confirm before next row.
- [ ] Proof row: exact canonical simulation/proof; no receipt or observer evidence.
- [ ] Wait real 120+600 seconds expiry; real 120 seconds ready. Never shorten.
- [ ] First mismatch stops. Never reset, rematerialize, re-sign, rebroadcast.
- [ ] Update gross accounting after every receipt. Never net.
- [ ] Render final report. Independent evidence review. Commit sanitized evidence/docs only.

## Completion boundary

Success: fresh 18-action matrix complete; 25 total live entries; terminal `17/7/7`; Safe USDC0; funder USDC40; monitoring verified; clean tested HEAD; reviewed evidence. Repair, product/browser/provider gate, native ERC-4337 Tasks1–13, audit, mainnet, production, merge readiness remain open.
