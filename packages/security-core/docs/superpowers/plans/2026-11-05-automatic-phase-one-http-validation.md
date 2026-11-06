# Automatic Phase One HTTP Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Working automatic provisioning/recovery; prove frontend-equivalent backend HTTP calls with real software WebAuthn signatures.

**Architecture:** Keep existing automatic app → backend → reviewed executor. Fix RPC reads at their responsible adapter. Recover only fully verified known hashes/confirmed signer prefixes; retain original records and publish any new unsigned successor before local per-transaction authorization. No operator command, browser-selected deployment bytes, or blind rebroadcast.

**Tech Stack:** Existing TypeScript, viem, Node HTTP, SimpleWebAuthn, Hardhat, Vitest. No contracts/dependencies/database changes.

**Spec:** `../specs/2026-11-05-phase-one-automatic-setup-requirement.md`; existing automated provisioning and verified successor designs. User explicitly requested implementation and HTTP endpoint testing with simulated passkeys.

## Global Constraints

- Sepolia only; two fixed read providers; loopback backend remains browser write boundary.
- Preserve old vault/20 USDC, current credentials, two confirmed signer deployments and every original record.
- No manual setup command, file selection, nonce editing or routine restart required.
- Exact current nonce fetched live. A changed nonce never silently changes an already authorized transaction.
- A successor may preserve only an exactly verified signer prefix of length 1 or 2 before any other component exists. All consumed nonces require canonical two-provider receipt/envelope proof. Reuse existing successor verification; any changed layout creates a distinct retained unsigned package and fresh exact authorizations.
- Pending signed transactions reconcile their exact recorded hash; no fresh signature/broadcast until resolved. Unsupported drift fails closed.
- No mock success in production or bypass of WebAuthn checks. Endpoint tests use fresh software P-256 credentials, a local isolated chain and no user secrets/assets.
- No commit/push. Preserve unrelated worktree changes. Serialize compiler/artifact-mutating checks.

## Review Focus

- Wrapped RPC not-found vs contract revert: retry only recognized read errors; never sendRawTransaction.
- Lost response/pending receipt: exact hash reconciliation precedes quote/authorization; no stale-envelope replacement.
- Shared payer nonce advancement: verified consumed lineage only; no address/code ambiguity or changed confirmed prefix.
- HTTP payloads: genuine registration, origin/RP, role order, replay rejection, canonical bigint wire format.
- Server restart/duplicate requests: one deployment; immutable records; current vault and rebind readiness accurate.

---

### Task 1: Complete HTTP Cryptography Harness

**Files:** new `apps/backend/tests/automatic-http.integration.test.ts`; test-only helpers as needed, reusing existing real-EVM fixture behavior.

**Interfaces:** actual `createConfiguredBackend`, HTTP registration/options/verify, auto-provision, current vault, approval/submit/status and rebind endpoints. Existing dependency injection may substitute only local RPC transport/payer and genuine automatic provisioner; never registration/assertion verifiers or proof branding.

- [x] RED full HTTP registration → automatic provision → actual passkey-approved send. Add malformed origin/challenge, duplicate operation, restart rebind and exact-hash recovery cases.
- [x] Implement software WebAuthn attestation/assertions and isolated canonical contract fixture. Exercise all spending/recipient/queue lifecycle through HTTP with actual core validation.
- [x] GREEN full backend HTTP proof; label local token/software-device limits.

### Task 2: Fix Automatic Recovery at Proven Boundaries

**Files:** `apps/backend/src/provisioner.ts`, `main.ts`/handlers only as needed; core `src/pwa/provisioning.ts`, `provisioning-recovery.ts` or focused automatic-recovery module; facade declarations/exports; regression tests.

**Interfaces:** retain normal HTTP API. Fixed read adapters expose redacted error cause categories and canonical transaction lookup required for verified consumed-lineage discovery. Automatic provisioner owns reconstruction/resume; browser sends only existing empty provisioning intent.

- [x] Diagnose actual gas-estimation cause with read-only reproduction; capture a regression before changing retry behavior.
- [x] RED pending known-hash retry without new authorization; verified signer-prefix successor discovery on live nonce drift; reject peer/block/envelope/code/prefix changes.
- [x] Implement narrow read handling and automatic verified recovery. Preserve original package/journal hashes; write distinct successor lineage/package before signing; keep original verification and budget gates.
- [x] Remove routine restart/manual-file advice from product recovery messages; automatic retry/reconciliation must perform the work safely.
- [x] GREEN focused core/backend tests and real HTTP cases for transient failure, consumed nonce and restart.

