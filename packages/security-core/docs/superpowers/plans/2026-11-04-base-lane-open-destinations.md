# Base-Lane Open-Destinations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a fresh Phase One Sepolia vault permit valid first-signer USDC transfers to any address while preserving allowlisted step-up/delayed transfers, delayed stale-safe recipient additions, and a usable reviewed backend submission boundary.

**Architecture:** Add an explicit per-asset base-recipient mode to `TieredSpendingGuard`; it permits any non-zero recipient only during base authorization, retains the existing allowlist for step-up and Delay, and includes the mode in the policy hash. Replace delayed full-policy repair with a policy-hash-bound version that rejects stale execution. Carry the new profile/version through provisioning, snapshot/intents, backend runtime, and the app; old profiles and deployments remain read-only/incompatible.

**Tech Stack:** Solidity 0.8.24, Hardhat, TypeScript, viem, React, SimpleWebAuthn, Vitest, pnpm.

**Spec:** `packages/security-core/docs/superpowers/specs/2026-11-04-base-lane-open-destinations-design.md`

## Global Constraints

- Sepolia only (`11155111`); testnet research only—no mainnet or production claim.
- `apps/backend` remains the only browser write boundary. Browser input is closed intent data only.
- Base permits only USDC `transfer(address,uint256)`, zero Safe value/gas/refund fields, `CALL`, configured primary contract signature, positive amount, existing X/Y caps, and a non-zero recipient.
- Step-up and delayed transfer paths require an exact onchain allowlisted recipient and retain primary-plus-one-configured-secondary approval.
- Recipient addition is a delayed primary-plus-secondary change, binds the current guard policy hash, and fails on any policy-hash drift before execution.
- No empty recipient set is an implicit wildcard; profiles predating an explicit base-recipient mode fail closed for writes.
- No WalletConnect, ERC-4337, user EOA, browser signer/relay capability, generic messages, approvals, batches, delegatecalls, new dependencies, or new custom security-critical contract.
- Do not overwrite or commit the pre-existing user changes in this dirty worktree. Stage only files owned by a task if a commit is safe; otherwise record the verification result without committing.

## Review Focus

- A step-up or delayed transfer to an unlisted recipient must fail even when the recipient is valid and within its amount limit (Task 1/2).
- A base transfer to zero, malformed calldata, another token, nonzero Safe value, delegatecall, wrong signer, or stale counter must fail (Task 1/2).
- A queued recipient addition must fail if a limit, recipient list, recipient mode, signer, Delay timing, or other policy-hash input changes before execution (Task 1/3).
- A legacy profile/deployment cannot be interpreted as open-base-recipient mode or become writable after the update (Task 2/4).
- The default backend must not enable Send without the complete snapshot, simulation, signature encoding, revalidation, broadcast, reconciliation, and observer composition (Task 3/4).

---

### Task 1: Enforce tier-specific recipient policy and stale-safe repairs onchain

**Files:**
- Modify: `packages/security-core/contracts/TieredSpendingGuard.sol`
- Modify: `packages/security-core/src/config/policy.ts`
- Modify: `packages/security-core/src/policy/classify.ts`
- Modify: `packages/security-core/test/unit/policy/classify.test.ts`
- Modify: `packages/security-core/test/unit/guard/spending.test.ts`
- Modify: `packages/security-core/test/integration/guard-spending.test.ts`
- Modify: `packages/security-core/test/integration/delayed-tier.test.ts`
- Modify: `packages/security-core/test/invariant/call-graph.invariant.ts`

**Interfaces:**
- Add `baseRecipientMode: "allowlisted" | "any-valid-address"` to TypeScript `AssetPolicy`; policy validation requires this explicit discriminant.
- Extend Solidity asset policy with `baseRecipientMode`; expose it through the asset-policy read ABI and include it in `policyHash()`.
- Replace `setAssetPolicy` with canonical calldata that includes the mode. Replace `repairPolicy` with canonical calldata including `bytes32 expectedPolicyHash` and reject unless it equals the pre-mutation `policyHash()`.
- Base authorization accepts a non-zero recipient when and only when mode is open. Step-up, queued delayed transfer, and delayed execution always require `allowedRecipient[token][recipient]`.

- [ ] **Step 1: Write failing policy-classifier tests**

