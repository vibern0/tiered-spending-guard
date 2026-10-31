# Sepolia PWA Phase One Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship installable PWA proving ordinary-Safe X/Y/Z policy on two disposable Sepolia vaults: localhost first, stable HTTPS/mobile second.

**Architecture:** Existing TanStack app stays UI. `apps/backend` stays sole write boundary. Security-core owns contract-only passkey profile, atomic provisioning, exact Safe/Delay intents, receipt proof. Backend verifies WebAuthn, journals immutable requests, pays gas only. PWA reads chain directly; never authorizes from local state.

**Tech Stack:** Solidity 0.8.24, Safe 1.5.0, Zodiac Delay 1.1.1, TypeScript, viem 2.56.7, React 19, TanStack Start/Router, Vite 8, SimpleWebAuthn 14, Vitest, Hardhat.

**Spec:** `packages/security-core/docs/superpowers/specs/2026-10-31-sepolia-pwa-phase-one-design.md`

## Global Constraints

- Sepolia `11155111` only. Circle USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`; onchain name `USDC`; symbol `USDC`; 6 decimals. The original `USD Coin` name assumption was corrected from two-provider reads at block `12034092`; both providers agreed on block hash, runtime hash `0xcd3f29e2ea9c61dadd48bfeaf8b2884b6de9dfee7bf45329452c4c33d0868ceb`, and metadata, and [Circle's official testnet registry](https://developers.circle.com/stablecoins/usdc-contract-addresses) confirms the address.
- Policy: 86,400-second epoch-aligned period; X `1_000_000`; Y `3_000_000`; Z 120 seconds; expiration 600 seconds.
- Sole recipient: `0xaD4D5cd2Ec5beCdB9608baD4c36F0dBe8b2492Bc`. Rehearsal: 1, 2, 4 USDC. Fund 8 USDC per vault.
- Primary platform passkey. Final evidence needs distinct cross-platform secondary. Same-device secondary never passes completion gate.
- Contract-only secondary. No ECDSA placeholder, Burner, user EOA, WalletConnect, ERC-4337, fallback handler, extra module, session key.
- Safe owner: credential-specific primary only, threshold 1. Secondary remains guard-only. Delay remains sole module. Guard fills both guard slots.
- Allow only native/USDC `transfer` policy paths already approved. PWA Phase One exposes USDC only.
- Deny delegatecall except existing fixed atomic setup, batch, approval, Permit/Permit2, arbitrary message/call, unknown token/recipient.
- Keep secrets, assertions, raw signatures, RPC credentials, relay key, approval files, journals outside repository and logs.
- Generate unsigned provisioning/submission material before human approval. No plan step grants live broadcast or funding authority.
- Service worker caches static shell only. RPC, backend, WebAuthn, state, signatures, requests, receipts, queues stay network-only/no-store.
- Local profile: `http://localhost:5173`, RP `localhost`, backend `http://127.0.0.1:8787`.
- HTTPS profile: one exact stable app origin, matching exact RP host, one exact protected backend origin, separate credentials, separate Safe.
- Independent read-only observer required for every live receipt. Notification delivery stays Phase Two.
- Repair/recovery, ERC-4337, hosted relay, mainnet, production readiness, audit, native wrapper stay Phase Two.

## Review Focus

- RP/origin/profile mismatch: block before WebAuthn prompt. Task 3 tests mixed, wildcard, preview, hostname drift.
- Real browser DER ECDSA: verify raw assertion; preserve exact client-data suffix; encode canonical onchain payload. Task 4 tests malformed/ambiguous DER and JSON.
- Timeout after broadcast: persist `uncertain`; reconcile exact hash; never sign/broadcast replacement. Task 8 tests restart and double-click.
- Queue head/time drift: reject cancel/execute when nonce, fingerprint, tuple, receipt time, readiness, expiry changes. Tasks 7-8 test each field.
- Service-worker overreach: never cache backend/RPC/security state; offline writes fail closed. Task 5 inspects caches and fetch policy.

---

### Task 1: Contract-only ordinary-Safe signer profile

**Files:**
- Modify: `packages/security-core/contracts/TieredSpendingGuard.sol`
- Modify: `packages/security-core/contracts/SafeAtomicSetupHelper.sol`
- Modify: `packages/security-core/src/config/policy.ts`
- Modify: `packages/security-core/src/topology/build.ts`
- Modify: `packages/security-core/src/topology/verify.ts`
- Modify: `packages/security-core/src/topology/evidence.ts`
- Modify: `packages/security-core/test/integration/atomic-setup-helper.test.ts`
- Modify: `packages/security-core/test/integration/guard-signatures.test.ts`
- Modify: `packages/security-core/test/integration/topology.test.ts`
- Modify: `packages/security-core/test/integration/adversarial.test.ts`
- Modify: `packages/security-core/test/invariant/call-graph.invariant.ts`
- Modify: `packages/security-core/docs/security/call-graph.md`

