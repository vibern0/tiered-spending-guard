# Two-Owner Atomic Deployment and Submission Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert vault to two Safe owners, deploy final guarded topology atomically, submit only exact authorized Safe calls or ready Delay calls through non-authorizing HTTPS relayer.

**Architecture:** Delete recovery role from onchain and offchain surfaces. Predict guard, Delay, maintenance, Safe addresses from verified nonce sequence and call-only Safe initializer. Emit deterministic unsigned plan. HTTPS transport snapshots exact authorization data. Relayer re-reads chain state, broadcasts unchanged calldata only.

**Tech Stack:** Solidity 0.8.24, TypeScript 5, Node.js, Hardhat, viem 2.56.7, Safe Smart Account 1.5.0, `@safe-global/safe-deployments` 1.37.63, Safe passkey 0.2.0, Zodiac Delay 1.1.1, Mocha/Chai, Slither.

**Spec:** `docs/superpowers/specs/2026-09-25-atomic-safe-deployment-submission-transport-design.md`

## Global Constraints

- Safe owners exactly: configured passkey signer contract, Burner card account. Threshold 1.
- No recovery address, third owner, recovery selector, dormant recovery path, fallback handler, extra module, auxiliary custody Safe.
- Passkey loss can lock vault. Burner loss leaves only bounded base spending. Diagnostics and runbook must say so.
- `TieredSpendingGuard` stays in both guard slots. Zodiac Delay stays only Safe module. Safe stays Delay owner/avatar/target/only proposer.
- Base authorization: canonical Safe contract signature from configured passkey.
- Step-up, queue, cancellation, freeze, repair: passkey signature plus exact Burner extension.
- Safe does only one initializer delegatecall to reviewed `SafeAtomicSetupHelper`. The helper makes a fixed Safe-originated setup sequence and computes the final Safe as `address(this)`.
- Plans unsigned, deterministic, Sepolia-only for live output.
- Fail closed on deployer nonce drift, missing evidence, bytecode/config mismatch, partial prerequisite deployment.
- Relayer pays gas only. It is never owner, signer, module, cancellation authority, repair authority, policy authority.
- No key, passkey material, Burner PIN, provider/RPC credential, raw signature persisted or logged.
- No mainnet, production-ready claim, email recovery, ERC-4337 module, approval, Permit/Permit2, batch execution, arbitrary calldata, direct-wallet fallback.
- Production-code change uses red-green-refactor. Each task ends focused verification and commit.

## Review Focus

- Sender nonce changes after review: Task 3 rejects before plan emission or submission.
- One prerequisite deploy succeeds, next fails: Task 4 invalidates remaining plan, proves no initialized Safe exists.
- Relayer times out after broadcast: Task 6 returns `submitted`/`confirmed` from canonical reconciliation, never changed rebroadcast.
- Idempotency key reused with different payload: Task 5 rejects before network or broadcaster access.
- Safe transaction signature remains valid but Safe nonce, policy, or counters changed: Task 6 returns `stale`, never broadcasts.

---

### Task 1: Remove Recovery Role from Onchain Security Core

**Files:**
- Modify: `contracts/TieredSpendingGuard.sol`
- Modify: `contracts/GuardReplacementMaintenance.sol`
- Modify: `contracts/libraries/PolicyDigest.sol`
- Modify: `test/helpers/safe.ts`
- Modify: `test/unit/guard/signatures.test.ts`
- Modify: `test/unit/guard/spending.test.ts`
- Modify: `test/integration/guard-signatures.test.ts`
- Modify: `test/integration/guard-spending.test.ts`
- Modify: `test/integration/delayed-tier.test.ts`
- Replace: `test/integration/recovery.test.ts` with `test/integration/two-owner-maintenance.test.ts`
- Modify: `test/integration/adversarial.test.ts`
- Modify: `test/invariant/call-graph.invariant.ts`