Name the breaks: `base open mode accepts an unlisted valid USDC recipient`, `step-up rejects an unlisted recipient in open base mode`, `delayed rejects an unlisted recipient in open base mode`, and `legacy asset policy without explicit mode is rejected`.

- [ ] **Step 2: Run RED policy tests**

Run: `pnpm --dir packages/security-core exec hardhat test test/unit/policy/classify.test.ts`

Expected: FAIL because the mode is absent and all tiers still share the recipient check.

- [ ] **Step 3: Implement minimal typed policy/classifier support**

Update `decodeTransfer` to return a valid transfer independently of recipient membership; decide recipient eligibility after the lane is known so base-only can use `any-valid-address`. Keep every selector, token, value, operation, cap, counter, and signer check unchanged.

- [ ] **Step 4: Run green policy tests**

Run: `pnpm --dir packages/security-core exec hardhat test test/unit/policy/classify.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing real-Safe guard tests**

Use the existing fixtures to prove primary-only unlisted base success; primary-only base still respects X/Y; secondary-approved unlisted step-up and delayed queue revert; listed step-up/delayed flows continue. Add an exact delayed repair whose captured `expectedPolicyHash` becomes stale after a tightening/addition/mode change, then assert execution reverts and state is unchanged.

- [ ] **Step 6: Run RED guard tests**

Run: `pnpm --dir packages/security-core exec hardhat test test/unit/guard/spending.test.ts test/integration/guard-spending.test.ts test/integration/delayed-tier.test.ts`

Expected: FAIL because contract ABI/authorization does not implement the policy mode or stale repair binding.

- [ ] **Step 7: Implement the minimal guard change**

Update selectors, canonical ABI decoders, immediate-tightening comparison, queue validation, delayed execution validation, policy hash, and storage reset together. Compare the supplied policy hash before `repairPolicy` mutates state. Do not add an unrestricted maintenance selector or use `tx.origin`/executor identity.

- [ ] **Step 8: Run guard and invariant verification**

Run: `pnpm --dir packages/security-core exec hardhat test test/unit/guard/spending.test.ts test/integration/guard-spending.test.ts test/integration/delayed-tier.test.ts test/invariant/call-graph.invariant.ts`

Expected: PASS.

- [ ] **Step 9: Commit only if isolated**

Stage only the Task 1 files and commit `feat: scope recipients to elevated vault tiers`; otherwise record why the dirty worktree prevents a safe commit.

### Task 2: Version the Phase One profile and closed intent model

**Files:**
- Modify: `packages/security-core/config/sepolia.pwa-phase-one.json`
- Modify: `packages/security-core/src/pwa/profile.ts`
- Modify: `packages/security-core/src/pwa/provisioning.ts`
- Modify: `packages/security-core/src/pwa/intents.ts`
- Modify: `packages/security-core/src/transport/types.ts`
- Modify: `packages/security-core/src/transport/validate.ts`
- Modify: `packages/security-core/test/unit/pwa/profile.test.ts`
- Modify: `packages/security-core/test/unit/pwa/intents.test.ts`
- Modify: `packages/security-core/test/integration/pwa-intents.test.ts`
- Modify: `packages/security-core/test/integration/pwa-provisioning.test.ts`

**Interfaces:**
- Introduce a new explicit Phase One profile format containing `baseRecipientMode: "any-valid-address"` and non-empty `elevatedRecipients`; reject prior format versions in write-capable loaders.
- `VerifiedPwaSnapshot` carries the explicit mode and elevated recipient set read at one pinned block; it no longer treats one fixed recipient as universal policy.
- `preparePwaIntent` accepts a browser transfer recipient only as a canonical address; it builds base for any valid recipient, but builds step-up/queue only for an elevated allowlisted recipient.
- Add `add-recipient` as a signed prepared PWA intent. It contains the candidate address and exact Safe-to-Delay `repairPolicy(expectedPolicyHash, current policy values, current recipients + candidate)` transaction; all other fields come from the verified snapshot.

- [ ] **Step 1: Write failing profile and intent tests**

Assert old profile JSON rejects, committed new profile accepts, base supports an unlisted recipient, elevated intents reject it, a new recipient addition requires both approvals and embeds snapshot policy hash, and cloned/mutated mode/list/hash/recipient/queue fields reject.

- [ ] **Step 2: Run RED core PWA tests**

Run: `pnpm --dir packages/security-core exec hardhat test test/unit/pwa/profile.test.ts test/unit/pwa/intents.test.ts test/integration/pwa-intents.test.ts test/integration/pwa-provisioning.test.ts`

Expected: FAIL because the profile fixes one recipient and intent snapshots have no recipient mode or maintenance intent.

- [ ] **Step 3: Implement closed v2 profile, provisioning, and intent flow**

Update the exact-profile parser, deterministic plan policy, snapshot reader/binder, canonical prepared-intent validation, and expected-approval mapping. Preserve test-only branding and exact canonical encoding. Reject a snapshot whose deployed mode/list disagrees with the verified profile.

- [ ] **Step 4: Run green core PWA tests**

Run: `pnpm --dir packages/security-core exec hardhat test test/unit/pwa/profile.test.ts test/unit/pwa/intents.test.ts test/integration/pwa-intents.test.ts test/integration/pwa-provisioning.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit only if isolated**

