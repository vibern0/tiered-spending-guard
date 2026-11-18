# EURC Passkey Wallet Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local Ethereum Sepolia EURC wallet demo that creates browser passkeys, deploys a fresh guarded Safe, sends Circle EURC, reads balances and history, and warns on policy or topology drift.

**Architecture:** Keep web app unprivileged. A loopback-only backend creates browser-bound passkey signer contracts, provisions fresh Safe topology, relays only exact reviewed Safe executions while external gas key stays outside browser/repository. App reads chain state directly, treats backend responses as submission evidence, never policy authority.

**Tech Stack:** TanStack Start, React, TypeScript, viem, `@simplewebauthn/browser`, `@simplewebauthn/server`, Safe 1.5, Safe passkey contracts, Zodiac Delay, Circle EURC, existing `security-core` deployment and verification tooling.

**Spec:** `packages/security-core/docs/research/2026-09-16-personal-vault-research.md`, `packages/security-core/docs/superpowers/plans/2026-09-16-personal-vault-security-core.md`, `packages/security-core/docs/security/signer-provider-evaluation.md`, `packages/security-core/docs/security/call-graph.md`, and the 2026-10-15 user request.

## Global Constraints

- Ethereum Sepolia only: chain ID `11155111`. No WalletConnect dependency, adapter, connection flow, or signing path.
- Provision a fresh disposable browser-passkey Safe. The existing automated-credential Safe is test evidence, not a user wallet.
- Register distinct primary and secondary WebAuthn credentials. Primary is the Safe owner; secondary is only a `TieredSpendingGuard` co-approver. Recovery is out of scope.
- Backend binds registration and assertion verification to configured RP ID, origin, credential, Safe, chain, exact transaction digest; it never exports credential material.
- Backend binds all submissions to Safe `execTransaction` calls admitted by current guard policy. It rejects direct spending, approvals, Permit/Permit2, batches, delegate calls, arbitrary messages, unlisted modules, arbitrary backend targets.
- The relay gas key is a local secret, not an owner or co-authorizer. Do not expose it in browser bundles, arguments, logs, evidence, or the repository.
- Resolve Circle EURC from a pinned candidate configuration, then fail closed unless Sepolia runtime code and `name`, `symbol`, and `decimals` match the reviewed metadata. Use token base units (`bigint`) and display 6 decimals only after that check.
- Initial recipient additions and every policy weakening must use the existing delayed `repairPolicy` path. The send screen must present an unapproved recipient as a pending policy change, not as an instant send.
- Preserve the X/Y/Z policy, exact Safe transaction binding, cancellation, monitoring, and topology verification. Use test-only `Z = 120` seconds and a `600` second queue execution window.
- Use chain reads as the source for balances, activity, nonces, limits, queues, and alerts. Local state may hold UI/session state only.
- Add every new execution path to `call-graph.md`; add every dependency or protocol-version change to `dependency-review.md`.
- Keep this a testnet prototype. Do not describe it as production-ready, hardware-passkey validated, sponsored, or mainnet-ready.

## Review Focus

1. A cryptographically valid P-256 assertion with the wrong Safe, digest, chain, RP ID, origin, credential, or user-verification state must be rejected before a Safe call is submitted.
2. A browser or backend request for an arbitrary target, selector, approval, Permit/Permit2, batch, delegate call, module invocation, or direct Safe4337 path must fail closed.
3. Partial RPC responses, a wrong chain, a reorged receipt, absent runtime bytecode, or mismatched EURC metadata must make the wallet unhealthy and block writes.
4. A recipient or limit increase shown in the UI before its Delay item executes must remain blocked or marked pending; a user must not infer that it is immediately usable.
5. A bridge restart, duplicate click, uncertain broadcast, or lost response must reconcile Safe nonces and receipts before it offers another submission.

---

## File Structure

- Create: `apps/app/src/lib/vault-chain.ts` - typed Sepolia chain reads and EURC metadata validation.
- Create: `apps/app/src/lib/vault-activity.ts` - event-to-activity and alert projection.
- Create: `apps/app/src/lib/webauthn-passkey.ts` - browser registration and Safe assertion encoding.
- Modify: `apps/app/src/lib/vault-store.tsx` - replace simulation with chain snapshots and backend commands.
- Modify: `apps/app/src/routes/{index,send,activity,limits}.tsx` - onboarding, real wallet send, history, policy state.
- Create: `apps/app/src/components/wallet/topology-alert.tsx` - persistent read-only health and policy alerts.
- Create: `apps/backend/src/{server,config,session,webauthn,vault,journal}.ts` - local bounded provisioning and execution service.
- Create: `apps/backend/tests/**/*.test.ts` - backend and WebAuthn adversarial coverage.
- Modify: `packages/security-core/docs/security/{call-graph,dependency-review}.md` - browser and backend trust boundaries.

