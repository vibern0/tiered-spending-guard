# Client-Only Pimlico Wallet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace wallet backend with static browser app, Safe ERC-4337, Pimlico sponsorship, and verified onchain X/Y/Z enforcement.

**Architecture:** Gate Safe4337Module compatibility first. Preferred candidate transports canonical signed `Safe.execTransaction` inside primary-signed `SafeOp`; guard retains policy authority. Browser owns public metadata/reconciliation; independent read-only observer retains alerts. Delete backend after replacement proofs pass.

**Tech Stack:** React 19, Vite `8.1.5`, TanStack Router `1.170.41`, viem `2.56.7`, SimpleWebAuthn browser `14.0.0`, candidate permissionless `0.5.0`, Safe `1.5.0`, candidate Safe4337 `0.3.0-1` / EntryPoint `0.7`, Zodiac Delay, IndexedDB, Hardhat, standards-enforcing local bundler.

**Spec:** `packages/security-core/docs/superpowers/specs/2026-10-16-client-only-pimlico-design.md`

**2026-10-19 scope supersession:** The approved [native Safe design](../specs/2026-10-17-native-safe-4337-design.md) replaces this plan's stock Safe4337Module, nested `execTransaction`, sponsored prerequisite deployment, and funder-paid EntryPoint-deposit assumptions. Its only accepted candidate uses the named restricted handler, locked bootstrap helper/factory, inert creation-code anchors, sponsored gas, a contract-only secondary, and delayed handler/profile maintenance. This historical plan's ordinary-Safe live prerequisite and backend-retention gates remain binding. None of its unchecked implementation steps are authorized by the supersession alone.

## Global Constraints

- Sepolia (`chainId = 11155111`) only. No WalletConnect, mainnet, arbitrary DeFi, or production/audit claim.
- No application server or database is required for wallet operation.
- Browser storage holds public account metadata and reconciliation records.
- Independent read-only monitoring remains mandatory and may run outside the app.
- One asset-holding Safe; primary passkey sole owner at threshold 1; configured secondaries remain guard-only.
- Constrain owner and module execution onchain. Preserve X/Y accounting, rollback, mandatory Z, cancellation, freeze, delayed weakening, immediate tightening.
- No instant batch/delegatecall, unknown calldata, approvals, Permit/Permit2, arbitrary messages, extra owner, session key, or unreviewed module.
- Never store passkey private keys, raw assertions, reusable signatures, relay keys, provider secrets, or raw signed UserOperations.
- Every `VITE_*` value and every browser request is visible. Never embed an unrestricted billing/admin key, private RPC secret, or server credential.
- Sponsorship only: no vault ETH prefund, EntryPoint withdrawals, ERC-20 paymaster approvals, token charges, or gas refunds from the Safe.
- Stop with separate focused proposal if accepted properties require custom Solidity beyond `TieredSpendingGuard` and internal signature/digest helpers.
- Backend deletion depends on passing compatibility, contract, bundler, deployment, browser, and reconciliation gates. Known fallback and permissionless Delay transport conflicts remain unresolved.
- Existing backend-profile Safes remain read-only. Fresh verified profile only; no automatic funded-Safe migration.
- Preserve unrelated UI changes from `918bf8e`. Update call graph per execution path; dependency review per security dependency.
- Ordinary Safe live evidence precedes ERC-4337 implementation. Check actual evidence; unchecked historical gates do not become passed by assumption.

## Review Focus

- Stock fallback accepts arbitrary ERC-1271 messages: reject onchain, including callers bypassing UI. Task 1/2.
- Browser credential extraction or DER parsing differs from actual authenticator output: prove real cryptography and exact signed bytes. Task 3.
- Browser key exposure drains sponsor budget: verify provider controls; block unrestricted credentials. Task 2/5.
- Timeout/reload/tab race creates duplicate or changed submission: persist exact public hashes; reconcile before replacement. Task 4/6.
- Browser closes during delay: independent observer still alerts; ready execution remains permissionless without original signers online. Task 1/7/10.

