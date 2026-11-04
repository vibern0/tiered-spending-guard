# Dynamic PWA Provisioning Envelope and Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fixed Sepolia deployment gas/fee caps with dual-RPC JIT envelopes and safely resume an exact confirmed provisioning prefix.

**Architecture:** Security-core owns quote math, dual-provider evidence, per-transaction authorization, durable sidecar, and recovery validation. Backend composes fixed quote providers plus relay RPC, exposes empty auto-provision recovery and passkey rebind. UI resumes, rebinds both reviewed keys, then enables spending.

**Tech Stack:** TypeScript, viem, Node fs, Vitest, Hardhat, React, SimpleWebAuthn, pnpm.

**Spec:** `packages/security-core/docs/superpowers/specs/2026-11-01-dynamic-pwa-provisioning-envelope-and-recovery-design.md`

## Global Constraints

- Sepolia `11155111`; profile `sepolia-pwa-phase-one-v1`; local backend only.
- Quote providers exactly `PWA_IDENTITY_PROVIDERS`; relay RPC alone signs/broadcasts.
- `gasLimit = ceil(max(estimateA, estimateB) * 130 / 100)`.
- Estimate divergence `<= 10%` of higher; common quote block; head lag `<= 2`.
- Fee: tip `ceil(max(tips) * 130 / 100)`; max fee `ceil((2 * baseFee + max(tips)) * 130 / 100)`.
- Confirmed actual spend + pending/new reservation `<= 0.05 ETH`.
- Six confirmations; exact receipt/runtime/package/plan/topology checks remain.
- Pending, reverted, uncertain, non-prefix, ambiguous recovery: stop.
- No new Solidity or dependency. No mainnet. pnpm only. Never npm/npx.
- Do not commit. Preserve unrelated worktree changes and external operational files.

## Review Focus

- Providers share height but different hash: reject before authorization; Task 2 test.
- Legacy prefix has gap/pending/reorg/ambiguous package: hard stop; Task 4 tests.
- Confirmed costs double-counted against current balance: forbid; Task 1 test.
- Restart lacks credential metadata: deploy may resume; spending blocked until both rebind; Tasks 6–7 tests.
- Historical onchain gas/fees do not reproduce journal intent hash: reject recovery; Task 4 test.

---

### Task 1: Dynamic Envelope Policy and Arithmetic

**Files:**
- Modify: `packages/security-core/config/sepolia.pwa-provisioning-automation.json`
- Create: `packages/security-core/src/pwa/provisioning-envelope.ts`
- Modify: `packages/security-core/src/pwa/authorization.ts`
- Modify: `packages/security-core/src/pwa/index.ts`
- Modify: `packages/security-core/test/unit/pwa/authorization.test.ts`
- Create: `packages/security-core/test/unit/pwa/provisioning-envelope.test.ts`

**Interfaces:**
- Produces: `PwaProvisioningEnvelopePolicy`, `loadCommittedPwaProvisioningAutomationPolicy()`, `derivePwaProvisioningEnvelope(input): PwaProvisioningEnvelope`.
- Policy values: gas/fee margin `3000` bps; divergence `1000` bps; head lag `2`; outlay `50000000000000000` wei; no per-ID gas/fee values.

- [x] **Step 1: RED policy schema**

Assert committed policy has no `transactions`; exact margins/budget load; unknown/fixed-cap fields fail.

- [x] **Step 2: RED arithmetic**

```ts
expect(derivePwaProvisioningEnvelope({ estimates: [6_593_635n, 6_593_635n], baseFee: 22n, tips: [3n, 2n], ... }).gasLimit).to.equal(8_571_726n);
```

Also assert: 10% boundary accepted; greater rejected; block gas overflow rejected; cumulative budget uses confirmed actual + pending + new; balance uses pending + new only.

- [x] **Step 3: Run RED**

Run: `pnpm --dir packages/security-core exec hardhat test test/unit/pwa/authorization.test.ts test/unit/pwa/provisioning-envelope.test.ts`