**Interfaces:**
- Consumes: existing dual-secondary `VaultPolicy`, guard constructor, atomic setup.
- Produces: `secondaryProfile?: "dual" | "contract-only"`; PWA sets `contract-only`; `undefined` preserves historical `dual`.
- Produces: contract-only state: `ecdsaSecondary.signer == address(0)`, `enabled == false`; safe-contract secondary nonzero/enabled.

- [x] **Step 1: Write RED contract/profile tests**

```ts
it("atomically installs one primary and one contract secondary with ECDSA disabled", async () => {
  expect(await safe.getOwners()).to.deep.equal([primary]);
  expect(await safe.getThreshold()).to.equal(1n);
  expect(await guard.safeContractSecondary()).to.deep.equal([secondary, 0n, true]);
  expect(await guard.ecdsaSecondary()).to.deep.equal([zero, 1n, false]);
});

it("rejects every terminal ECDSA extension in contract-only profile", async () => {
  await expect(executeWithEcdsaExtension()).to.be.reverted;
});
```

Also assert zero/missing contract secondary fails; dual historical fixture still passes; owner/module/fallback topology unchanged.

- [x] **Step 2: Run RED**

Run: `npm --prefix packages/security-core test -- test/integration/atomic-setup-helper.test.ts test/integration/guard-signatures.test.ts test/integration/topology.test.ts test/integration/adversarial.test.ts`

Expected: FAIL; constructor/policy/setup require ECDSA secondary.

- [x] **Step 3: Implement narrow profile**

Allow zero `initialConfig.ecdsaSecondary` only for explicit contract-only policy. Store disabled ECDSA config. Keep dual behavior byte-for-byte semantic compatible. Update setup/topology derivation and verification. Do not change supported calls, signature digest, Safe owner rules, repair authority, module graph.

- [x] **Step 4: Run GREEN plus invariants**

Run: `npm --prefix packages/security-core test -- test/integration/atomic-setup-helper.test.ts test/integration/guard-signatures.test.ts test/integration/topology.test.ts test/integration/adversarial.test.ts test/invariant/call-graph.invariant.ts`

Expected: PASS.

- [x] **Step 5: Update call graph and commit**

Document contract-only profile; dual profile historical only; ECDSA extension rejected for PWA.

```bash
git add packages/security-core/contracts packages/security-core/src/config/policy.ts packages/security-core/src/topology packages/security-core/test packages/security-core/docs/security/call-graph.md
git commit -m "feat: add contract-only secondary profile"
```

### Task 2: Canonical PWA profile and USDC identity

**Files:**
- Create: `packages/security-core/config/sepolia.pwa-phase-one.json`
- Create: `packages/security-core/src/pwa/profile.ts`
- Create: `packages/security-core/scripts/pwa/capture-usdc-profile.ts`
- Create: `packages/security-core/test/unit/pwa/profile.test.ts`
- Modify: `packages/security-core/package.json`
- Rename: `apps/app/src/lib/euro.ts` to `apps/app/src/lib/usdc.ts`
- Rename: `apps/app/src/lib/euro.test.ts` to `apps/app/src/lib/usdc.test.ts`
- Modify: `apps/app/src/lib/vault-chain.ts`
- Modify: `apps/app/src/lib/vault-store.tsx`
- Modify: `apps/app/src/lib/vault-activity.ts`
- Modify: `apps/app/src/components/wallet/protection-editor.tsx`
- Modify: `apps/app/src/components/wallet/topology-alert.tsx`
- Modify: `apps/app/src/routes/{__root,index,onboarding,send,receive,activity.index,activity.$id,limits,profile}.tsx`
- Modify: matching app tests under `apps/app/src`
- Modify: `apps/backend/src/{vault,handlers,server,provisioner}.ts`
- Modify: matching backend tests under `apps/backend/tests`
- Modify: `apps/app/README.md`
- Modify: `apps/backend/README.md`

**Interfaces:**
- Produces: `PwaPhaseOneProfile`; `loadPwaPhaseOneProfile(value: unknown): PwaPhaseOneProfile`.
- Produces: `captureUsdcIdentity(clientA, clientB, blockNumber): Promise<ReviewedUsdcIdentity>`; both providers must match block hash, runtime, metadata.
- Profile pins chain/token/metadata/X/Y/Z/expiration/recipient/amounts/contract-only mode. Runtime hash comes from reviewed two-provider artifact, never browser input.
- Renames active `eurc` fields/functions/types to `usdc`; historical evidence files unchanged.

- [x] **Step 1: Write RED profile tests**