---

### Task 1: Resolve Compatibility And Prior Evidence Gates

**Files:**
- Read: `AGENTS.md`, required research/core-plan/signer documents, active evidence/runbooks.
- Create: `packages/security-core/docs/security/pimlico-compatibility.md`
- Create: `packages/security-core/test/integration/aa-compatibility.test.ts`
- Create: `packages/security-core/test/fixtures/aa-compatibility.ts`
- Modify: `packages/security-core/docs/security/dependency-review.md`
- Modify, only for reviewed probe dependencies: `packages/security-core/package.json`, `pnpm-lock.yaml`

**Interfaces:**
- Consumes: existing real Safe/WebAuthn/Delay fixtures; candidate package/source evidence.
- Produces: compatibility report `{ status: "blocked" | "passed", evidence, unresolved }`; `passed` requires every spec gate.
- Produces after pass: exact selector/call graph, nested-check state machine, fallback restriction, permissionless Delay route, prerequisite deployment route, canonical addresses/hashes, and pinned bundler command.

- [x] **Step 1: Audit prior evidence**

Map ordinary Safe real-cryptography local/live requirements to recorded hashes/reports. Missing live evidence blocks ERC-4337 implementation; prepare only read-only investigation/report until separately authorized rehearsal completes. Do not execute live transactions from this plan automatically.

- [ ] **Step 2: Write rejection-first compatibility tests**

Suite `AA compatibility`: stock module execution rejected by current module guard; arbitrary ERC-1271 signature rejected under proposed profile; outer-primary-only step-up cannot spend; nested self-call cannot skip inner guard; no missing-prefund drain; no second owner/custody Safe; no unfunded hidden deployment prerequisite; ready Delay executes without original signer online. Tests expose actual incompatible upstream behavior; do not invert expectations merely to make stock behavior pass.

- [ ] **Step 3: Run probe and record failures**

Run: `npm --prefix packages/security-core test -- test/integration/aa-compatibility.test.ts`

Expected initially: FAIL for unresolved integration/restriction proofs. Record real failures and exact upstream source/package/audit evidence. Check EntryPoint validation/storage/staking constraints with chosen local bundler; record image/package digest and exact invocation in compatibility report.

- [x] **Step 4: Resolve disposition**

Choose only reviewed existing primitives plus scoped guard/helper changes. Report exact workable bootstrap, fallback restriction, nested-check design, and permissionless Delay route. If none exists, mark `blocked`, write focused proposal, and stop Tasks 2–10. No mock fallback, extra contract, broad module exception, external private key, or weakened message policy.

- [x] **Step 5: Commit report and probe**

```bash
git add packages/security-core/docs/security packages/security-core/test packages/security-core/package.json pnpm-lock.yaml
git commit -m "docs: assess guarded Safe Pimlico compatibility"
```

**2026-10-16 disposition:** `blocked`. [Compatibility report](../../security/pimlico-compatibility.md) records missing ordinary-Safe live evidence and source-level conflicts. Step 1 permits read-only investigation/report only; Steps 2–3 were not run, Step 4 produced the [focused proposal](../specs/2026-10-16-pimlico-blocker-resolution.md), and Step 5 delivers the report/docs commit for review only; no probe was authorized or added. Tasks 2–10 remain gated. No probe, dependency installation, implementation or live transaction occurred.

### Task 2: Pin Profile And Prove Guarded ERC-4337 Execution

**Prerequisite:** Task 1 `passed`, prior live gate evidenced. Selected path differs materially from spec candidate: amend/review spec before code.

**Files:**
- Create: `packages/security-core/src/aa/{types,profile,operation}.ts`
- Create: `packages/security-core/test/unit/aa/{profile,operation}.test.ts`
- Create: `packages/security-core/test/integration/aa-policy.test.ts`
- Modify: `packages/security-core/contracts/TieredSpendingGuard.sol`
- Modify only as required: `packages/security-core/contracts/libraries/{PolicyDigest,SafeSignatureDecoder}.sol`
- Modify: `packages/security-core/src/config/deployments.ts`, `packages/security-core/src/topology/verify.ts`
- Modify: research/core-plan supersession notes, signer evaluation, `docs/security/{call-graph,dependency-review}.md`, package manifests/lockfile.