Expected: FAIL; dynamic policy/envelope absent.

- [x] **Step 4: Implement minimal policy + pure arithmetic**

Exact signature:

```ts
export function derivePwaProvisioningEnvelope(input: PwaProvisioningEnvelopeInput): PwaProvisioningEnvelope;
```

Integer ceiling only. Reject zero/negative, overflow, divergence, budget, balance, priority-over-max, gas-over-block.

- [x] **Step 5: Run GREEN; checkpoint, no commit**

Run prior command. Expected: PASS. Update task checkbox. Do not commit.

### Task 2: Canonical Dual-RPC Quote

**Files:**
- Create: `packages/security-core/src/pwa/provisioning-quote.ts`
- Create: `packages/security-core/test/unit/pwa/provisioning-quote.test.ts`
- Modify: `packages/security-core/src/pwa/index.ts`

**Interfaces:**
- Consumes: Task 1 policy/math.
- Produces: `PwaProvisioningQuoteClient`; `collectPwaProvisioningQuote(input): Promise<PwaProvisioningQuote>`.

- [x] **Step 1: RED common-block evidence**

Test two heads choose lower; both chain IDs `11155111`; same block hash/base fee/gas limit; exact block-tagged estimate; max tips retained.

- [x] **Step 2: RED failure matrix**

Reject wrong chain, null/different hash, null base fee, lag `>2`, nonce mismatch, provider estimate divergence, relay `latest`/`pending` mismatch.

- [x] **Step 3: Run RED**

Run: `pnpm --dir packages/security-core exec hardhat test test/unit/pwa/provisioning-quote.test.ts`

Expected: FAIL; collector absent.

- [x] **Step 4: Implement collector**

```ts
export async function collectPwaProvisioningQuote(input: Readonly<{
  transaction: PwaProvisioningTransaction;
  deployer: Address;
  providers: readonly [PwaProvisioningQuoteClient, PwaProvisioningQuoteClient];
  relay: Pick<PwaProvisioningQuoteClient, "getBlock" | "getTransactionCount">;
  policy: PwaProvisioningEnvelopePolicy;
}>): Promise<PwaProvisioningQuote>;
```

Provider source strings enter evidence only; never logs/errors.

- [x] **Step 5: Run GREEN; checkpoint, no commit**

Run prior command. Expected: PASS. Do not commit.

### Task 3: Per-Transaction Authorization and Durable Sidecar