### Task 1: Pin EURC And Build Read-Only Chain State

**Files:**
- Create: `apps/app/src/lib/vault-chain.ts`
- Create: `apps/app/src/lib/vault-chain.test.ts`
- Modify: `apps/app/package.json`
- Modify: `packages/security-core/docs/security/dependency-review.md`

**Interfaces:**
- Produces: `readVaultSnapshot(client: PublicClient, config: VaultConfig): Promise<VaultSnapshot>`.
- Produces: `validateEurc(client: PublicClient, candidate: Address): Promise<EurcMetadata>`.
- Produces: `VaultSnapshot` with Safe balance, EURC balance, Safe nonce, guard/Delay/module state, policies, queue items, and health failures.

- [x] **Step 1: Write failing `vault-chain` tests**

Test a valid Sepolia EURC runtime and metadata response, wrong-chain response, empty bytecode, and wrong symbol/decimals. Assert each invalid response returns a blocking health failure and no writable snapshot.

- [x] **Step 2: Run the focused tests**

Run: `npm --prefix apps/app test -- vault-chain.test.ts`

Expected: FAIL because the module does not exist.

- [x] **Step 3: Implement `validateEurc` and `readVaultSnapshot`**

Pin viem and record version/integrity evidence. Use explicit Safe, guard, Delay, EntryPoint-disabled, ERC-20, and event ABIs. Verify chain ID and EURC bytecode plus `name`, `symbol`, `decimals` before exposing balances or send capability.

- [x] **Step 4: Run the focused tests**

Run: `npm --prefix apps/app test -- vault-chain.test.ts`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add apps/app packages/security-core/docs/security/dependency-review.md
git commit -m "feat: add verified vault chain reads"
```

### Task 2: Build Browser Passkey Primitives

**Files:**
- Create: `apps/app/src/lib/webauthn-passkey.ts`
- Create: `apps/app/src/lib/webauthn-passkey.test.ts`
- Modify: `apps/app/package.json`
- Modify: `packages/security-core/docs/security/signer-provider-evaluation.md`

**Interfaces:**
- Consumes: backend registration and assertion challenge payloads.
- Produces: `createVaultPasskey(options: PasskeyRegistrationOptions): Promise<PasskeyRegistration>`.
- Produces: `signSafeDigest(options: SafeAssertionOptions): Promise<EncodedSafeWebAuthnSignature>`.

- [x] **Step 1: Write failing passkey encoding tests**

Test WebAuthn registration serialization and Safe’s `abi.encode(authenticatorData, clientDataFields, r, s)` assertion shape. Test that a changed challenge, RP ID, origin, credential ID, or required user verification is rejected.

- [x] **Step 2: Run the focused tests**

Run: `npm --prefix apps/app test -- webauthn-passkey.test.ts`

Expected: FAIL because the module does not exist.

- [x] **Step 3: Implement browser registration and signing**

Use `@simplewebauthn/browser`. Require platform authenticator and user verification; use backend-provided challenges only. Never persist private key material, passkey assertions, or relay secrets in browser storage.

- [x] **Step 4: Run the focused tests**

Run: `npm --prefix apps/app test -- webauthn-passkey.test.ts`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add apps/app packages/security-core/docs/security/signer-provider-evaluation.md
git commit -m "feat: add browser passkey primitives"
```

### Task 3: Add The Bounded Local Backend And Fresh Vault Provisioning

**Files:**
- Create: `apps/backend/src/{server,config,session,webauthn,vault,journal}.ts`
- Create: `apps/backend/tests/{webauthn,vault,journal}.test.ts`
- Create: `apps/backend/package.json`
- Modify: `.gitignore`
- Modify: `packages/security-core/docs/security/{call-graph,dependency-review}.md`

**Interfaces:**
- Consumes: `PasskeyRegistration`, signed Safe digest assertions, reviewed deployment artifacts, local secret config.
- Produces: `POST /v1/registrations/{role}/options`, `POST /v1/registrations/{role}/verify`, `POST /v1/vaults`, `POST /v1/submissions/prepare`, `POST /v1/submissions/{id}/submit`, and `GET /v1/submissions/{id}`.
- Produces: `VaultProvisioningResult` with Safe, guard, Delay, passkey signer addresses, EURC address, and transaction evidence.

- [x] **Step 1: Write failing backend tests**

