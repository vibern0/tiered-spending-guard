# Current PWA Sending and Fresh Vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete reviewed current-profile sends; deploy fresh Sepolia vault after actual user passkey registration. Preserve old vault/files/20 test USDC.

**Architecture:** Reuse approved base-open/elevated-allowlisted guard and backend submission seams. Core re-verifies original artifact/topology commitments plus current onchain recipient list at one block; only full verification creates a fresh provisioning capability. Backend composes closed intent preparation, simulation, verified WebAuthn payload encoding, exact outer-envelope signing, durable hash-before-broadcast, reconciliation, and read-only receipt observation. Browser distinguishes provisioning readiness from sending readiness and archives old account metadata before new setup.

**Tech Stack:** Existing TypeScript, viem, Safe 1.5, Zodiac Delay, WebAuthn, Hardhat, Vitest; no dependency changes. The user approved the focused existing setup-helper ABI correction in `../specs/2026-11-05-current-profile-atomic-setup-mode-proposal.md` after the real deployment regression exposed the missing recipient mode.

**Spec:** `packages/security-core/docs/superpowers/specs/2026-11-04-base-lane-open-destinations-design.md` and existing automated local-provisioning design.

## Global Constraints

- Sepolia only; fixed read providers; `apps/backend` sole browser write boundary. Only the accepted helper/encoder correction extends the original Solidity scope; no new contract or authority.
- Preserve exact Safe/guard/Delay/signer/code identities; zero Safe gas/refund/value; native/ERC20 scope unchanged. No WalletConnect, AA, EOA vault owner, hidden relay authority, new Solidity, or mainnet.
- Only current recipients vary after an exact delayed policy update. Fixed X/Y/Z/mode and all other topology invariants remain verified; no clone/test branding in production.
- Historical vault remains read-only. Original journal/review/sidecars and browser metadata preserved separately; no old balance migration.
- Hashes of original deployment packages/plans never change. Fresh transport infrastructure hash may include current payer nonce; never confuse it with stable PWA deployment identity.
- Revalidate before approval/sign/broadcast; persist exact signed outer hash before broadcast. Shared payer operations serialize. Pending/uncertain entries reconcile by exact hash; never re-sign blindly.
- User performs actual new passkey device ceremonies. Do not generate substitute credentials or claim automated cryptography as hardware UX.
- No commit/push; preserve unrelated worktree changes.

## Review Focus

- Missing/changed code, policy, chain, block, signer, queue or nonce → fail before signing.
- Policy-hash drift during delayed recipient addition → stale; no full-policy overwrite.
- Add-recipient queue cancellation/execution/expiry → exact closed maintenance tuple only.
- Duplicate IDs/tabs and shared payer races → one exact durable envelope; uncertain hash never replayed with fresh nonce.
- Read-only observer results never authorize; successful chain receipts require canonical depth and exact effects.
- Empty new onboarding must remain possible while `writesReady:false`; no false readiness.
- Fresh account setup must not overwrite the only old metadata copy or retain old submission IDs.

### Task 1: Core Current-Profile Reverification and Maintenance Lifecycle

**Files:** core `src/pwa/provisioning.ts`, `intents.ts`, `observer.ts`, facade exports/declarations, `src/topology/verify.ts`, focused real-Safe/PWA tests.

**Interfaces:** produce `verifyPwaSubmissionState({plan,vault,client,blockNumber})` with fresh branded vault, verified current policy/infrastructure/topology evidence; preserve stable deployment commitments. Extend only canonical recipient-maintenance lifecycle and observer policy-transition evidence.

- [x] RED evidence mutation, recipient-policy refresh, maintenance lifecycle and observer tests.
- [x] Implement exact production re-verifier; current-mode topology read/check; closed repair execution/cancel/expiry and receipt effects.
- [x] GREEN focused/full core gates; independent implementation review. No audit claim.

### Task 2: Default Concrete Backend Runtime