**Interfaces:**
- `verifyAaProfile(client: PublicClient, manifest: AaManifest): Promise<VerifiedAaProfile>`; opaque evidence minted only by code/topology verification.
- `buildSafeExecutionEnvelope(inner: CanonicalSafeExecution): Hex`; zero-value self-`CALL`, canonical `execTransaction` only.
- `hashAaOperation(profile: VerifiedAaProfile, operation: UnsignedAaOperation): { safeOpHash: Hex; userOperationHash: Hex }`.
- Shared `aa/types.ts`: `AaManifest`, opaque `VerifiedAaProfile`, `CanonicalSafeExecution`, `UnsignedAaOperation`, `PreparedAaOperation`, `PublicVaultMetadata`, `ConfirmedAaOutcome`. Use spec fields; pin actual EntryPoint `0.7` schema; distinguish every digest and nonce type.
- `PublicVaultMetadata`: schema version, chain `11155111`, Safe/guard/Delay/module/EntryPoint addresses, credential IDs/public coordinates/RP IDs/roles/signer addresses, deployment salt, manifest/policy hashes, deployment hashes. Browser-specific storage functions live in Task 3 `metadata.ts`.
- `PreparedAaOperation`: inner canonical SafeTx and digest, Safe nonce, outer operation fields and EntryPoint nonce/key, SafeOp/UserOperation hashes, profile/manifest/policy binding, required factors, expiry, fee ceilings; signatures memory-only.
- `ConfirmedAaOutcome`: exact operation ID/hash, spec state, optional canonical transaction/block identity, verified inner result, optional queue fingerprint/nonce; no outer-success-only confirmation.

- [ ] **Step 1: Write failing profile/digest/policy tests**

Reject Safe `1.4.1`, missing/mismatched code, `verified: true` JSON, unknown fallback/module/paymaster/factory, wrong EntryPoint, self-call selector confusion, trailing calldata, native prefund, batch/delegatecall. Mutate every SafeTx/SafeOp/UserOperation field; compare hashes against pinned module/EntryPoint functions. Prove X=10, Y=30, Z=120 seconds: base totals <=10, shared instant totals <=30, queue waits >=120, cancellation prevents execution, failed token transfer rolls back. Include direct owner path and both configured secondary formats.

- [ ] **Step 2: Run RED**

Run: `npm --prefix packages/security-core test -- test/unit/aa/profile.test.ts test/unit/aa/operation.test.ts test/integration/aa-policy.test.ts`

Expected: FAIL; missing APIs/enforcement.

- [ ] **Step 3: Implement approved profile and minimal guard changes**

Install exact reviewed versions; retain current viem/Safe pins. Implement Task 1 nested-check state machine with exact pending-envelope binding and matching after-hooks. Keep Delay path separate. Reject arbitrary reentrancy, fallback messages, bypasses, prefund, and stale state onchain. Update static/invariant security inventories and all affected topology verifiers. Record required browser sponsorship restrictions and unsupported provider controls.

- [ ] **Step 4: Verify GREEN and bundler acceptance**

Run focused command above, then `npm --prefix packages/security-core run security:check`. Run exact pinned local bundler command from compatibility report. Expected: all security assertions pass; valid operation accepted under standard validation rules; mutation operations rejected before asset movement.

- [ ] **Step 5: Commit**

```bash
git add packages/security-core pnpm-lock.yaml
git commit -m "feat: enforce guarded Safe account abstraction"
```

### Task 3: Browser Registration And Exact Passkey Signatures