**Files:**
- Create: `packages/security-core/src/pwa/provisioning-authorization-store.ts`
- Create: `packages/security-core/test/unit/pwa/provisioning-authorization-store.test.ts`
- Modify: `packages/security-core/src/pwa/authorization.ts`
- Modify: `packages/security-core/src/pwa/provisioning.ts`
- Modify: `packages/security-core/src/pwa/index.ts`
- Modify: `packages/security-core/test/unit/pwa/provisioning-approval.test.ts`
- Modify: `packages/security-core/test/integration/pwa-provisioning.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2 quote/envelope.
- Produces: `ProvisioningAuthorizer.authorizeTransaction(plan, transaction, quote, facts)`; `createPwaProvisioningAuthorizationStore(path, identity)`; `executePwaProvisioning(plan, context)`.

- [x] **Step 1: RED exact authorization**

Assert one authorization binds package/plan/immutable tx hash/nonce/quote block/providers/observations/margins/exact fields/prior+result budget. Mutated field fails.

- [x] **Step 2: RED persistence ordering**

Assert append authorization → fsync/rename → sign → journal pending hash → broadcast. Signing failure leaves append-only superseded record; retry appends; no overwrite.

- [x] **Step 3: RED executor migration**

Assert executor skips confirmed prefix, asks authorization only for next tx, and never uses old seven-row approval.

- [x] **Step 4: Run RED**

Run: `pnpm --dir packages/security-core exec hardhat test test/unit/pwa/provisioning-approval.test.ts test/unit/pwa/provisioning-authorization-store.test.ts test/integration/pwa-provisioning.test.ts`

Expected: FAIL.

- [x] **Step 5: Implement store/authorizer/executor**

Sidecar schema version `1`; canonical hash; map authorization `id` to journal `pwa-${id}`; same exclusive lock scope as journal. Remove fixed-cap approval path.

- [x] **Step 6: Run GREEN; checkpoint, no commit**

Run prior command. Expected: PASS. Do not commit.

### Task 4: Exact Confirmed-Prefix Recovery

**Files:**
- Create: `packages/security-core/src/pwa/provisioning-recovery.ts`
- Create: `packages/security-core/test/unit/pwa/provisioning-recovery.test.ts`
- Modify: `packages/security-core/src/config/deployments.ts`
- Modify: `packages/security-core/src/pwa/provisioning.ts`
- Modify: `packages/security-core/src/pwa/index.ts`
- Modify: `packages/security-core/scripts/live/runtime.ts`
- Modify: `packages/security-core/test/integration/pwa-provisioning.test.ts`

**Interfaces:**
- Consumes: review package, live journal, committed artifacts/profile, two evidence clients.
- Produces: `resolvePwaProvisioningRecovery(input): Promise<{ plan: PwaProvisioningPlan; confirmedPrefixLength: number; credentials: { primary: PwaCredentialCoordinates; secondary: PwaCredentialCoordinates } } | undefined>`.

- [x] **Step 1: RED valid prefixes**

For prefix lengths `1..6`: verify package bytes/content, decode signer calldata, rebuild plan through recovery-only resolver, verify both providers' transactions/receipts/runtimes, return first missing step.

- [x] **Step 2: RED adversarial recovery**

Reject gap/order/nonce drift; pending/reverted/uncertain; <6 confirmations; reorg; runtime drift; future code; package ambiguity; filename mismatch; changed gas/fee intent hash; relay latest/pending mismatch.

- [x] **Step 3: Run RED**

Run: `pnpm --dir packages/security-core exec hardhat test test/unit/pwa/provisioning-recovery.test.ts test/integration/pwa-provisioning.test.ts`

Expected: FAIL.

- [x] **Step 4: Implement recovery-only resolver**

Allow only already-deployed exact signer prefix. Normal fresh resolver still rejects existing signers. Byte-identical duplicate reviews collapse; distinct matches fail.

- [x] **Step 5: Run GREEN; checkpoint, no commit**

Run prior command. Expected: PASS. Do not commit.

### Task 5: Backend Quote/Recovery Composition

**Files:**
- Modify: `apps/backend/src/provisioner.ts`
- Modify: `apps/backend/src/main.ts`
- Modify: `apps/backend/tests/provisioner.test.ts`
- Modify: `apps/backend/tests/backend-surface.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: async `createConfiguredAutomaticPwaProvisioner(config)`; `AutomaticPwaProvisioner.provision(credentials?)`; recovery waits for empty auto-provision trigger.

- [x] **Step 1: RED startup classification**

Empty journal uses fresh credentials. Valid confirmed prefix starts backend, prepares recovery, broadcasts nothing. Invalid/pending prefix stops startup.

- [x] **Step 2: RED resume**

Empty `provision()` resumes first missing transaction; no credential metadata required; duplicate calls single-flight; confirmed prefix never signs/replays.

- [x] **Step 3: RED provider boundary**

Quote clients use exactly `PWA_IDENTITY_PROVIDERS`; relay client alone has signing/broadcast methods; URLs absent from errors.

- [x] **Step 4: Run RED**

Run: `pnpm --dir apps/backend test -- tests/provisioner.test.ts tests/backend-surface.test.ts`

Expected: FAIL.

- [x] **Step 5: Implement composition**

Remove `assertFreshAutomaticProvisioningJournal`. Await recovery validation during configured backend creation. Keep HTTPS backend available but auto-provision disabled.

- [x] **Step 6: Run GREEN; checkpoint, no commit**

Run prior command. Expected: PASS. Do not commit.

### Task 6: Backend Credential Rebind Gate