```ts
expect(profile).to.include({ chainId: 11155111, symbol: "USDC", decimals: 6 });
expect(profile.token).to.equal("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238");
expect(profile.limits).to.deep.equal({ basePerTransaction: 1_000_000n, baseDailyLimit: 1_000_000n, stepUpPerTransaction: 3_000_000n, instantDailyLimit: 3_000_000n });
expect(profile.delay).to.deep.equal({ cooldownSeconds: 120, expirationSeconds: 600 });
```

Reject extra keys, wrong metadata/address/hash/recipient, floats, negative/noncanonical decimals, X/Y drift, non-contract-only mode.

- [x] **Step 2: Run RED**

Run: `npm --prefix packages/security-core run test:unit -- test/unit/pwa/profile.test.ts`

Expected: FAIL; profile loader absent.

- [x] **Step 3: Implement profile; rename active EURC surface**

Use bigint throughout. `validateUsdc` verifies address, nonempty runtime, reviewed runtime hash, onchain name `USDC`, symbol `USDC`, and 6 decimals. Add `pwa:capture-usdc-profile`; capture at one six-confirmation block with two providers; commit exact hash/artifact provenance. Run `rg -n "EURC|eurc|Euro Coin" apps/app apps/backend`; remaining matches allowed only explicit historical/migration comments.

- [x] **Step 4: Run GREEN**

Run: `npm --prefix packages/security-core run test:unit -- test/unit/pwa/profile.test.ts`

Run: `npm --prefix apps/app test`

Run: `npm --prefix apps/backend test`

Expected: PASS; active UI/API says USDC.

- [x] **Step 5: Commit**

```bash
git add packages/security-core/config/sepolia.pwa-phase-one.json packages/security-core/src/pwa packages/security-core/scripts/pwa packages/security-core/test/unit/pwa packages/security-core/package.json apps/app apps/backend
git commit -m "feat: pin Sepolia USDC PWA profile"
```

### Task 3: Closed localhost and HTTPS profiles

**Files:**
- Create: `apps/app/src/lib/environment-profile.ts`
- Create: `apps/app/src/lib/environment-profile.test.ts`
- Modify: `apps/app/src/lib/vault-store.tsx`
- Modify: `apps/backend/src/config.ts`
- Modify: `apps/backend/src/session.ts`
- Modify: `apps/backend/src/server.ts`
- Modify: `apps/backend/src/webauthn.ts`
- Modify: `apps/backend/tests/{config,server,webauthn}.test.ts`
- Modify: `apps/app/README.md`
- Modify: `apps/backend/README.md`

**Interfaces:**
- Produces: `WalletEnvironmentProfile = Readonly<{ id: "local" | "https"; chainId: 11155111; appOrigin: string; rpId: string; backendOrigin: string; credentials: "omit" | "include" }>`.
- Produces: `loadWalletEnvironmentProfile(env, observedOrigin): WalletEnvironmentProfile`.
- Backend config gains same `id`, exact `rpId`, exact `origin`; host remains `127.0.0.1`.

- [x] **Step 1: Write RED matrix**

```ts
expect(loadProfile(localEnv, "http://localhost:5173").rpId).toBe("localhost");
expect(loadProfile(httpsEnv, "https://vault.example").rpId).toBe("vault.example");
expect(() => loadProfile(httpsEnv, "https://preview.example")).toThrow();
```

Reject wildcard origin/RP, HTTP non-localhost, embedded credentials, fragments, path/query, IP RP, app/RP mismatch, local/HTTPS mix, unknown mode. Backend health returns `{ok,chainId,profileId,origin,rpId}`. HTTPS CORS permits exact origin plus credentials; ingress supplies access control. Backend still rejects non-loopback direct sockets.

- [x] **Step 2: Run RED**

Run: `npm --prefix apps/app test -- src/lib/environment-profile.test.ts`

Run: `npm --prefix apps/backend test -- tests/config.test.ts tests/server.test.ts tests/webauthn.test.ts`

Expected: FAIL; profiles hardcoded localhost.

- [x] **Step 3: Implement exact profiles**

Use `VITE_WALLET_PROFILE`, `VITE_APP_ORIGIN`, `VITE_WEBAUTHN_RP_ID`, `VITE_BACKEND_ORIGIN`. Backend uses matching `BACKEND_PROFILE`, `BACKEND_ORIGIN`, `BACKEND_RP_ID`; all values explicit in HTTPS mode. No provider-specific ingress SDK.

- [x] **Step 4: Run GREEN**

Run: `npm --prefix apps/app test -- src/lib/environment-profile.test.ts src/lib/vault-store.test.tsx`