**Files:**
- Create: `apps/app/src/lib/wallet/{passkeys,metadata}.ts`
- Create: `apps/app/src/lib/wallet/{passkeys,metadata}.test.ts`
- Modify: `apps/app/src/lib/webauthn-passkey.ts`, `apps/app/src/lib/webauthn-passkey.test.ts`
- Modify: signer evaluation and dependency review when parser dependency changes.

**Interfaces:**
- `registerVaultPasskey(input: { role: "primary" | "secondary"; rpId: string; origin: string }): Promise<PasskeyMetadata>`.
- `signVaultDigest(input: { credential: PasskeyMetadata; digest: Hex; purpose: "safe-tx" | "safe-op"; safe: Address; chainId: 11155111 }): Promise<Hex>`; signature memory-only.
- `PasskeyMetadata`: credential ID, P-256 coordinates, role, RP ID/origin, verified factory signer binding; no private material/assertion.
- `loadVaultMetadata(): Promise<PublicVaultMetadata | undefined>` / `saveVaultMetadata(value: PublicVaultMetadata): Promise<void>`; versioned IndexedDB schema.

- [ ] **Step 1: Write failing real-ceremony tests**

Assert random single-use challenges; correct credential/public-key binding; localhost/stable HTTPS RP handling; secondary external authenticator allowed; wrong origin/RP hash/challenge/UV/UP/key/algorithm rejected. Test canonical DER, leading-zero integers, truncated/trailing/negative/zero/out-of-range components; exact clientDataJSON verification. Distinguish SafeTx and SafeOp digest contexts. Restore same credential on same RP without creating replacement account.

- [ ] **Step 2: Run RED**

Run: `npm --prefix apps/app test -- src/lib/wallet/passkeys.test.ts src/lib/wallet/metadata.test.ts src/lib/webauthn-passkey.test.ts`

Expected: FAIL; client registration/DER/metadata APIs absent.

- [ ] **Step 3: Implement browser verification and metadata**

Use reviewed browser-compatible parsing/crypto; no `@simplewebauthn/server` or Node dependency in bundle. Proof of possession precedes setup. Preserve signed JSON fields and onchain verifier checks. Validate imported metadata, chain, manifest, role, and signer binding before accepting; metadata alone never authorizes writes.

- [ ] **Step 4: Run GREEN**

Run focused command above. Expected: real generated P-256 registration/assertion vectors pass; forged/mutated inputs fail; persisted records contain no raw assertions/signatures/secrets.

- [ ] **Step 5: Commit**

```bash
git add apps/app/src/lib packages/security-core/docs/security
git commit -m "feat: verify vault passkeys in browser"
```

### Task 4: Browser Journal And Restart Reconciliation

**Files:**
- Create: `apps/app/src/lib/wallet/{journal,reconcile}.ts`
- Create: `apps/app/src/lib/wallet/{journal,reconcile}.test.ts`
- Reuse cases from: `apps/backend/tests/{journal,submit}.test.ts`

**Interfaces:**
- `prepareSubmission(record: PublicSubmissionRecord): Promise<void>`; exact operation hash persisted before network send.
- `withVaultSubmissionLock<T>(safe: Address, action: () => Promise<T>): Promise<T>`; transactionally bind pending record as well as browser lock.
- `reconcileSubmission(id: Hex, clients: ReconciliationClients): Promise<ConfirmedAaOutcome>`.
- Public record schema/statuses exactly from spec. No signature/secret persistence.
- Export `PublicSubmissionRecord`, `ReconciliationClients` from `journal.ts` / `reconcile.ts`: record includes intent/digest/hash/nonce/profile/queue/block fields from spec; clients provide read-only RPC, exact-hash bundler receipt/operation queries, expected profile, and confirmation depth. No signer or send capability.

- [ ] **Step 1: Write failing journal/reload tests**

Assert immutable ID/hash binding; persistence-before-send; two-tab locking; device nonce race fails onchain; timeout stays uncertain; missing bundler record cannot authorize retry; reload/import/lost storage never invents confirmation. Reject wrong sender/hash/EntryPoint/event, outer success with failed inner Safe call, wrong queue tuple; confirmation depth/reorg handling restores pending state.