**Files:**
- Modify: `apps/backend/src/webauthn.ts`
- Modify: `apps/backend/src/session.ts`
- Modify: `apps/backend/src/handlers.ts`
- Modify: `apps/backend/src/server.ts`
- Modify: `apps/backend/tests/webauthn.test.ts`
- Modify: `apps/backend/tests/handlers.test.ts`
- Modify: `apps/backend/tests/server.test.ts`

**Interfaces:**
- Consumes: recovered coordinate pair from Task 4/5.
- Produces: role rebind options/verify routes; reconstructed ES256 COSE key; both-role spending gate.

- [x] **Step 1: RED COSE/rebind verification**

Assert coordinates encode as canonical ES256 COSE key; verified assertion binds role/RP/origin/challenge/UV/UP; counter baseline `0`; wrong role key and rollback fail.

- [x] **Step 2: RED HTTP routes**

Test `POST /v1/credentials/:role/rebind/options` with `{}` and `/verify` with `{sessionId, assertion}`. Reject fields, replay, expiry, HTTPS profile, wrong origin.

- [x] **Step 3: RED spending gate**

Recovered vault returns public result plus rebind status. Prepare/approve/submit/reconcile all fail until both roles verify; normal same-process onboarding remains ready.

- [x] **Step 4: Run RED**

Run: `pnpm --dir apps/backend test -- tests/webauthn.test.ts tests/handlers.test.ts tests/server.test.ts`

Expected: FAIL.

- [x] **Step 5: Implement rebind/gate**

Credential ID accepted only inside verified assertion response. Store rebound IDs/counters in memory. No deployment field accepts browser identity.

- [x] **Step 6: Run GREEN; checkpoint, no commit**

Run prior command. Expected: PASS. Do not commit.

### Task 7: UI Recovery Rebind

**Files:**
- Modify: `apps/app/src/lib/webauthn-passkey.ts`
- Modify: `apps/app/src/lib/vault-store.tsx`
- Modify: `apps/app/src/routes/onboarding.tsx`
- Modify: `apps/app/src/lib/webauthn-passkey.test.ts`
- Modify: `apps/app/src/lib/vault-store.test.tsx`
- Modify: `apps/app/src/routes/-onboarding.test.tsx`

**Interfaces:**
- Consumes: Task 6 options/verify routes and public rebind status.
- Produces: `rebindPasskey(role, credentialId)`; persisted per-role rebind progress; spending unavailable until both bound.

- [x] **Step 1: RED browser ceremony**

Assert fixed RP/origin/challenge, `userVerification: required`, stored allow-credential ID, response ID match, UV bit.

- [x] **Step 2: RED store flow**

Recovered auto-provision persists verified vault, prompts primary then secondary rebind, survives reload as retryable, and never prepares/submits before both.

- [x] **Step 3: RED onboarding UI**

Show `Verify first signer` / `Verify second signer` only when required; no operator approval or gas control returns.

- [x] **Step 4: Run RED**

Run: `pnpm --dir apps/app test -- src/lib/webauthn-passkey.test.ts src/lib/vault-store.test.tsx src/routes/-onboarding.test.tsx`

Expected: FAIL.

- [x] **Step 5: Implement UI flow**

Keep service-worker activation deferred across provisioning/rebind. Preserve existing credential IDs; never persist passkey public/private material.

- [x] **Step 6: Run GREEN; checkpoint, no commit**

Run prior command. Expected: PASS. Do not commit.

### Task 8: Documentation, Full Verification, Live Resume

**Files:**
- Modify: `packages/security-core/docs/superpowers/specs/2026-11-01-phase-one-automated-pwa-provisioning-design.md`
- Modify: `packages/security-core/docs/superpowers/plans/2026-11-01-phase-one-automated-pwa-provisioning.md`
- Modify: `packages/security-core/docs/security/call-graph.md`
- Modify: `packages/security-core/docs/security/dependency-review.md`
- Modify: `apps/backend/README.md`

**Interfaces:**
- Consumes: Tasks 1–7.
- Produces: accurate operator/security docs; verified current recovery.