**Interfaces:**
- Produces: `GuardConfig(address safe,address passkey,address burner,address delay,uint64 periodSeconds,uint64 periodAnchor)`.
- Produces: `repairSigner(uint8 role,address expectedOld,address replacement)`. Valid roles: `0 = passkey`, `1 = Burner`. Other roles revert.
- Preserves: passkey-only base, passkey-plus-Burner step-up/queue/emergency/repair, dual guards, atomic counter rollback.

- [ ] **Step 1: Write failing two-owner guard and maintenance tests**

Assert constructor/config ABI has six fields. Assert role `2` reverts. Assert Burner-only and arbitrary EOAs authorize no path. Assert passkey-only cannot freeze/cancel/repair. Assert passkey-plus-Burner can freeze, cancel, queue either signer replacement through Delay. Assert Safe owners exactly `[passkey, burner]`; no third address.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm run test:unit -- --grep "two-owner|TieredSpendingGuard" && npm run test:integration -- --grep "two-owner|recovery|delayed|adversarial"`

Expected: FAIL. `GuardConfig`, maintenance decoding, recovery-only branches still expose third role.

- [ ] **Step 3: Implement minimal onchain refactor**

Remove `recovery` from `GuardConfig`, policy hashes, signer distinctness, repair roles, signature modes, queue authorization, emergency authorization, comments, ABI checks. Rule: Safe-valid owner slot must be configured passkey contract signature. Emergency/queue/repair paths also require valid unused Burner extension over same Safe transaction hash.

Update `GuardReplacementMaintenance`: decode six-field config, accept roles `< 2`, preserve threshold 1, replace one of exactly two owners, verify replacement guards bind same Safe/Delay/passkey/Burner.

- [ ] **Step 4: Run focused suites and verify GREEN**

Run: `npm run test:unit -- --grep "TieredSpendingGuard" && npm run test:integration -- --grep "two-owner|delayed|adversarial" && npm run test:invariant`

Expected: PASS. No recovery-only test or public/state surface remains.

- [ ] **Step 5: Commit**

Run: `git add contracts test && git commit -m "refactor: enforce two-owner vault policy"`

---

### Task 2: Align Typed Policy, Signers, Topology Verification, Security Baselines

**Files:**
- Modify: `src/config/policy.ts`
- Modify: `src/policy/classify.ts`
- Modify: `src/signers/eip1193.ts`
- Modify: `src/topology/build.ts`
- Modify: `src/topology/verify.ts`
- Modify: `scripts/plan-deployment.ts`
- Modify: `scripts/verify-deployment.ts`
- Modify: `config/sepolia.example.json`
- Modify: `deployments/sepolia.example.json`
- Modify: matching tests under `test/unit/{policy,signers,topology,deployment}` and `test/integration/{signer-flow,topology,rehearsal}.test.ts`
- Modify: `docs/research/2026-09-16-personal-vault-research.md`
- Modify: `docs/superpowers/plans/2026-09-16-personal-vault-security-core.md`
- Modify: `docs/security/signer-provider-evaluation.md`

**Interfaces:**
- Produces: `VaultPolicy` without `recovery`.
- Produces: `verifyTopology(input): Promise<TopologyReport>` requiring official resolver-branded infrastructure, branded vault prerequisite evidence, ordered owners `[policy.passkey, policy.burner]`, and six-field guard config.
- Removes: `createRecoverySigner`.
- Preserves: `createBurnerSigner` and generic internal EIP-1193 exact typed-data implementation.

- [ ] **Step 1: Write failing TypeScript boundary tests**

Fixtures omit recovery. Public deployment config rejects unknown `recovery`. Topology verification rejects any third owner. No recovery signer factory exported. Classifier inputs cannot name/classify recovery-only target/path.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm run test:unit -- --grep "policy|signer|topology|deployment runbook" && npm run test:integration -- --grep "signer flow|setup integration|rehearsal"`

Expected: FAIL on required recovery fields, three-owner snapshots, recovery adapter exports.

- [ ] **Step 3: Implement two-owner TypeScript model**

Delete recovery field and adapter surface. Update canonical policy hashing and strict key validation. Require two distinct signers. Update topology reads and plan schemas. Convert fixtures/rehearsals to passkey plus Burner. Keep generic EIP-1193 helper private to Burner adapter unless later reviewed signer role consumes it.