Run: `npm --prefix apps/backend test -- tests/config.test.ts tests/server.test.ts tests/webauthn.test.ts`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add apps/app/src/lib/environment-profile* apps/app/src/lib/vault-store* apps/backend/src apps/backend/tests apps/app/README.md apps/backend/README.md
git commit -m "feat: add closed wallet environment profiles"
```

### Task 4: Real two-role WebAuthn pipeline

**Files:**
- Modify: `apps/app/src/lib/webauthn-passkey.ts`
- Modify: `apps/app/src/lib/webauthn-passkey.test.ts`
- Modify: `apps/backend/src/webauthn.ts`
- Create: `apps/backend/src/webauthn-signature.ts`
- Modify: `apps/backend/tests/webauthn.test.ts`
- Modify: `packages/security-core/src/signers/guard-signatures.ts`
- Modify: `packages/security-core/test/unit/guard/signatures.test.ts`
- Modify: `apps/backend/src/handlers.ts`

**Interfaces:**
- App produces raw `AuthenticationResponseJSON`; never constructs trusted signature bytes.
- Backend produces `VerifiedPasskeyApproval = Readonly<{ role; credentialId; counter; payload: Hex }>` from exact Safe digest assertion.
- `decodeP256Credential(publicKey): { x: bigint; y: bigint }` accepts COSE ES256/P-256 only.
- `encodeGuardContractSignatures(primary: {address,payload}, secondary?: {address,payload}): Hex` preserves primary-first layout.

- [ ] **Step 1: Write RED registration/assertion vectors**

Test primary `platform`; secondary `cross-platform`; distinct credential IDs/public keys. Use genuine DER fixtures with short/long leading zeros. Reject nonminimal/negative/oversized `r/s`, trailing bytes, wrong curve/algorithm, wrong RP/origin/challenge/type/crossOrigin/UV/credential/role, altered JSON order/escaping, counter rollback.

```ts
expect(approval.payload).toEqual(encodeAbiParameters(
  [{type:"bytes"},{type:"string"},{type:"uint256"},{type:"uint256"}],
  [authenticatorData, exactClientDataSuffix, r, s],
));
```

- [ ] **Step 2: Run RED**

Run: `npm --prefix apps/backend test -- tests/webauthn.test.ts`

Run: `npm --prefix apps/app test -- src/lib/webauthn-passkey.test.ts`

Run: `npm --prefix packages/security-core run test:unit -- test/unit/guard/signatures.test.ts`

Expected: FAIL; app expects P1363; role attachment hardcoded.

- [ ] **Step 3: Implement server-verified pipeline**

Use SimpleWebAuthn for ceremony verification. Parse DER strictly only after verification. Extract exact signed `clientDataJSON` suffix; never rebuild JSON. Backend stores public credential metadata outside repository. Update counter only after verified assertion. Compose Safe signature bundle only from verified payloads and server-held signer addresses.

- [ ] **Step 4: Run GREEN**

Run same three commands. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/app/src/lib/webauthn-passkey* apps/backend/src apps/backend/tests/webauthn.test.ts packages/security-core/src/signers/guard-signatures.ts packages/security-core/test/unit/guard/signatures.test.ts
git commit -m "feat: verify real browser passkey approvals"
```

### Task 5: Installable static-shell PWA

**Files:**
- Create: `apps/app/public/manifest.webmanifest`
- Create: `apps/app/public/service-worker.js`
- Create: `apps/app/public/icons/icon-192.png`
- Create: `apps/app/public/icons/icon-512.png`
- Create: `apps/app/public/icons/icon-maskable-512.png`
- Create: `apps/app/src/lib/pwa.ts`
- Create: `apps/app/src/lib/pwa.test.ts`
- Create: `apps/app/src/components/wallet/pwa-status.tsx`
- Create: `apps/app/src/components/wallet/pwa-status.test.tsx`
- Modify: `apps/app/src/routes/__root.tsx`
- Modify: `apps/app/src/styles.css`
- Modify: `apps/app/src/components/wallet/ui.tsx`
- Modify: `apps/app/vite.config.ts`

**Interfaces:**
- Produces: `registerWalletServiceWorker(): Promise<ServiceWorkerRegistration | undefined>`.
- Produces: `PwaStatus` with online/install/update states. Update activation waits until no active ceremony/submission.

- [ ] **Step 1: Write RED cache/install tests**

Assert manifest fields, 192/512/maskable icons, standalone display, theme/background. Simulate install/update/offline. Test direct `/send` and `/activity/:id` navigation plus offline shell fallback. Inspect service-worker source/behavior: only same-origin navigation/static assets cached; `/v1/`, backend origin, RPC, cross-origin, non-GET, `cache-control:no-store` never cached. Offline write controls disabled; stale success absent.

- [ ] **Step 2: Run RED**