- [ ] **Step 2: Run RED**

Run: `npm --prefix apps/app test -- src/lib/wallet/journal.test.ts src/lib/wallet/reconcile.test.ts`

Expected: FAIL; IndexedDB journal/reconciler absent.

- [ ] **Step 3: Implement durable public state**

Use IndexedDB transactions and browser locks. Unsupported lock/storage or failed persistence blocks writes with actionable error. Query chain and bundler by recorded exact hashes. Retry only from reconciled disposition; no automatic replacement signing on ambiguous result. Preserve complete queue fingerprint/nonce and canonical block identity.

- [ ] **Step 4: Run GREEN**

Run focused command above. Expected: duplicate, restart, uncertainty, event, and reorg cases pass; no private/signed data at rest.

- [ ] **Step 5: Commit**

```bash
git add apps/app/src/lib/wallet
git commit -m "feat: reconcile browser UserOperation submissions"
```

### Task 5: Exact Approval, Sponsorship, And Submission Client

**Files:**
- Create: `apps/app/src/lib/wallet/{transactions,pimlico}.ts`
- Create: `apps/app/src/lib/wallet/{transactions,pimlico}.test.ts`
- Create: `packages/security-core/test/integration/aa-submission.test.ts`
- Modify: `packages/security-core/docs/security/call-graph.md`

**Interfaces:**
- `prepareClientTransfer(input: { vault: PublicVaultMetadata; recipient: Address; amount: bigint }): Promise<PreparedAaOperation>`.
- `approveAndSubmit(input: PreparedAaOperation): Promise<ConfirmedAaOutcome>`.
- Prepared operation freezes inner SafeTx/signatures in memory, final outer fields, both nonce domains, all digests, profile/manifest/policy binding, required factors, expiry, paymaster identity, and fee ceilings.
- `createPimlicoTransport(config: PublicWalletConfig)` exposes estimate/sponsor/send/receipt only; no server key or policy authority.

- [ ] **Step 1: Write failing exact-operation tests**

Assert latest authoritative snapshot, inner primary then required secondary, exact frozen envelope, documented dummy signature simulation, finalized paymaster/gas before outer approval, and independent digest/hash agreement. Mutating fee/nonce/key/paymaster/validity/initCode/callData after signing requires new approval. Reject failed/expired sponsorship, unsupported browser credentials, spending-policy substitution, gas paid by vault, endpoint redirect/chain mismatch, and timeout retry. Neither sponsor acceptance nor successful simulation means confirmed.

- [ ] **Step 2: Run RED**

Run: `npm --prefix apps/app test -- src/lib/wallet/transactions.test.ts src/lib/wallet/pimlico.test.ts`

Run: `npm --prefix packages/security-core test -- test/integration/aa-submission.test.ts`

Expected: FAIL; browser orchestration absent.

- [ ] **Step 3: Implement submission through permissionless/Pimlico**

Use reviewed exact versions and explicit Safe/module/EntryPoint profile. Keep inner and outer approvals distinct; prohibit library defaults silently rebuilding signed fields. Persist Task 4 record before send; return verified outcome only. Sanitize endpoint credentials from errors/logs; all endpoints must support browser CORS under actual deployment origin.

- [ ] **Step 4: Run GREEN plus real bundler**

Run focused commands above and Task 1 pinned local bundler gate. Expected: valid sponsored operation succeeds with no relay key; all mutations rejected; reload reconciles exact receipt.

- [ ] **Step 5: Commit**

```bash
git add apps/app/src/lib/wallet packages/security-core/test/integration packages/security-core/docs/security/call-graph.md
git commit -m "feat: submit exact vault operations with Pimlico"
```

### Task 6: Sponsored Fresh Vault Provisioning