Stage only Task 2 files and commit `feat: version PWA recipient tier policy`; otherwise record the safe non-commit ruling.

### Task 3: Compose a default reviewed submission runtime and recipient-addition API

**Files:**
- Create: `apps/backend/src/submission-runtime.ts`
- Modify: `apps/backend/src/config.ts`
- Modify: `apps/backend/src/main.ts`
- Modify: `apps/backend/src/handlers.ts`
- Modify: `apps/backend/src/server.ts`
- Modify: `apps/backend/src/vault.ts`
- Modify: `apps/backend/src/provisioner.ts`
- Modify: `apps/backend/tests/backend-surface.test.ts`
- Modify: `apps/backend/tests/config.test.ts`
- Modify: `apps/backend/tests/handlers.test.ts`
- Modify: `apps/backend/tests/server.test.ts`
- Modify: `apps/backend/tests/submit.test.ts`
- Modify: `apps/backend/README.md`

**Interfaces:**
- `createConfiguredSubmissionRuntime(config, verifiedVault, credentials)` supplies every `ConfiguredSubmissionRuntime` operation from closed security-core PWA intent, simulation, signature, transport, reconciliation, and observer boundaries; it returns no runtime if any identity/read/write prerequisite cannot be constructed.
- `GET /health` adds `writesReady: boolean`. The app must use it as a precondition; a default backend cannot offer a route guaranteed to return `submission preparation unavailable`.
- Extend browser `BackendIntent`, prepared kinds, strict request keys, and journal response projection with `add-recipient`; the body is exactly `{kind:"add-recipient",recipient,idempotencyKey}`.
- Backend derives all current policy fields and delay tuple from its fresh verified snapshot, never from browser fields. It rejects unlisted elevated sends, zero/duplicate additions, stale policy hash, unavailable runtime, and any raw transaction/calldata field.

- [ ] **Step 1: Write failing backend runtime/API tests**

Assert normal configured startup reports writes ready only with full composition; health reports unavailable otherwise and send preparation is not exposed as an actionable flow. Assert arbitrary base prepare reaches a primary-only exact intent, unlisted elevated prepare rejects, and recipient addition produces a primary-plus-secondary delayed intent. Assert changed policy hash supersedes before approval/broadcast and a raw browser policy list/nonce/calldata field rejects.

- [ ] **Step 2: Run RED backend tests**

Run: `pnpm --dir apps/backend exec vitest run tests/backend-surface.test.ts tests/config.test.ts tests/handlers.test.ts tests/server.test.ts tests/submit.test.ts`

Expected: FAIL because normal startup accepts no submission runtime and the API lacks recipient addition.

- [ ] **Step 3: Implement the concrete fail-closed composition**

Build fixed read clients and relay broadcast capability from backend-only config, pin the vault record/credentials, construct snapshots and simulation before prepare, encode primary-first Safe contract signatures after server-side WebAuthn verification, revalidate before every approval/broadcast, persist/reconcile the exact outer hash, and feed only confirmed receipts into the read-only observer boundary. Do not install a mock, placeholder signer, hidden sponsor, or alternate browser write path.

- [ ] **Step 4: Run green backend tests and typecheck**