Run: `npm --prefix apps/app test -- src/lib/pwa.test.ts src/components/wallet/pwa-status.test.tsx`

Expected: FAIL; PWA files absent.

- [ ] **Step 3: Implement minimal PWA**

No new PWA dependency. Version cache explicitly. Network-first navigation; static immutable cache only. Render clear offline/read-only state. Add safe-area CSS, 44px touch targets, reduced-motion rules.

- [ ] **Step 4: Run GREEN and build**

Run: `npm --prefix apps/app test -- src/lib/pwa.test.ts src/components/wallet/pwa-status.test.tsx`

Run: `npm --prefix apps/app run build`

Expected: PASS; build contains manifest, worker, icons.

- [ ] **Step 5: Commit**

```bash
git add apps/app
git commit -m "feat: make wallet installable as PWA"
```

### Task 6: Reviewed atomic PWA provisioning

**Files:**
- Create: `packages/security-core/src/pwa/provisioning.ts`
- Create: `packages/security-core/src/pwa/index.ts`
- Create: `packages/security-core/test/integration/pwa-provisioning.test.ts`
- Create: `packages/security-core/test/unit/pwa/provisioning-approval.test.ts`
- Modify: `packages/security-core/package.json`
- Modify: `apps/backend/package.json`
- Modify: `apps/backend/src/provisioner.ts`
- Modify: `apps/backend/src/handlers.ts`
- Modify: `apps/backend/src/server.ts`
- Modify: `apps/backend/tests/handlers.test.ts`
- Modify: `apps/backend/tests/server.test.ts`
- Modify: `package-lock.json`
- Modify: `packages/security-core/docs/security/dependency-review.md`
- Modify: `packages/security-core/docs/security/call-graph.md`

**Interfaces:**
- Produces: `createPwaProvisioningPlan(input): Promise<PwaProvisioningPlan>`.
- Produces: `writePwaProvisioningReview(plan, outputDirectory): { packageHash: Hex; path: string }`.
- Produces: `executeApprovedPwaProvisioning(plan, approval, context): Promise<PwaProvisioningResult>`.
- `PwaProvisioningResult` binds Safe, guard, Delay, two signer contracts, USDC, setup receipt, topology report hash.
- Backend endpoints: `POST /v1/vaults/plan`; `POST /v1/vaults` executes only exact approval file hash.

- [ ] **Step 1: Write RED deterministic/atomic tests**

Plan two factory-bound signer creations, four existing prerequisites, one Safe proxy. Primary sole owner. Contract secondary guard-only. Zero ECDSA/fallback. Delay sole module. Fixed USDC profile. Same inputs serialize identically. Mutate credential coordinates, verifier, factory, token, recipient, X/Y/Z, nonce, salt, artifact/runtime hash, approval hash: reject.

Prove failed setup leaves no Safe. Prove browser body cannot supply address, hash, policy, signer, nonce, fee, artifact, or approval.

- [ ] **Step 2: Run RED**

Run: `npm --prefix packages/security-core test -- test/integration/pwa-provisioning.test.ts test/unit/pwa/provisioning-approval.test.ts`

Run: `npm --prefix apps/backend test -- tests/handlers.test.ts tests/server.test.ts`

Expected: FAIL; PWA provisioning boundary absent.

- [ ] **Step 3: Implement reviewed adapter**

Reuse verified Safe/passkey factory, `buildVaultPlan`, prerequisite verifier, topology verifier, durable-before-broadcast journal. Add internal workspace export; remove executable external `BACKEND_PROVISIONER_MODULE`. Keep `BACKEND_*` RPC/key/journal/review/approval paths external. Plan endpoint never broadcasts. Execution requires exact locally reviewed approval file and fresh nonce/code/state checks.

- [ ] **Step 4: Run GREEN**