- [x] **Step 1: Update docs/checklists**

Replace fixed-cap approval text with JIT dual-RPC envelope, sidecar, confirmed-prefix recovery, rebind gate. Record no dependency/Solidity change.

- [x] **Step 2: Run focused suites**

Run each:

```text
pnpm --dir packages/security-core exec sh -c 'hardhat test test/unit/pwa/*.test.ts test/integration/pwa-provisioning.test.ts'
pnpm --dir apps/backend test
pnpm --dir apps/backend typecheck
pnpm --dir apps/app test
pnpm --dir apps/app build
```

Expected: PASS.

- [x] **Step 3: Run full security-core verification**

Run separately:

```text
pnpm --dir packages/security-core exec hardhat clean
pnpm --dir packages/security-core exec hardhat compile
pnpm --dir packages/security-core exec hardhat test
```

Expected: PASS.

- [x] **Step 4: Diff hygiene**

Run: `git diff --check`

Expected: no new whitespace errors; preserve pre-existing unrelated file issue if still present and report it exactly.

- [x] **Step 5: Read-only live recovery preflight**

Against existing external review/journal: identify unique plan, verify two confirmed signers/canonical receipts/nonces/runtimes, collect next dual quote, print only hashes/counts/gas/fee/budget facts. Never print RPC URLs/private key/credential data.

Expected: PASS; first missing ID `setup-helper`; no transaction sent.

2026-11-01 execution note: the read-only recovery check verified a unique matching package and the two successful signer journal entries, then stopped before quoting because the relay nonce was `963` instead of the reviewed next nonce `961`. Public transactions `0x6cacf6952b13589f201d89c4bfa841c085f4de85aa53224cd36dac9e94f78e60` (nonce `961`) and `0xf2d4de5486ac5d0223604f421e95e4440b0bad490a9fc3e84cb1253aff359a9d` (nonce `962`) are confirmed but do not match `setup-helper` or `guard`; none of the five future reviewed addresses has code. No provisioning transaction was sent. The exact-prefix recovery design therefore remains fail-closed pending a separately approved successor-plan amendment.

2026-11-04 execution note: a later fresh package `0x43e73064db98c9ab1baa51a2a238a4e4b04aa5d955321f3e2f869689da1a243a` confirmed only `primary-signer@1030`. Unrelated successful transaction `0xe146a16cd246241b86cdb0ce44dc93dd02ff3bd339102620fdff33eb0760db35` consumed nonce `1031`. The committed prefix-one successor preserves the confirmed primary row and rebases the exact missing suffix to `1032..1037`; both fixed providers must prove the consumed transaction and canonical receipt with six confirmations before the successor exists. Authorization sidecars are package-scoped. Backend and browser diagnostics carry only redacted code/stage/request ID correlation and grant no authority.

- [x] **Step 6: Execute authorized Sepolia recovery**

Start updated local backend with existing external files; call empty auto-provision once. Do not edit/delete journal/reviews. Wait six confirmations per step. Stop on any divergence.

Expected: setup-helper, guard, delay, maintenance, safe-proxy confirm; final topology PASS; public vault result returned.

2026-11-04 completion note: the prefix-one successor confirmed `secondary-signer@1032` in block `12062359`, `setup-helper@1033` in `12062365`, `guard@1034` in `12062371`, `delay@1035` in `12062378`, `maintenance@1036` in `12062384`, and `safe-proxy@1037` in `12062425`. The final Safe transaction is `0x81a500d9644345de93bc94b232ebe6267716bd764d4f86a490ac112d0d815bef`. A transient identity-provider `ResourceNotFoundRpcError` stopped before Safe submission; restart exposed and fixed separate verified-deployment-prefix reconstruction, then the final retry completed and passed topology verification. The browser now requires primary and secondary WebAuthn rebind before spending.

- [x] **Step 7: Final evidence; no commit**

Report transaction hashes, blocks, gas used, topology hash, remaining manual passkey rebind action, tests, dirty files. Do not commit or push.