Run: `pnpm --dir apps/backend exec vitest run tests/backend-surface.test.ts tests/config.test.ts tests/handlers.test.ts tests/server.test.ts tests/submit.test.ts && pnpm --dir apps/backend run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit only if isolated**

Stage only Task 3 files and commit `feat: enable reviewed vault submissions`; otherwise record the safe non-commit ruling.

### Task 4: Expose safe send and delayed recipient maintenance in the PWA

**Files:**
- Modify: `apps/app/src/lib/vault-chain.ts`
- Modify: `apps/app/src/lib/vault-store.tsx`
- Modify: `apps/app/src/lib/vault-activity.ts`
- Modify: `apps/app/src/routes/send.tsx`
- Modify: `apps/app/src/routes/limits.tsx`
- Modify: `apps/app/src/routes/activity.index.tsx`
- Modify: `apps/app/src/routes/activity.$id.tsx`
- Modify: `apps/app/src/routes/-send.test.tsx`
- Modify: `apps/app/src/lib/vault-chain.test.ts`
- Modify: `apps/app/src/lib/vault-store.test.tsx`
- Modify: `apps/app/src/lib/vault-activity.test.ts`
- Modify: `apps/app/src/test/app-routing.test.tsx`
- Modify: `packages/security-core/docs/research/2026-09-16-personal-vault-research.md`
- Modify: `packages/security-core/docs/superpowers/plans/2026-09-16-personal-vault-security-core.md`
- Modify: `packages/security-core/docs/superpowers/specs/2026-10-31-sepolia-pwa-phase-one-design.md`
- Modify: `packages/security-core/docs/security/call-graph.md`
- Modify: `apps/app/README.md`
- Modify: `apps/backend/README.md`

**Interfaces:**
- Chain snapshot reads explicit base-recipient mode and elevated recipient set; it marks old/unknown guard ABI/profile as blocking and non-writable.
- `classify` uses the onchain-derived recipient mode: arbitrary valid base address is allowed, but actions requiring a secondary or Delay explain that the address must first be added through the delayed flow.
- `VaultProvider.addRecipient(address)` calls the closed backend intent and reuses the existing ordered approval/status/reconciliation machinery. UI never mutates `state.recipients` optimistically.

- [ ] **Step 1: Write failing app and documentation tests**

Assert manual unlisted base address proceeds to review; an unlisted amount that needs step-up/delay is blocked with a delayed-addition action; a recipient addition shows primary then secondary and queued status; backend `writesReady:false` disables Send before review; legacy/unknown recipient mode blocks writes; and refreshed chain state is the only source of recipient-list updates.

- [ ] **Step 2: Run RED app tests**

Run: `pnpm --dir apps/app exec vitest run src/routes/-send.test.tsx src/lib/vault-chain.test.ts src/lib/vault-store.test.tsx src/lib/vault-activity.test.ts src/test/app-routing.test.tsx`

Expected: FAIL because the UI requires allowlisting at entry and exposes no executable recipient-addition flow or write-readiness state.

- [ ] **Step 3: Implement the minimal UI and documentation amendment**

Remove only the base-lane address-list gate. Keep the review screen’s full raw address and lane copy. Add the delayed recipient-addition route/action with an explicit policy-drift/stale status and no editable policy surface. Update the research baseline, approved plan, PWA design, call graph, and app/backend docs with the exact three-tier recipient rule and fresh-vault compatibility boundary.

- [ ] **Step 4: Run green focused tests, full verification, and diff check**

Run: `pnpm --dir apps/app exec vitest run src/routes/-send.test.tsx src/lib/vault-chain.test.ts src/lib/vault-store.test.tsx src/lib/vault-activity.test.ts src/test/app-routing.test.tsx && pnpm --dir apps/app run lint && pnpm --dir apps/app run build && pnpm --dir packages/security-core test && pnpm --dir apps/backend test && pnpm --dir apps/backend run typecheck && git diff --check`

Expected: PASS.

- [ ] **Step 5: Commit only if isolated**

Stage only Task 4 files and commit `feat: support open base destinations`; otherwise record the safe non-commit ruling.

## Self-review

- **Spec coverage:** Task 1 enforces the policy and stale repair; Task 2 versions every PWA policy artifact; Task 3 restores only the full reviewed backend write composition; Task 4 provides the user journey and applies the required documentation amendment.
- **Shared interfaces:** Task 1 produces explicit recipient mode and hash-bound repair ABI used by Task 2. Task 2 produces new prepared intent kinds used by Task 3. Task 3 exposes write readiness/add-recipient submission used by Task 4.
- **Review focus:** Each listed failure mode is named in the owning task’s test step.
- **Proportion:** Four sequential tasks map directly to the security boundaries; no implementation body is embedded in this plan.