Run same commands. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/security-core/src/pwa packages/security-core/test packages/security-core/package.json apps/backend package-lock.json packages/security-core/docs/security
git commit -m "feat: add reviewed PWA vault provisioning"
```

### Task 7: Closed X/Y/Z intent builders

**Files:**
- Create: `packages/security-core/src/pwa/intents.ts`
- Create: `packages/security-core/test/unit/pwa/intents.test.ts`
- Create: `packages/security-core/test/integration/pwa-intents.test.ts`
- Modify: `packages/security-core/src/pwa/index.ts`
- Modify: `packages/security-core/src/transport/types.ts`
- Modify: `packages/security-core/src/transport/validate.ts`
- Modify: `packages/security-core/docs/security/call-graph.md`

**Interfaces:**
- `PwaIntent = TransferIntent | CancelQueuedIntent | ExecuteReadyIntent | SkipExpiredIntent`.
- `preparePwaIntent(snapshot: VerifiedPwaSnapshot, intent: PwaIntent): PreparedPwaIntent`.
- Signed intents produce exact `SafeTx`; execute/skip produce exact Delay call. All carry canonical queue/time/policy bindings.
- `simulatePwaIntent(prepared, client): Promise<SimulationEvidence>` never broadcasts.

- [ ] **Step 1: Write RED X/Y/Z vectors**

```ts
expect(prepare(1_000_000n).requiredApprovals).toEqual(["primary"]);
expect(prepare(2_000_000n, {baseSpent:1_000_000n}).requiredApprovals).toEqual(["primary","secondary"]);
expect(prepare(4_000_000n).kind).toBe("queue-transfer");
```

Assert above-Y direct transfer denied. Queue exact USDC transfer through Delay. Cancel exact `setTxNonce`. Ready exact `executeNextTx`. Early execute rejects in `eth_call`; no broadcast object returned. Expired exact head permits only `skipExpired`. Mutate every Safe/Delay/USDC/recipient/amount/nonce/fingerprint/time/operation/calldata/signature field: reject.

- [ ] **Step 2: Run RED**

Run: `npm --prefix packages/security-core test -- test/unit/pwa/intents.test.ts test/integration/pwa-intents.test.ts`

Expected: FAIL; PWA intent API absent.

- [ ] **Step 3: Implement builders**

Reuse policy classifier, Safe typed data, queue fingerprint, transport validator. Keep one snapshot block. Re-read block hash after reads. Never accept browser calldata.

- [ ] **Step 4: Run GREEN**

Run same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/security-core/src/pwa packages/security-core/src/transport packages/security-core/test packages/security-core/docs/security/call-graph.md
git commit -m "feat: build closed PWA tier intents"
```

### Task 8: Durable backend submission API

**Files:**
- Modify: `apps/backend/src/journal.ts`
- Modify: `apps/backend/src/vault.ts`
- Modify: `apps/backend/src/handlers.ts`
- Modify: `apps/backend/src/server.ts`
- Modify: `apps/backend/src/main.ts`
- Modify: `apps/backend/tests/{journal,vault,handlers,server,submit}.test.ts`
- Modify: `apps/backend/README.md`
- Modify: root `package.json`

**Interfaces:**
- Prepare body: `{ kind, recipient?, amount?, queueNonce?, queueFingerprint?, idempotencyKey }`; exact keys per kind.
- Submit signed: `{ role: "primary" | "secondary", assertion: AuthenticationResponseJSON }`.
- Submit permissionless: `{ role: "none" }`; only ready execute/expired skip.
- State: `prepared | awaiting-primary | awaiting-secondary | submitting | uncertain | confirmed | reverted | superseded`.
- `GET /v1/submissions/:id` reconciles before response; never authorizes replacement.

- [ ] **Step 1: Write RED journal/API tests**

Cover all states and monotonic transitions. Restart from disk. Duplicate identical idempotency returns same request. Different bytes under same ID reject. Primary-before-secondary. Wrong credential/role reject. Timeout persists locally derived outer hash before send result, then `uncertain`. Retry reconciles exact hash only. Double click/tab produces one broadcast. Stale Safe nonce/policy/queue/time/code blocks before signing and before broadcast.

- [ ] **Step 2: Run RED**

Run: `npm --prefix apps/backend test`

Expected: FAIL; current journal/status/API incomplete.

- [ ] **Step 3: Implement API**

Use security-core PWA exports. Store no raw assertions or reusable signatures. Persist hashes, public request, approvals-present flags, outer hash, receipt identity. All responses `no-store`. Redact raw provider errors. Add root `backend:test`, `backend:typecheck`; include both in root `test`/`check`.

- [ ] **Step 4: Run GREEN**

Run: `npm --prefix apps/backend test && npm --prefix apps/backend run typecheck`

Run: `npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend package.json
git commit -m "feat: add durable PWA submission API"
```

### Task 9: Complete onboarding, tier, queue, recovery UX

**Files:**
- Modify: `apps/app/src/lib/vault-store.tsx`
- Modify: `apps/app/src/lib/vault-store.test.tsx`
- Modify: `apps/app/src/lib/activity-model.ts`
- Modify: `apps/app/src/lib/vault-activity.ts`
- Modify: `apps/app/src/lib/vault-activity.test.ts`
- Modify: `apps/app/src/routes/onboarding.tsx`
- Modify: `apps/app/src/routes/send.tsx`
- Modify: `apps/app/src/routes/activity.index.tsx`
- Modify: `apps/app/src/routes/activity.$id.tsx`
- Modify: `apps/app/src/routes/index.tsx`
- Modify: `apps/app/src/routes/limits.tsx`
- Modify: `apps/app/src/routes/profile.tsx`
- Modify: `apps/app/src/components/wallet/topology-alert.tsx`
- Modify: route/component tests under `apps/app/src`