**Files:**
- Create: `apps/app/src/lib/wallet/{config,manifest,provision}.ts`
- Create: `apps/app/src/lib/wallet/{config,manifest,provision}.test.ts`
- Create: `apps/app/src/config/sepolia-aa.json`
- Modify: `packages/security-core/src/topology/{build,addressing,reviewed-artifacts,verify}.ts`
- Create: `packages/security-core/test/integration/aa-bootstrap.test.ts`
- Modify: `packages/security-core/docs/security/{call-graph,testnet-runbook,dependency-review}.md`

**Interfaces:**
- `loadWalletConfig(env: Readonly<Record<string, string | undefined>>): PublicWalletConfig`; exact public variables from spec.
- `provisionClientVault(input: { primary: PasskeyMetadata; secondary: PasskeyMetadata; config: PublicWalletConfig }): Promise<PublicVaultMetadata>`.
- Consumes Task 1 approved sponsored factory/bootstrap route and Task 2 verified profile. Bundled manifest is build input; verification remains RPC-backed.

- [ ] **Step 1: Write failing provisioning tests**

Assert byte-identical plans for same public inputs; salt/identity resume; single Safe custody; every prerequisite deployed through approved sponsored route; both guards/fallback/module graph installed atomically; primary sole owner. Reject wrong factory/initCode/runtime hash/asset/receipt/chain, interrupted bootstrap drift, missing sponsorship, substituted browser metadata, and old backend-profile Safe. Verify mandatory observer configuration/readiness remains visible.

- [ ] **Step 2: Run RED**

Run: `npm --prefix apps/app test -- src/lib/wallet/config.test.ts src/lib/wallet/manifest.test.ts src/lib/wallet/provision.test.ts`

Run: `npm --prefix packages/security-core test -- test/integration/aa-bootstrap.test.ts`

Expected: FAIL; client/bootstrap APIs absent.

- [ ] **Step 3: Implement approved bootstrap**

Use bundled reviewed creation artifacts and canonical factories. No nonce-derived EOA deployer assumption, relay key, external path, dynamic adapter, or default SDK Safe version. Confirm every prerequisite before dependent deployment; verify final topology before storing usable account. Account restore re-verifies chain state.

- [ ] **Step 4: Run GREEN**

Run both focused commands plus deterministic topology suites. Expected: fresh setup/resume verified; malformed evidence fails closed; no partial account shown as writable.

- [ ] **Step 5: Commit**

```bash
git add apps/app/src packages/security-core/src/topology packages/security-core/test packages/security-core/docs/security
git commit -m "feat: provision guarded vault through Pimlico"
```

### Task 7: Wallet UI, Delay Controls, And Observer Integration

**Files:**
- Create: `apps/app/src/lib/wallet/{client,delay}.ts`, matching `.test.ts` files.
- Modify: `apps/app/src/lib/{vault-store.tsx,vault-store.test.tsx,provisioning-errors.ts,provisioning-errors.test.ts,vault-chain.ts,vault-activity.ts,use-approval.ts}`
- Modify: `apps/app/src/routes/{onboarding,send,limits,activity.index,activity.$id,profile}.tsx`, `apps/app/src/test/app-routing.test.tsx`
- Modify: `packages/security-core/src/monitoring/{guard-events,delay-events}.ts`, associated tests, `docs/security/call-graph.md`

**Interfaces:**
- `ClientVaultWallet`: `registerPasskey`, `provisionVault`, `sendTransfer`, `queueAction`, `cancelQueue`, `freeze`, `executeReady`, `readSubmission`; same shared input/outcome types.
- Provider prop `wallet?: ClientVaultWallet` replaces `backend`; preserve `hasAccount`, `finishSetup`, health/write gates.
- Delay actions use Task 1 approved routes; readiness reports observer status separately from chain state.

- [ ] **Step 1: Write failing UI/Delay tests**

Assert onboarding resumes public metadata; completion gate retained; first/second signer copy; separate inner/outer approvals; sponsorship failure/cancellation/stale chain visible. Verify exact queue nonce/time/expiration; enumerate collateral cancellation; reject early/cancelled/expired execution; ready execution works without original factors online. Decode guard events inside ERC-4337 transaction/inner envelope; observer receives confirmed exact events while app closed. Old Safe profile remains read-only.