- [ ] **Step 4: Amend baseline documents**

Record user-approved two-owner decision and deferred recovery in research baseline. Mark old three-owner plan sections superseded by this plan. Do not rewrite historical evidence. Update signer-provider note. State accepted lost-factor denial-of-service behavior.

- [ ] **Step 5: Run focused suites and verify GREEN**

Run: `npm run test:unit && npm run test:integration && git diff --check`

Expected: PASS. `rg -n "policy\.recovery|config\.recovery|createRecoverySigner|owners.*recovery" src scripts config deployments test contracts` returns no active recovery role.

- [ ] **Step 6: Commit**

Run: `git add src scripts config deployments test docs/research docs/security/signer-provider-evaluation.md docs/superpowers/plans/2026-09-16-personal-vault-security-core.md && git commit -m "refactor: align two-owner vault interfaces"`

---

### Task 3: Verify Infrastructure Evidence and Derive Circular Address Set

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `pnpm-lock.yaml`
- Modify: `yarn.lock`
- Modify: `src/config/deployment-validation.ts`
- Modify: `src/config/deployments.ts`
- Create: `src/topology/addressing.ts`
- Create: `src/topology/evidence.ts`
- Modify: `test/unit/config/deployments.test.ts`
- Create: `test/unit/topology/addressing.test.ts`
- Create: `test/unit/topology/evidence.test.ts`
- Modify: `docs/security/dependency-review.md`

**Interfaces:**
- Produces: `deriveComponentAddresses(input: { deployer: Address; startingNonce: bigint }): { setupHelper: Address; guard: Address; delay: Address; maintenance: Address }` using contiguous `CREATE` nonces `N`, `N+1`, `N+2`, `N+3`.
- Produces: `deriveSafeProxyAddress(input: { factory: Address; singleton: Address; proxyCreationCode: Hex; initializer: Hex; saltNonce: bigint }): Address` matching Safe 1.5 `createProxyWithNonce`.
- Produces: `VerifiedComponent = Readonly<{ name: "passkeySigner" | "setupHelper" | "guard" | "delay" | "maintenance"; address: Address; runtimeCodeHash: Hex; bindingHash: Hex; source: string }>` only after runtime and config reads match plan.
- Produces: branded `VerifiedDeploymentInfrastructure = Readonly<{ chainId: number; deployer: Address; observedDeployerNonce: bigint; safeSingleton: VerifiedDependency; safeProxyFactory: VerifiedDependency; passkeySignerFactory: VerifiedDependency; passkeySignerVerifier: VerifiedDependency; multiSendCallOnly: VerifiedDependency; passkeySigner: VerifiedComponent }>` from `resolveVerifiedDeploymentInfrastructure(client, input)`.
- Produces: `isVerifiedDeploymentInfrastructure(value): value is VerifiedDeploymentInfrastructure`. Brand stays module-private; config JSON cannot construct it.
- Defers: setup helper, guard, Delay, maintenance instance verification until Task 4, after their planned transactions succeed and immediately before Safe creation.

- [ ] **Step 1: Pin and document official deployment registry**

Add exact dependency `@safe-global/safe-deployments@1.37.63`. Replace unused `multiSend` registry role with `multiSendCallOnly`. For Safe 1.5 canonical Sepolia, assert address `0xA83c336B20401Af773B6219BA5027174338D1836` and code hash `0xcdbdcec38d2f1c7d961b0029ff8416b7e86e9974d6f0e9c9580c7d17fcfb6663` from pinned official asset. Record package integrity, source, license, release, review date.

- [ ] **Step 2: Write failing address and evidence tests**

Cover exact CREATE nonce derivation, Safe proxy CREATE2 derivation against real Safe 1.5 factory, negative/overflowing nonces, wrong initializer/singleton/factory/salt, unbranded infrastructure, absent code, code-hash mismatch, passkey signer address/binding mismatch, changed deployment sender nonce.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `npm run test:unit -- --grep "deployment|address derivation|vault evidence"`