### Task 3: Final Verification and Live Closeout

**Files:** call graph, recovery design/runbook, current plan checkboxes; app recovery tests/copy if affected.

- [x] Independent review; full core/backend/app checks appropriate to changes; no compiler-clean races.
- [x] Restart updated backend with preserved external records; automatically verify/resume current setup under original deployment authorization. No new device credentials or old-fund movement.
- [x] Verify completed live topology and exact journal receipts, or report the remaining concrete safe blocker. Distinguish successful endpoint simulation from live hardware/browser completion.
- [x] Keep HTTPS/mobile as next Phase One milestone; Phase Two remains out of scope.

## Self-Review

Spec covered by automatic flow, verified recovery, HTTP proof and preservation gates. Existing manual-command proposal remains rejected. User chose implementation plus frontend-equivalent endpoint tests; proceed without another workflow approval round. No broad account-registry rewrite is needed to fix this flow.

## Verification Evidence — 2026-11-05

- Core: 845 passing; 2 pre-existing external-artifact pending tests.
- Backend: 18 files, 129 passing; typecheck passed. Three actual HTTP/local-EVM scenarios: fresh, lost broadcast response, consumed unrelated nonce. Real software P-256 registration/assertions; actual Safe/passkey/guard/Delay validation. Base, step-up, delayed, shared-Y, recipient maintenance, cancellation, expiry, execution, duplicate calls, restart/current-vault/rebind tested.
- Consumed-nonce case first observes an actual unconfirmed historical anchor; five actual local blocks are mined afterward. Same HTTP request waits, fully verifies, then continues without extra authorization/broadcast.
- App: 20 files, 157 passing; build/typecheck passed; lint zero errors with 20 existing Fast Refresh warnings.
- Independent read-only review: reported three defects; each fixed with regression evidence. Final confirmation wait/startup/completed restore reread found no additional material issue.
- Live provider diagnosis: fixed provider 1 intermittently returns `-32000` historical-state-unavailable for exact historical nonce reads. Added narrowly matched, bounded, same-read retry; two new regressions captured RED then GREEN. No provider replacement or skipped evidence.
- Original historical records and backup hashes match; original fresh review/authorization hashes match. Original two confirmed signer entries retained. Live automatic resume reached setup-helper broadcast at nonce 1069; completion evidence follows below.
- Software-device/local-token tests do not prove hardware browser UX or the live Circle implementation. HTTPS/mobile and independent alert delivery remain separate Phase One gates.

## Live Closeout

- Normal empty HTTP provisioning request returned 200. Confirmed original signer nonces 1065/1066; verified unrelated consumed nonces 1067/1068; new suffix 1069..1073. Every row is successful with canonical six-confirmation proof and final topology verification.
- New Safe: `0x5C237D200dF5b7B8959054fb51c368Ca5120847f`. Setup receipt: `0x92850c3955bad3f41f15601370ad40a87e492569b3f8748a0b2a33027064d8f3`, block `12071332`.
- Restarted the ordinary backend without the temporary read-only RPC diagnostic wrapper. Startup succeeded; immediate `GET /v1/vaults/current` returned 200 with the same account and both roles requiring genuine rebind. Provisioning journal, authorizations and managed lineage hashes are unchanged across restart; no deployment replay.
- Both fixed providers report old vault USDC units `20000000` and new vault `0`. No token movement. Old operational originals/copies and original fresh review/authorization hashes remain identical.
- Browser automatically received the result after reload and visibly shows “Deployment verified. Verify both existing signers to unlock vault actions.” Actual passkey assertions require the user; no synthetic credential was applied to the live vault.
- Public operational evidence retained outside the repository at `~/.tiered-spending-guard/pwa-2026-11-05-v2/automatic-recovery-live-verification.json`. Backend remains running on loopback.
- Screenshot capture was unavailable because the Mac was locked; browser accessibility state confirmed the completed deployment and first signer verification button. No attempt to unlock or bypass the lock.