- [ ] **Step 2: Run RED**

Run: `npm --prefix apps/app test`

Run: `npm --prefix packages/security-core run test:unit -- --grep 'guard activity|Delay activity'`

Expected: FAIL for absent client wallet actions / AA event binding.

- [ ] **Step 3: Wire wallet and observer**

Keep policy decisions onchain. Browser displays advisory limits and canonical outcomes. Do not show queued/elapsed operations as executed. Preserve independent read-only monitoring without app API dependency or signing capability; bind AA events to exact inner Safe/Delay actions.

- [ ] **Step 4: Run GREEN**

Run both commands above. Expected: UI workflows and observer/reorg cases pass; app closure does not cancel independent observation.

- [ ] **Step 5: Commit**

```bash
git add apps/app/src packages/security-core/src/monitoring packages/security-core/test packages/security-core/docs/security/call-graph.md
git commit -m "feat: wire client wallet and delayed operations"
```

### Task 8: Static Browser Build

**Files:**
- Create: `apps/app/index.html`, `apps/app/src/main.tsx`
- Modify: `apps/app/{vite.config.ts,vitest.config.ts,tsconfig.json,package.json}`, `apps/app/src/{router.tsx,routes/__root.tsx}`
- Delete when no longer referenced: `apps/app/src/{server.ts,start.ts}`, server-only `src/lib/{error-capture,error-page}.ts`
- Create: `apps/app/scripts/verify-static-build.mjs`
- Modify: `apps/app/README.md`, lockfile, root scripts when required.

**Interfaces:**
- `npm --prefix apps/app run build` emits static `dist/index.html` and assets.
- `npm --prefix apps/app run verify:static` checks output/imports for server/runtime dependencies.
- `npm run app:dev` serves same client flow locally.

- [ ] **Step 1: Define failing static acceptance check**

Verify shell, route assets, no Node imports/server functions/Nitro worker, no `BACKEND_*`/backend endpoint requests, no private key or unrestricted secret fixtures in bundle. Record current SSR output failure before migration. Browser smoke direct loads `/onboarding`, `/send`, `/limits`, `/activity`, `/profile`, and `/activity/<id>` through SPA fallback.

- [ ] **Step 2: Implement plain Vite/React/TanStack Router entry**

Replace Lovable Start config with explicit Router/React/Tailwind plugins and existing alias. Remove Start shell `Scripts`/SSR entry assumptions; retain route head/error/not-found behavior. Remove Start/Nitro and unused wrapper dependencies from app only. Pin newly selected versions; keep landing package independent.

- [ ] **Step 3: Verify static build and routes**

Run: `npm --prefix apps/app test && npm --prefix apps/app run build && npm --prefix apps/app run verify:static`

Expected: PASS; host `dist` on static server with SPA fallback, verify listed direct routes and browser network calls to approved RPC/Pimlico only for wallet writes. No API process required.

- [ ] **Step 4: Commit**

```bash
git add apps/app package.json pnpm-lock.yaml
git commit -m "refactor: build wallet as static browser app"
```

### Task 9: Delete Backend And Replace Active Documentation

**Prerequisite:** Tasks 1–8 passed; preserve regression coverage before deletion.

**Files:**
- Delete: `apps/backend/` tracked source/tests/config/README/package.
- Modify: `.gitignore`, root `package.json`, `pnpm-lock.yaml`, `AGENTS.md`, `apps/app/{AGENTS.md,README.md}`
- Modify: security research/core-plan supersession notes, `docs/security/{call-graph,dependency-review,signer-provider-evaluation,testnet-runbook}.md`
- Modify: `packages/security-core/docs/superpowers/specs/2026-10-16-eurc-wallet-backend-design.md` status; historical plan/evidence status notes only.
- Create: `packages/security-core/test/unit/config/client-only-boundary.test.ts`

**Interfaces:**
- Root `npm test`, `npm run check`, and `npm run build` include replacement browser/core gates.
- Active setup: dependency install with committed lockfile, public browser configuration, one app development process.