Cover distinct primary/secondary credentials; RP ID, origin, user verification, and credential binding; invalid P-256 assertions; an unreviewed artifact; missing local secret; arbitrary deployment payload fields; and duplicate/uncertain submission reconciliation.

- [x] **Step 2: Run the focused tests**

Run: `npm --prefix apps/backend test`

Expected: FAIL because backend does not exist.

- [x] **Step 3: Implement the local-only backend**

Bind only `127.0.0.1`/`localhost`; reject non-local origins and unknown sessions. Persist encrypted or OS-protected registration/session and journal metadata outside the repository. Use existing reviewed deployment runners and topology verification to deploy passkey signer contracts, a fresh Safe, guard, Delay, and initial EURC policy. Backend funded account pays deployment/relay gas but never acts as owner or secondary authorizer.

- [x] **Step 4: Run backend tests and security-core gates**

Run: `npm --prefix apps/backend test && npm --prefix packages/security-core run security:check`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add apps/backend .gitignore packages/security-core/docs/security
git commit -m "feat: add local passkey vault bridge"
```

### Task 4: Replace Simulated App State With A Real Wallet Snapshot

**Files:**
- Modify: `apps/app/src/lib/vault-store.tsx`
- Create: `apps/app/src/lib/vault-store.test.tsx`
- Create: `apps/app/src/components/wallet/topology-alert.tsx`
- Modify: `apps/app/src/routes/index.tsx`

**Interfaces:**
- Consumes: `readVaultSnapshot`, `VaultProvisioningResult`, and backend submission state.
- Produces: `useVault(): VaultStore` with chain-derived balances, policy, health, refresh, provision, and no simulated mutation methods.

- [x] **Step 1: Write failing store tests**

Assert an unprovisioned app displays onboarding; a healthy snapshot exposes balances and policy; every blocking health failure disables write actions; and refresh replaces stale state rather than merging simulated activity.

- [x] **Step 2: Run the focused tests**

Run: `npm --prefix apps/app test -- vault-store.test.tsx`

Expected: FAIL against the current simulated provider.

- [x] **Step 3: Implement chain-backed store and onboarding**

Store only non-secret vault addresses and UI session identifiers. Provision primary then secondary passkeys through backend; render topology and EURC verification before enabling wallet. Make dashboard show EURC/native gas balances, period usage, Safe nonce, active policy.

- [x] **Step 4: Run the focused tests**

Run: `npm --prefix apps/app test -- vault-store.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/app/src
git commit -m "feat: connect wallet demo to vault state"
```

### Task 5: Submit Constrained EURC Sends Through Exact Safe Transactions

**Files:**
- Modify: `apps/backend/src/vault.ts`
- Create: `apps/backend/tests/submit.test.ts`
- Modify: `apps/app/src/routes/send.tsx`
- Create: `apps/app/src/routes/send.test.tsx`

**Interfaces:**
- Produces: `prepareEurcTransfer(input: PreparedEurcTransfer): Promise<SafeExecutionRequest>`.
- Produces: `submitPrimary(requestId: string, signature: EncodedSafeWebAuthnSignature): Promise<SubmissionStatus>`.
- Produces: `submitSecondary(requestId: string, signature: EncodedSafeWebAuthnSignature): Promise<SubmissionStatus>`.

- [x] **Step 1: Write failing execution tests**

Assert an allowlisted EURC `transfer` within X can submit with the primary passkey; above X requires the configured secondary; secondaries alone fail; changed recipient, value, calldata, nonce, chain, operation, or refund fields invalidate both signatures; and duplicate submission reconciles before retry.

- [x] **Step 2: Run focused bridge and send-screen tests**

Run: `npm --prefix apps/backend test -- submit.test.ts && npm --prefix apps/app test -- send.test.tsx`

Expected: FAIL because no exact-send path exists.

- [x] **Step 3: Implement `prepareEurcTransfer` and submission paths**

Accept only one selected, verified EURC `transfer(address,uint256)` with `operation = CALL`, zero Safe value, configured Safe, and an active recipient policy. Sign the exact Safe digest with the applicable browser passkey and preserve the signed request unchanged through relay. Use the guard’s existing X/Y/Delay result to select primary, primary-plus-secondary, or queue flow.

- [x] **Step 4: Run focused tests**

Run: `npm --prefix apps/backend test -- submit.test.ts && npm --prefix apps/app test -- send.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/app/src/routes/send.tsx apps/backend
git commit -m "feat: send EURC with passkey Safe approvals"
```

### Task 6: Surface History, Alerts, And Delayed Recipient Policy Changes

**Files:**
- Create: `apps/app/src/lib/vault-activity.ts`
- Create: `apps/app/src/lib/vault-activity.test.ts`
- Modify: `apps/app/src/routes/{activity,limits,send}.tsx`
- Modify: `apps/app/src/components/wallet/topology-alert.tsx`

**Interfaces:**
- Produces: `projectVaultActivity(logs: readonly Log[], snapshot: VaultSnapshot): WalletActivity[]`.
- Produces: `projectAlerts(snapshot: VaultSnapshot): WalletAlert[]`.
- Produces: `prepareRecipientPolicyRepair(input: RecipientPolicyRepair): Promise<SafeExecutionRequest>`.

- [x] **Step 1: Write failing activity and policy tests**

Test transaction history derives from Safe, guard, and Delay logs; pending/expired/cancelled/executed status uses chain timestamps; mismatched topology, paused bridge, near-limit, failed EURC metadata, and active queued policy repairs become alerts. Test that an unlisted recipient creates only a delayed repair proposal and cannot generate an instant transfer.

- [x] **Step 2: Run focused tests**

Run: `npm --prefix apps/app test -- vault-activity.test.ts`

Expected: FAIL because the projections do not exist.

- [x] **Step 3: Implement projections and UI states**

Decode verified event ABIs, paginate from a configured block floor, and deduplicate by transaction hash/log index. Present regular send, queued send, cancellation, expiry, executed repair, and hard topology failure as distinct states. Use the existing Delay permissionless executor path; do not give the app an arbitrary module path.

- [x] **Step 4: Run focused tests**

Run: `npm --prefix apps/app test -- vault-activity.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/app/src
git commit -m "feat: show vault history and policy alerts"
```

### Task 7: Verify A Fresh Browser-Passkey EURC Wallet On Sepolia

**Files:**
- Create: `packages/security-core/docs/evidence/2026-10-15-eurc-wallet-demo.md`
- Modify: `packages/security-core/docs/security/{call-graph,dependency-review}.md`

**Interfaces:**
- Consumes: provisioned demo vault, bridge journal, exact Safe request/receipt evidence, public Sepolia RPC.
- Produces: a redacted evidence report with explorer links, receipts, state before/after, gas cost, alert state, and limitations.

- [x] **Step 1: Write the live matrix checklist before submitting**

Include: EURC runtime/metadata validation; fresh topology verification; funding; base X transfer; modified-digest denial; Y step-up with both browser passkeys; above-Y queue, early rejection, cancellation, expiry, and elapsed-Z execution; policy-repair recipient addition; and rejected approval, Permit/Permit2, batch, delegate-call, direct module, unknown recipient, wrong-chain, and duplicate submission attempts.

- [x] **Step 2: Run local release gates**

Run: `npm --prefix apps/app test && npm --prefix apps/app run build && npm --prefix apps/backend test && npm --prefix packages/security-core run security:check`

Expected: PASS before live submission.

- [ ] **Step 3: Execute the capped Sepolia rehearsal**

Use a fresh vault and controlled recipients. Reconcile every transaction by Safe nonce, receipt, event logs, and balances before the next action. Stop when the existing per-phase testnet spending cap would be exceeded. Do not rebroadcast uncertainty until journal reconciliation completes.

- [ ] **Step 4: Record evidence and rerun read-only verification**

Run the bridge’s read-only topology and receipt verification commands against every recorded hash. Record factual failures and unresolved limitations; do not substitute bundler simulation or UI state for onchain outcomes.

- [ ] **Step 5: Commit**

```bash
git add packages/security-core/docs/evidence packages/security-core/docs/security
git commit -m "test: record EURC passkey wallet rehearsal"
```

## Deferred Work

- ERC-4337, Safe4337Module, paymasters, sponsorship, and account abstraction stay outside this wallet slice; ordinary Safe transactions must remain functional.
- Real recovery, cross-device passkey recovery, hardware-specific passkey claims, Burner integration, arbitrary ERC-20 support, ENS, fiat pricing, mainnet deployment, and production hardening need separate reviewed plans.

## Plan Self-Review

- [x] Browser primary passkey, secondary guard passkey, fresh Safe topology, Circle EURC validation, balance, transfer, history, and module alerts each map to Tasks 1-7.
- [x] The bridge has an explicit narrow interface, loopback origin boundary, exact digest binding, no WalletConnect, and a local-only relay secret.
- [x] TDD names, interfaces, files, commands, expected outcomes, and commits are specified for every implementation task.
- [x] Review Focus items map to Task 2/3 (assertion binding), Task 5 (call allowlist), Task 1/4 (chain health), Task 6 (pending policy), and Task 3/5 (journal reconciliation).
- [x] The plan preserves delayed policy weakening and does not present arbitrary-recipient sending as an instant wallet capability.