**Interfaces:**
- `VaultStore` owns all wallet state. Routes remain presentation/actions only.
- Store actions: `registerPrimary`, `registerSecondary`, `planVault`, `refreshProvisioningApproval`, `provisionVault`, `prepareTransfer`, `approveSubmission`, `cancelQueued`, `executeReady`, `reconcileSubmission`, `refresh`.
- `effectiveStatus()` derives time state; canonical snapshot overrides device clock.

- [ ] **Step 1: Write RED journeys**

Test backend unavailable, wrong profile, primary cancel, secondary cancel, same-device warning, distinct-secondary completion, plan-awaiting-operator, provisioning receipt, faucet instructions, X one prompt, Y two ordered prompts, Z queue, cancel, early disabled, ready execute, expiry, restart, uncertain recovery, reverted receipt, stale snapshot, offline block. Assert no simulated success. Limits page read-only. Persistent Sepolia/no-recovery/no-notification warning.

- [ ] **Step 2: Run RED**

Run: `npm --prefix apps/app test`

Expected: FAIL; journeys incomplete.

- [ ] **Step 3: Implement store-first UI**

Keep public profile/vault/submission IDs in versioned environment-scoped localStorage. Never store assertion/signature. Different profile key cannot load another vault. Show exact chain-derived X/Y/Z/spend/queue. Show secondary authenticator class. Use backend results plus canonical reads for success.

- [ ] **Step 4: Run GREEN, lint, build**

Run: `npm --prefix apps/app test`

Run: `npm --prefix apps/app run lint`

Run: `npm --prefix apps/app run build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/app
git commit -m "feat: finish PWA vault journeys"
```

### Task 10: Independent observer and evidence package

**Files:**
- Create: `packages/security-core/src/pwa/observer.ts`
- Create: `packages/security-core/scripts/pwa/observe.ts`
- Create: `packages/security-core/scripts/pwa/package-evidence.ts`
- Create: `packages/security-core/test/unit/pwa/observer.test.ts`
- Create: `packages/security-core/test/integration/pwa-evidence.test.ts`
- Modify: `packages/security-core/package.json`
- Modify: `packages/security-core/docs/security/call-graph.md`
- Modify: `packages/security-core/docs/security/testnet-runbook.md`
- Modify: `packages/security-core/docs/security/dependency-review.md`
- Modify: `apps/app/README.md`
- Modify: `apps/backend/README.md`

**Interfaces:**
- `observePwaReceipt(binding, receiptHash): Promise<PwaObserverRecord>`; read-only clients only.
- `packagePwaEvidence(inputDirectory, outputDirectory): PwaEvidenceManifest`; no authority/signers/RPC write.
- Observer binds receipt/block/hash, exact outer envelope, Safe/Delay effects, USDC balances/counters, queue tuple/time, topology/profile hash.

- [ ] **Step 1: Write RED observer/evidence tests**

Accept canonical X/Y/queue/cancel/execute. Reject outer success with inner failure, wrong event, wrong block hash, reorg, missing confirmations, stale queue, balance/counter mismatch, same RPC disagreement, missing receipt, notification-delivery claim. Manifest requires separate observer process identity and no signing/write method.

- [ ] **Step 2: Run RED**

Run: `npm --prefix packages/security-core test -- test/unit/pwa/observer.test.ts test/integration/pwa-evidence.test.ts`

Expected: FAIL; PWA observer absent.

- [ ] **Step 3: Implement read-only observer/package**

Reuse guard/Delay decoders and topology verifier. No notifier/outbox/webhook. Label in-app activity non-independent. Add `pwa:observe`, `pwa:evidence` scripts.

- [ ] **Step 4: Run GREEN**