Expected: FAIL because derivation and branded aggregate do not exist.

- [ ] **Step 4: Implement derivation and evidence verification**

Use viem address/CREATE2 primitives and verified factory `proxyCreationCode`. Keep brand module-private. Verify official infrastructure from pinned package plus live bytecode. Verify selected passkey signer instance from exact address, runtime hash, read-only binding. Do not claim not-yet-deployed guard, Delay, maintenance instances verified.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `npm run test:unit -- --grep "deployment|address derivation|vault evidence" && npm run verify:dependencies && git diff --check`

Expected: PASS locally. Sepolia verifier may stop with explicit evidence-absent result until public component deployments exist. Never partial success.

- [ ] **Step 6: Commit**

Run: `git add package.json package-lock.json pnpm-lock.yaml yarn.lock src/config src/topology test/unit docs/security/dependency-review.md && git commit -m "feat: verify deterministic vault deployment evidence"`

---

### Task 4: Build and Prove Atomic Safe Initialization Plan

**Files:**
- Create: `contracts/SafeAtomicSetupHelper.sol`
- Modify: `src/topology/build.ts`
- Create: `src/topology/multisend.ts`
- Modify: `scripts/plan-deployment.ts`
- Modify: `test/unit/topology/build.test.ts`
- Create: `test/unit/topology/multisend.test.ts`
- Create: `test/integration/atomic-setup-helper.test.ts`
- Modify: `test/integration/topology.test.ts`
- Modify: `test/integration/rehearsal.test.ts`
- Create: `docs/security/atomic-setup-helper-proposal.md`
- Modify: `docs/security/call-graph.md`

**Interfaces:**
- Produces: `SafeAtomicSetupHelper.setup(params)` as the single Safe setup delegatecall target. It configures asset policies, maintenance, Delay upstream module, transaction guard, module guard, and Safe Delay module with no arbitrary target list.
- Produces: `VaultPlanInput = Readonly<{ policy: VaultPolicy; deployer: Address; startingNonce: bigint; safeProxySaltNonce: bigint; setupHelperCreationCode: Hex; guardCreationCode: Hex; delayCreationCode: Hex; maintenanceCreationCode: Hex; deployments: VerifiedDeploymentInfrastructure }>` and `buildVaultPlan(input: VaultPlanInput): VaultDeploymentPlan`.
- Produces: `encodeCallOnlyBatch(calls: readonly UnsignedSetupCall[]): Hex`; rejects nonzero operation, malformed data, empty setup.
- Produces: ordered unsigned transactions for setup helper, guard, Delay, maintenance, then `SafeProxyFactory.createProxyWithNonce`, each with fixed sender nonce and expected created address.
- Produces: branded `VerifiedVaultPrerequisites = Readonly<{ setupHelper: VerifiedComponent; guard: VerifiedComponent; delay: VerifiedComponent; maintenance: VerifiedComponent }>` from `verifyVaultPrerequisites(client, plan)` only after all four deployments match planned addresses, runtime hashes, Safe/policy bindings.
- Produces: `assertSafeCreationReady(plan, prerequisites, observedDeployerNonce): void`; rejects other-plan evidence and any nonce other than `startingNonce + 4n` before Safe factory transaction submission.

- [x] **Step 1: Write failing deterministic-plan tests**

Assert byte-identical output for identical input; owners `[passkey,burner]`; threshold 1; zero fallback/payment; setup order `setAssetPolicy*`, `setMaintenance`, Delay `enableModule(Safe)`, `setGuard`, `setModuleGuard`, Safe `enableModule(Delay)`; all inner operations `CALL`; exact expected addresses/nonces. Add Review Focus tests for sender nonce drift and partial prerequisite deployment. Prove `assertSafeCreationReady` rejects zero, one, or two deployed prerequisites, mismatched plan, nonce drift.

- [x] **Step 2: Write failing real-Safe atomicity test**

Deploy prerequisites at planned nonces. Invoke planned Safe factory call. Assert created Safe immediately has two owners, both guards, only Delay, zero fallback, complete policy, maintenance, Delay bindings. Mutate each inner call to revert; assert proxy creation leaves no initialized Safe at predicted address.