**Files:** `apps/backend/src/submission-runtime.ts`, `main.ts`, `provisioner.ts`, `handlers.ts`, `vault.ts`, `server.ts`, facade as needed; backend tests.

**Interfaces:** preserve existing `ConfiguredSubmissionRuntime` operations. Server-held vault retains original plan; handlers alone validate browser assertions/counters. Runtime privately retains branded prepared intent, snapshot, approved payloads, exact raw outer envelope and public observer evidence. Readiness distinguishes provisioning from sending.

- [x] RED normal composition, base/elevated/add-recipient/lifecycle, stale/duplicate/restart/payer races, malformed inputs.
- [x] Implement fixed-provider snapshots and simulation; primary-first signatures; exact durable-envelope transport/reconciliation/observation.
- [x] GREEN final backend suite/typecheck: 110 tests. Real-cryptography complete local lifecycle proof passed.

### Task 3: Preserve Browser Account and Ready Fresh Onboarding

**Files:** app vault store, onboarding/readiness UI and focused tests.

- [x] RED archive-before-reset, failed archive/no reset, no old submissions, provisioning-ready/write-unready setup.
- [x] Add explicit fresh-test-vault action preserving old config/UI by Safe address. No generic account manager or credential copying.
- [x] GREEN app tests/build/typecheck (129 tests); lint zero errors, 20 existing refresh warnings. Five pre-existing formatting failures corrected without semantic changes.

### Task 4: Review, Fresh Operational Lineage, and Live Gates

- [x] Update call graph, runbook and prior plan checkboxes from evidence. Run core/backend/app suites and independent implementation review.
- [x] Preserve old operational-file hashes; prepare separate external submission/provisioning/review paths and archive metadata. Keep secrets outside repository/logs. Five original public files copied byte-for-byte with SHA-256 manifest; all original/archive hashes rechecked unchanged after switching configuration.
- [x] Start concrete backend, verify provisioning-ready/write-unready health, open archived/new onboarding state. Browser archive-before-reset completed and fresh setup survived reload. Backend HTTP 200: provisioningReady true, writesReady false; no fresh journal/review package or vault yet.
- [ ] User creates/verifies two actual new passkeys; automatic local authorizer then writes unsigned package and executes seven reviewed transactions with six confirmations.
- [ ] Verify fresh topology/current policy and browser binding. Exercise low-value base/unlisted, delayed addition, step-up/new recipient and delayed/new recipient receipt evidence only with user factor approvals and sufficient test USDC. No user-facing completion claim before its corresponding proof.

## Verification / Handoff

- Core: 832 passing; 2 pre-existing external-artifact tests pending. Full suite includes invariant tests.
- Backend: 110 passing; TypeScript green. Real local EVM: seven deployments; software P-256 + actual ERC-1271; base/unlisted, step-up, queue/early/ready, add-recipient/ready/new-recipient step-up, cancel/replay, expiry/skip, delayed new-recipient execution; six-confirmation observations and exact-hash restart recovery.
- App: 129 passing; build/TypeScript/lint green. Lint retains 20 nonblocking React refresh warnings. Pure formatting corrections verified against Prettier of unchanged source.
- Slither: 69 contracts, 79 detectors; 12 individually reviewed existing findings, no new detector/function identities. Nine exact baseline line anchors updated; filters unchanged.
- Scoped `git diff --check -- apps packages/security-core`: green. Unrelated Codacy edits preserved; no commit/push.
- Old Safe `0x9f27A03c32D6811548d3a69835Fbb758cf4A9086`: browser showed 20 USDC before archive. No transaction sent to it.
- Separate external lineage: `/Users/bernardo/.tiered-spending-guard/pwa-2026-11-05-v2/`; preserved public records + manifest under `preserved-old-vault/`; prior secret configuration retained outside repository. Fresh backend configuration active; original public records unchanged.
- Browser open: `http://localhost:5173/onboarding`, **Register first signer**. User device ceremonies pending. No fresh Sepolia deployment or live transfer claimed; software rehearsal does not substitute for hardware or live Circle behavior.