Run same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/security-core/src/pwa packages/security-core/scripts/pwa packages/security-core/test packages/security-core/package.json packages/security-core/docs/security apps/app/README.md apps/backend/README.md
git commit -m "feat: add read-only PWA evidence observer"
```

### Task 11: Deterministic gates and localhost rehearsal

**Files:**
- Create: `packages/security-core/scripts/pwa/rehearse-local.ts`
- Create: `packages/security-core/test/integration/pwa-local-rehearsal.test.ts`
- Create after authorized run: `packages/security-core/docs/evidence/YYYY-MM-DD-pwa-localhost.md`
- Modify: root `package.json`
- Modify: `packages/security-core/docs/security/testnet-runbook.md`
- Modify: `packages/security-core/docs/superpowers/plans/2026-10-31-sepolia-pwa-phase-one.md` checkboxes only after evidence.

**Interfaces:**
- `pwa:rehearse:local review` emits unsigned plan/caps.
- `pwa:rehearse:local submit-one` broadcasts one separately approved next action.
- `pwa:rehearse:local resume-one` reconciles one durable hash; cannot sign/broadcast.
- Exact sequence: provision, fund 8 USDC, X 1, Y 2, queue 4, cancel, requeue 4, early reject, ready execute.

- [ ] **Step 1: Add local end-to-end test**

Use real Safe 1.5, guard, Delay, factory-bound P-256 signers, backend HTTP, browser WebAuthn fixtures, app store. No historical mock. Prove refresh/install state. Prove terminal balance 1 USDC; exact counters; no queue; observer record per live receipt.

- [ ] **Step 2: Run full deterministic gates**

Run: `npm ci`

Run: `npm run check`

Run: `npm --prefix packages/security-core run test:invariant`

Run: `npm --prefix packages/security-core run coverage`

Run: `npm --prefix packages/security-core run slither`

Run: `npm --prefix apps/app run lint && npm --prefix apps/app run build`

Run: `npm --prefix apps/backend run typecheck`

Run: `git diff --check`

Expected: PASS. Record exact outputs.

- [ ] **Step 3: Generate localhost review package; stop**

Run review only. Verify exact Safe, credentials, token, recipient, 8-USDC principal, gas/fee/ETH ceilings, observer readiness, exclusive deadline. Publish unsigned hashes. Request explicit human approval for funding/signing/broadcast. Do not infer approval from this plan.

- [ ] **Step 4: Execute one approved action at a time**

After explicit approval, use `submit-one`; wait canonical receipt plus observer record; review next action. Use `resume-one` after uncertainty. Use Circle faucet manually only when approved/needed. Never auto-run sequence.

- [ ] **Step 5: Package evidence and rerun gates**

Require complete canonical receipts, early-rejection proof, terminal topology/counters/balances, observer manifest. Redact secrets/assertions/signatures/endpoints.

- [ ] **Step 6: Commit**

```bash
git add packages/security-core/scripts/pwa packages/security-core/test/integration/pwa-local-rehearsal.test.ts packages/security-core/docs/evidence packages/security-core/docs/security/testnet-runbook.md package.json packages/security-core/docs/superpowers/plans/2026-10-31-sepolia-pwa-phase-one.md
git commit -m "test: prove localhost PWA tiers on Sepolia"
```

### Task 12: Stable HTTPS/mobile proof and Phase One closeout

**Files:**
- Create: `packages/security-core/docs/evidence/YYYY-MM-DD-pwa-https-mobile.md`
- Modify: `packages/security-core/docs/security/testnet-runbook.md`
- Modify: `apps/app/README.md`
- Modify: `apps/backend/README.md`
- Modify: `packages/security-core/docs/superpowers/plans/2026-10-31-sepolia-pwa-phase-one.md`

**Interfaces:**
- Uses same code/profile; new exact HTTPS RP; fresh credentials/Safe.
- Repeat: install, provision, fund 8, X 1, Y 2, queue 4, UI early block, ready execute. Cancellation need not repeat.

- [ ] **Step 1: Review ingress and origin**

Use one stable HTTPS app origin and exact protected HTTPS backend origin. Backend remains developer-machine loopback behind TLS ingress. Require access policy/cookie, exact CORS, no public unauthenticated route, no admin route, no URL secret, short ingress lifetime. Record provider configuration hashes, not secrets.

- [ ] **Step 2: Verify install/profile before funding**

Install on mobile. Prove standalone mode, exact RP/origin, distinct secondary authenticator, separate environment storage, fresh verified topology/profile. Offline write attempt blocks. Stop for separate unsigned live approval.

- [ ] **Step 3: Execute approved essential sequence**

One action per review/receipt/observer gate. Prove X, Y, queue, canonical early UI block, ready execution. Terminal balance 1 USDC; no active queue; topology unchanged.

- [ ] **Step 4: Disable ingress; package evidence**

Prove backend URL unavailable after closeout. Evidence states: Sepolia prototype; no recovery; no notifications; no ERC-4337; no mainnet/production/audit claim.

- [ ] **Step 5: Run final gates**

Run: `npm ci && npm run check`

Run: `npm --prefix packages/security-core run security:check`

Run: `npm --prefix apps/app run lint && npm --prefix apps/app run build`

Run: `npm --prefix apps/backend run typecheck`

Run: `git diff --check`

Expected: PASS.

- [ ] **Step 6: Mark only Phase One complete; commit**

Leave repair, ERC-4337, notification delivery, hosted relay, mainnet/audit/native-wrapper unchecked under Phase Two.

```bash
git add packages/security-core/docs apps/app/README.md apps/backend/README.md
git commit -m "docs: close Sepolia PWA phase one"
```