- [x] **Step 3: Run focused tests and verify RED**

Run: `npm run test:unit -- --grep "buildVaultPlan|call-only batch" && npm run test:integration -- --grep "atomic two-owner topology"`

Expected: FAIL because production planning still throws fail-closed placeholder.

- [x] **Step 4: Implement production planner**

Replace placeholder with `SafeAtomicSetupHelper` setup calldata and structured unsigned plan. Re-read/compare deployment sender nonce at planner boundary. Require caller-supplied addresses match Task 3 derivation. Include decoded review records plus hashes. Include no signatures or broadcast flags. Verify deployed setup helper, guard, Delay, and maintenance after their transactions land. Require branded evidence and exact next sender nonce before exposing Safe creation transaction to submission script.

- [x] **Step 5: Run focused and topology suites and verify GREEN**

Run: `npm run test:unit -- --grep "buildVaultPlan|call-only batch" && npm run test:integration -- --grep "atomic two-owner topology|setup integration|rehearsal" && git diff --check`

Expected: PASS. No test-only draft encoder remains as alternate production path.

- [x] **Step 6: Commit**

Run: `git add src/topology scripts/plan-deployment.ts test docs/security/call-graph.md && git commit -m "feat: plan atomic two-owner safe deployment"`

---

### Task 5: Define Exact Submission Protocol and HTTPS Client

**Files:**
- Create: `src/transport/types.ts`
- Create: `src/transport/validate.ts`
- Create: `src/transport/https.ts`
- Create: `test/unit/transport/validate.test.ts`
- Create: `test/unit/transport/https.test.ts`

**Interfaces:**
- Produces: `SafeExecutionRequest = Readonly<{ version: 1; kind: "safe-execution"; idempotencyKey: Hex; chainId: number; deploymentsHash: Hex; policyHash: Hex; safe: Address; guard: Address; asset: Address; transaction: SafeTxMessage; safeTxHash: Hex; signatures: Hex; expectedSpend: AssetSpendState }>`
- Produces: `DelayExecutionRequest = Readonly<{ version: 1; kind: "delay-execution"; idempotencyKey: Hex; chainId: number; deploymentsHash: Hex; policyHash: Hex; safe: Address; guard: Address; delay: Address; queueNonce: bigint; queueFingerprint: Hex; to: Address; value: bigint; data: Hex; operation: 0; createdAt: bigint; cooldownSeconds: bigint; expirationSeconds: bigint }>` and `SubmissionRequest = SafeExecutionRequest | DelayExecutionRequest`.
- Produces: `SubmissionResult = { kind: "submitted"; requestHash: Hex; transactionHash: Hex } | { kind: "confirmed"; requestHash: Hex; transactionHash: Hex; blockNumber: bigint; blockHash: Hex } | { kind: "reverted" | "stale" | "unsupported-chain" | "rpc-inconsistent" | "transport-unavailable"; requestHash: Hex; reason: string }`.
- Produces: `SubmissionTransport = Readonly<{ submit(request: SubmissionRequest): Promise<SubmissionResult> }>`
- Produces: `snapshotSubmissionRequest(input: unknown): SubmissionRequest` and `createHttpsSubmissionTransport(options: Readonly<{ endpoint: URL; fetch: typeof globalThis.fetch; timeoutMs: number }>): SubmissionTransport`.

- [x] **Step 1: Write failing strict-schema tests**

Cover every field mutation/type mismatch, unknown/missing fields, noncanonical bigint/hex/address forms, malformed Safe signatures, mismatched transaction/fingerprint hashes, sensitive fields, both operation variants. Add Review Focus test rejecting one idempotency key reused for different canonical payload.

- [x] **Step 2: Write failing HTTPS boundary tests**

Reject HTTP, URL credentials, redirects, cross-origin response identity, unknown response fields, request/result hash mismatch, sensitive response fields, non-JSON bodies, oversized bodies. Verify timeout/network failures normalize to `transport-unavailable` without logging request/signature.