- [ ] **Step 1: Write deletion-boundary regression**

Assert no tracked backend package, active imports, endpoint client, server verifier dependency in browser, relay-key variable, external artifact/adapter path, backend-origin variable, or runtime SSR requirement. Map every removed backend test to replacement coverage or explicit obsolete endpoint-only behavior.

- [ ] **Step 2: Run RED**

Run: `npm --prefix packages/security-core run test:unit -- --grep 'client-only boundary'`

Expected: FAIL; backend and active references remain.

- [ ] **Step 3: Delete exact backend target and update references**

Delete only tracked `apps/backend` files; retain Git history and reusable security tests now ported. Remove backend importer/unused dependencies. Replace backend-required instruction only after gate pass. Mark previous backend design superseded; preserve honest historical/live evidence. Document public key exposure, sponsor budgets, stable RP ID, public metadata restore, read-only old accounts, static hosting, and independent observer operation.

- [ ] **Step 4: Run GREEN**

Run: `npm --prefix packages/security-core run test:unit -- --grep 'client-only boundary'`

Run: `pnpm install --frozen-lockfile && npm test && npm run build`

Expected: PASS; immutable install succeeds; no backend process starts or is needed. Search remaining backend references: historical notes only, explicitly labeled.

- [ ] **Step 5: Commit**

```bash
git add -A apps/backend apps/app packages/security-core .gitignore AGENTS.md package.json pnpm-lock.yaml
git commit -m "refactor: remove wallet backend and server configuration"
```

### Task 10: Full Adversarial Gate And Handoff

**Files:**
- Create: `packages/security-core/docs/evidence/2026-10-16-client-only-pimlico.md`
- Modify: this plan checkboxes; existing testnet runbook/evidence references as justified.

**Interfaces:**
- Evidence matrix separates local contracts, bundler simulation/inclusion, browser ceremony, static hosting, independent observer, and authorized live rehearsal.

- [ ] **Step 1: Run final local gates**

```bash
pnpm install --frozen-lockfile
npm test
npm run build
npm --prefix apps/app run verify:static
npm --prefix packages/security-core run security:check
git diff --check
```

Run pinned bundler integration command from Task 1 report and static browser smoke from Task 8. Assert primary-only X, both supported secondary forms within shared Y, above-Y queue, Z wait, cancellation, expiry, permissionless execution, freeze, delayed repair, arbitrary-message denial, prefund denial, state drift, timeout/reload/reorg, and closed-browser observation. Record exact versions/counts/results; no ignored new Slither findings.

- [ ] **Step 2: Review complete diff against spec**

Check compatibility report claims against code/tests. Confirm no newly added custom contract, hidden server, private signer key, second custody account, unrestricted module/fallback, unsponsored deployment dependency, missing Delay execution route, or browser-only authorization rule. Fix findings before deletion commit considered complete.

- [ ] **Step 3: Record live boundary**

New Pimlico Sepolia writes require separate capped authorization and provider configuration. Run only when authorized; otherwise mark live rows `NOT RUN` and keep release readiness blocked. A green local gate does not establish hardware UX, deployed bytecode identity, sponsored mainnet support, or audit status.

- [ ] **Step 4: Commit evidence and hand off**

```bash
git add packages/security-core/docs
git commit -m "docs: record client-only Pimlico verification"
```

Execution ends with documents/evidence and tested branch. Opening/merging/deploying requires the applicable user request; this planning request does not authorize those actions.

## Plan Self-Review

Spec coverage: compatibility/live prerequisites 1; guard/digests 2; passkeys/restore 3; durable state 4; sponsorship/submission 5; sponsored prerequisites/profile 6; Delay/monitoring/UI 7; static runtime 8; deletion/docs 9; acceptance/evidence 10. Interface owners defined before consumers. Review-focus tests assigned. Known feasibility failures remain explicit blockers; no task treats them as implemented or silently relaxes policy.