- [x] **Step 3: Run tests and verify RED**

Run: `npm run test:unit -- --grep "submission request|HTTPS submission"`

Expected: FAIL because `src/transport` does not exist.

- [x] **Step 4: Implement validation and HTTPS client**

Use strict exact-key validation and immutable snapshots. Inject `fetch` and in-memory idempotency registry. Add no server framework or persistence. Send one POST with canonical JSON and `redirect: "error"`. Expose no logger receiving request bodies.

- [x] **Step 5: Run tests and verify GREEN**

Run: `npm run test:unit -- --grep "submission request|HTTPS submission" && git diff --check`

Expected: PASS.

- [x] **Step 6: Commit**

Run: `git add src/transport test/unit/transport && git commit -m "feat: add exact HTTPS submission protocol"`

---

### Task 6: Revalidate Chain State and Broadcast Without Authority

**Files:**
- Create: `src/transport/relayer.ts`
- Create: `src/transport/calldata.ts`
- Create: `test/unit/transport/relayer.test.ts`
- Create: `test/integration/submission-transport.test.ts`
- Modify: `test/integration/delayed-tier.test.ts`

**Interfaces:**
- Produces: `validateAndBroadcast(request: SubmissionRequest, context: RelayerContext): Promise<SubmissionResult>`.
- `RelayerContext` contains `readers: Readonly<{ chainId(): Promise<number>; deployments(): Promise<VerifiedDeploymentInfrastructure>; topology(safe: Address): Promise<TopologyReport>; safeNonce(safe: Address): Promise<bigint>; policyHash(guard: Address): Promise<Hex>; spendState(guard: Address, asset: Address): Promise<AssetSpendState>; delayItem(delay: Address, nonce: bigint): Promise<QueueItem>; delayNonce(delay: Address): Promise<bigint>; blockTimestamp(): Promise<bigint>; receipt(hash: Hex): Promise<CanonicalReceipt | undefined> }>` and `broadcaster: Readonly<{ executeSafe(target: Address, exactCalldata: Hex): Promise<Hex>; executeDelay(target: Address, exactCalldata: Hex): Promise<Hex> }>`.
- Produces: `CanonicalReceipt = Readonly<{ transactionHash: Hex; blockNumber: bigint; blockHash: Hex; status: "success" | "reverted" }>`; reuse existing verified `QueueItem` shape from `src/monitoring/delay-events.ts`.
- Produces: canonical `encodeSafeExecutionCalldata(request)` and `encodeDelayExecutionCalldata(request)`; broadcaster receives only these bytes and target address.

- [x] **Step 1: Write failing read-before-broadcast tests**

Cover wrong chain, unverified deployment aggregate, topology failure, nonce drift, policy/counter drift, transaction-hash mismatch, signer mutation, queue nonce/tuple/cooldown/expiration/cancellation drift, broadcaster calldata mutation. Assert broadcaster call count zero for every rejection.

- [x] **Step 2: Write failing real Safe/Delay integration tests**

Submit passkey base transaction, passkey-plus-Burner step-up transaction, ready Delay tuple through relayer context. Assert exact balances/counters/queue transitions. Prove gas-paying account is not owner/module and cannot authorize transfer, queue, cancellation, freeze, repair.

- [x] **Step 3: Add timeout reconciliation test**

Simulate broadcaster timeout after accepting exact bytes. Require canonical receipt/nonce reconciliation to return `submitted` or `confirmed` for same outer hash. Never issue second broadcast with changed data.

- [x] **Step 4: Run focused tests and verify RED**

Run: `npm run test:unit -- --grep "relayer validation" && npm run test:integration -- --grep "submission transport"`

Expected: FAIL because relayer validator and calldata encoders do not exist.

- [x] **Step 5: Implement minimal relayer validation and broadcast**

Reuse `verifyTopology`, policy hashing, signer encoding, queue helpers. Do not duplicate policy classification. Perform reads at coherent observed block where client supports it. Recheck nonce/queue immediately before injected broadcaster call. Return only typed result union.

- [x] **Step 6: Run focused tests and verify GREEN**

Run: `npm run test:unit -- --grep "relayer validation" && npm run test:integration -- --grep "submission transport|delayed" && git diff --check`

Expected: PASS with exact broadcast calldata and zero relayer authority.

- [x] **Step 7: Commit**

Run: `git add src/transport test/unit/transport test/integration && git commit -m "feat: revalidate and relay authorized vault calls"`

---

### Task 7: Finish Documentation, Rehearsal Packaging, Security Gates

**Files:**
- Modify: `docs/security/call-graph.md`
- Modify: `docs/security/dependency-review.md`
- Modify: `docs/security/testnet-runbook.md`
- Modify: `docs/superpowers/plans/2026-09-16-personal-vault-security-core.md`
- Modify: `docs/superpowers/plans/2026-09-28-two-owner-atomic-deployment-transport.md`
- Modify: `config/sepolia.example.json`
- Modify: `deployments/sepolia.example.json`
- Modify: `scripts/rehearse.ts`
- Create: `scripts/package-sepolia-rehearsal.ts`
- Modify: `package.json`
- Modify: `test/unit/deployment/runbook.test.ts`
- Modify: `test/unit/security/rehearsal-inputs.test.ts`
- Modify: `test/integration/rehearsal.test.ts`

**Interfaces:**
- Produces: `npm run package:sepolia-rehearsal -- <public-config> <output-dir>` containing only unsigned plan, decoded review, public manifest, expected evidence hashes.
- Preserves: `npm run rehearse` as local Hardhat-only, secret-rejecting, non-broadcast proof.

- [x] **Step 1: Write failing rehearsal-package and documentation consistency tests**

Assert package contains no signatures, secrets, RPC URLs, private keys, Burner PINs, broadcast instruction. Assert owners exactly passkey/Burner. Assert hashes match canonical plan. Assert recovery fields rejected. Assert checked-in call graph, research amendment, plan checklist, runbook use same two-owner terms.

- [x] **Step 2: Run focused tests and verify RED**

Run: `npm run test:unit -- --grep "Sepolia deployment runbook|rehearsal input|two-owner documentation"`

Expected: FAIL because package command and aligned documents do not exist yet.

- [x] **Step 3: Implement packaging and finish security documentation**

Document prerequisite deployment, atomic setup, Safe submission, Delay execution, cancellation/freeze, signer repair, forbidden paths, lost-factor availability risk, future-recovery boundary. Mark only checks proven by committed automated evidence. Leave live low-value Sepolia rehearsal unchecked until human reviews and signs package.

- [x] **Step 4: Run complete repository gate**

Run: `npm run build && npm test && npm run test:invariant && npm run coverage && npm run slither && npm run rehearse && git diff --check`

Expected: all commands exit 0; 0 test failures; Slither has no unreviewed finding; local rehearsal reports Hardhat chain 31337, unsigned, non-broadcast.

- [x] **Step 5: Generate and inspect unsigned example package**

Run: `npm run package:sepolia-rehearsal -- config/sepolia.example.json /tmp/tiered-spending-guard-issue-5-rehearsal`

Expected: deterministic public artifacts only. Record human signing/live-Sepolia gate outstanding. Do not fabricate transaction hashes or mark issue #5 complete.

- [x] **Step 6: Commit**

Run: `git add docs config deployments scripts package.json test && git commit -m "docs: package two-owner testnet rehearsal"`

---

## Final Review and Pull Request

- [x] Build whole-branch review package from merge base through `HEAD`.
- [x] Request fresh whole-branch security review focused on Review Focus items, every ledger ruling, two-owner completeness, atomic setup, relayer non-authority.
- [x] Fix Critical/Important findings once. Each fix starts with failing test, ends green focused/full suites, commits separately.
- [x] Re-run complete repository gate and `git status --short`.
- [x] Push `codex/issue-5-atomic-deployment-transport` and open PR linked to #5. State live Sepolia rehearsal remains outstanding unless actually executed. Do not use `Closes #5` while gate open.
