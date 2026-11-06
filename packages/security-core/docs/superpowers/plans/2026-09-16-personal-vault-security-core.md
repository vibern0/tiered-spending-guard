# Single-Safe Tiered Spending Security Core Implementation Plan

> **2026-11-06 local multi-user amendment:** The [approved multi-user design](../specs/2026-11-06-multiple-vault-accounts-design.md) scopes automatic provisioning and exact recovery per account, adds persistent public credential/session metadata, and replaces the blanket recovered-secondary readiness gate with first-passkey login plus exact action-specific second approval. One asset-holding Safe remains required per account; X/Y/Z, deployment verification, and all live/audit gates remain unchanged.


> **2026-11-04 similar-project status note:** Safe Research Policy Engine is a closely related project and possible future comparison or migration candidate. Upstream now records scoped Certora audits for the engine/guard and most listed policies; older statements below that it is wholly unaudited are superseded. Upstream `main` continued changing after the audit snapshots, the reports do not cover this project's X/Y/Z composition, and the Policy Engine remains prior art only. This note does not authorize compiling, deploying, or trusting it, and it does not alter the approved `TieredSpendingGuard` plus Zodiac Delay architecture.

> **2026-10-09 supersession:** The [approved live-validation plan](2026-10-09-guard-live-validation.md) replaces the three-owner baseline with one primary-passkey owner and guard-only contract/ECDSA secondaries. Older owner-count and paired secondary/owner rotation requirements below are historical. Live and ERC-4337 gates remain unchecked until evidenced.

> **2026-11-01 local Phase One provisioning amendment:** The [approved automatic-provisioning design](../specs/2026-11-01-phase-one-automated-pwa-provisioning-design.md) supersedes this plan's per-wallet human package-approval step only for the loopback `BACKEND_PROFILE=local` Ethereum Sepolia PWA flow. After the second passkey, the backend writes the unsigned review package, applies the committed gas/fee/outlay policy through the `ProvisioningAuthorizer` seam, executes seven transactions serially with six confirmations and canonical runtime checks, and returns only after final topology verification. The backend-local authorizer is consistency/cost bounding, not independent approval; KMS or an independently administered policy service remains required to mitigate backend compromise. Non-local, non-Sepolia, recovery, ordinary rehearsal, and production gates are unchanged.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and prove a testnet-only Safe security core where one Safe permits primary-passkey-only spending up to daily X, requires one configured secondary signer up to shared daily Y, and requires a cancellable delay Z above Y.

**Architecture:** One Safe holds all assets and has the primary passkey signer contract plus the configured secondary signer contracts/accounts as Safe owners at Safe threshold 1. In the active Option B prototype those owners are primary passkey, safe-contract secondary, and ECDSA secondary. A new non-upgradeable `TieredSpendingGuard` is installed as both transaction guard and module guard; it enforces the effective signer requirements, per-token X/Y counters, fail-closed call policy, emergency restrictions, and delayed configuration. A reviewed Zodiac Delay is the Safe's only enabled module and executes only transactions that were queued through a guard-approved Safe transaction.

> **2026-10-01 supersession:** The secondary-signer design supersedes this plan's recovery-owner topology and the later Burner-specific transport boundary for current code, tests, deployment examples, and verification. The active Option B interface uses exactly three Safe owners: primary passkey, safe-contract secondary, and ECDSA secondary. The guard requires the primary plus exactly one enabled configured secondary for step-up transfers, delayed proposals, cancellation/freeze, and delayed maintenance. The offline recovery owner, recovery signer adapter, and recovery-only classifier/topology paths are deferred. Loss of the primary or all configured secondary factors is an accepted testnet denial-of-service risk until a separate reviewed recovery design exists. Do not use older recovery-owner or Burner-specific sections below as implementation requirements.

> **2026-10-01 Task 5 package gate:** The Sepolia runbook and rehearsal package now follow the active Option B primary-plus-secondary boundary. `npm run package:sepolia-rehearsal` emits only public unsigned artifacts for human review: unsigned plan, decoded review, public manifest, and expected evidence hashes. The live low-value Sepolia rehearsal remains outstanding until separately reviewed, signed, executed, and recorded; this branch does not mark issue #5 complete. Direct Burner NFC/libhalo remains out of scope until a separate spike proves documented HaLo signing for the exact Safe transaction.

**Tech Stack:** Solidity, TypeScript, Node.js, Hardhat, viem, Safe Smart Account 1.5.x, Safe passkey contracts, current `@gnosis-guild/zodiac` Delay deployments, OpenZeppelin signature utilities where reviewed, Mocha/Chai, Slither, Echidna or Foundry invariant tests, and a Sepolia fork.

**Spec:** `docs/research/2026-09-16-personal-vault-research.md`

## Global constraints

- This is security research and a testnet prototype, not a mainnet-ready wallet.
- The product deploys exactly one Safe; no Daily, Step-up, Control, or other auxiliary Safe is introduced.
- The active Safe owners are exactly the configured primary passkey signer contract, safe-contract secondary, and ECDSA secondary. The Safe threshold is 1, while the guard enforces the stronger tier-specific signer policy.
- The guard must be installed as both transaction guard and Safe 1.5 module guard in the same atomic setup.
- Zodiac Delay is the only module enabled on the Safe. The Safe is Delay's owner, avatar, target, and only enabled upstream module/proposer.
- X and Y are cumulative per-token limits over one shared 86,400-second period with one anchor and `0 < X < Y`.
- A base transfer consumes X and Y; a step-up transfer consumes Y only. Transaction ordering or splitting must never allow more than X passkey-only or Y total immediate outflow.
- Base transfers require the Safe-validated signature to be exactly the configured primary passkey contract signature.
- Step-up transfers and ordinary delayed proposals require the primary passkey signature plus one configured secondary signer approval over the exact Safe transaction hash.
- Recovery may cancel, freeze, or queue an enumerated repair. Recovery may not immediately transfer funds or broaden policy.
- Fast execution supports native transfers and selected ERC-20 `transfer` calls only. It denies delegate calls, batches, approvals, Permit/Permit2, arbitrary messages, configuration calls, and unknown calldata.
- The Safe has no unrestricted fallback handler. Approved-hash signatures and arbitrary Safe ERC-1271 message validation are unavailable to spending paths.
- Security-weakening changes execute only from the verified Delay module after Z. Immediate changes must be mechanically monotonic tightening.
- Every authorization binds chain, Safe, destination, value, calldata, operation, gas/refund fields, and nonce.
- Pin exact dependencies and record source commits, audits, canonical addresses, and runtime bytecode hashes.
- Study Safe Research Policy Engine at one pinned commit as similar-project prior art; do not deploy it or treat its scoped component audits as an audit of this dependency choice or composition.
- Stop and write a focused design proposal if the accepted properties require another custom security-critical contract beyond `TieredSpendingGuard` and internal libraries.

---

## File structure

```text
AGENTS.md
docs/research/2026-09-16-personal-vault-research.md
docs/security/call-graph.md
docs/security/dependency-review.md
docs/security/policy-engine-lessons.md
docs/security/signer-provider-evaluation.md
docs/security/testnet-runbook.md
docs/superpowers/plans/2026-09-16-personal-vault-security-core.md
legacy/contracts/                              Preserved 2024 experiment
legacy/test/
contracts/TieredSpendingGuard.sol              Transaction guard, module guard, counters, recovery
contracts/libraries/SafeSignatureDecoder.sol   Internal canonical Safe signature parsing
contracts/libraries/PolicyDigest.sol           Exact co-signature and queue digest construction
contracts/test/ERC20Mock.sol
src/config/policy.ts                            Typed X/Y/Z policy model
src/config/deployments.ts                       Safe, passkey, and Delay allowlist verification
src/policy/classify.ts                          Advisory base/step-up/delayed/blocked classifier
src/topology/build.ts                           Deterministic one-Safe atomic setup plan
src/topology/verify.ts                          Read-only deployed invariant verifier
src/queue/delay.ts                              Queue, cancel, expire, and execute builders
src/signers/types.ts                            Provider-neutral Safe signer boundary
src/signers/passkey.ts                          Safe passkey adapter
src/signers/eip1193.ts                          Generic EIP-1193 ECDSA secondary adapter
src/monitoring/guard-events.ts                  Step-up authorization event decoder
src/monitoring/delay-events.ts                  Delayed lifecycle decoder
src/monitoring/notifier.ts                      Non-authorizing notification port
scripts/plan-deployment.ts
scripts/verify-dependencies.ts
scripts/verify-deployment.ts
scripts/watch-activity.ts
scripts/rehearse.ts
test/unit/
test/integration/
test/invariant/
test/fixtures/
```

## Requirement coverage

| Requirement | Proof tasks |
|---|---|
| One Safe holds assets | 5, 7, 10, 11 |
| Passkey-only spending bounded by X | 2, 5, 10 |
| Combined immediate spending bounded by Y | 2, 5, 10 |
| One configured secondary signer required above X | 4, 5, 8, 10 |
| Mandatory cancellable delay above Y | 6, 10, 11 |
| Owner and module paths both constrained | 4, 6, 7, 10 |
| Recovery cannot immediately withdraw | 6, 10, 11 |
| Tier-2 and tier-3 notifications | 9, 10, 11 |
| Delayed weakening and immediate tightening | 6, 7, 10 |
| No approval/message/fallback bypass | 4, 5, 7, 10 |

---

### Task 1: Preserve the historical prototype and establish reproducible dependencies

**Files:**
- Move: `contracts/RecentTransactionGuard.sol` → `legacy/contracts/RecentTransactionGuard.sol`
- Move: `contracts/GnosisSafeMock.sol` → `legacy/contracts/GnosisSafeMock.sol`
- Move: `test/RecentTransactionGuard.ts` → `legacy/test/RecentTransactionGuard.ts`
- Move: `contracts/ERC20Mock.sol` → `contracts/test/ERC20Mock.sol`
- Create: `legacy/README.md`
- Create: `docs/security/dependency-review.md`
- Modify: `package.json`
- Modify: `hardhat.config.ts`
- Create: `package-lock.json`

**Interfaces:** Produces the exact dependency allowlist and a clean active build used by every later task.

- [ ] **Step 1: Record the current tree and registry evidence**

Run `git status --short` and query exact Safe, Safe passkey, Zodiac, viem, and OpenZeppelin package versions plus registry integrity hashes. Record the pinned Safe Research Policy Engine commit reviewed as prior art.

- [ ] **Step 2: Quarantine the old implementation**

Use `git mv`. State in `legacy/README.md` that the old guard has disabled authorization, no transaction binding, no limits, no queue, and a permissive mock; exclude `legacy/` from compilation.

- [ ] **Step 3: Replace deprecated dependencies**

Remove `@gnosis.pm/safe-contracts`; install reviewed exact versions with `--save-exact`. Add `build`, `test`, `test:unit`, `test:integration`, `test:invariant`, `check`, `coverage`, `slither`, `plan:deployment`, `verify:dependencies`, `verify:deployment`, `watch:activity`, and `rehearse` scripts.

- [ ] **Step 4: Write the dependency review**

For every deployed or compiled security dependency, record version, integrity, tag/commit, audit link, supported chain, canonical address source, runtime code hash, review date, and rejected vulnerable versions. Record the Policy Engine as similar-project prior art with audit scope mapped to exact commits, not as a deployment dependency.

- [ ] **Step 5: Verify and commit**

Run `npm ci`, `npm run build`, `npm test`, and `git diff --check`. Commit as `chore: establish single-safe security baseline`.

---

### Task 2: Define the X/Y/Z policy and advisory classifier

**Files:**
- Create: `src/config/policy.ts`
- Create: `src/policy/classify.ts`
- Create: `test/unit/policy/classify.test.ts`

**Interfaces:**

```ts
export type AssetPolicy = Readonly<{
  token: Address;
  basePerTransaction: bigint;
  stepUpPerTransaction: bigint;
  baseDailyLimit: bigint;
  instantDailyLimit: bigint;
  recipients: readonly Address[];
}>;

export type VaultPolicy = Readonly<{
  chainId: number;
  safe: Address;
  primary: Address;
  secondaries: readonly ConfiguredSigner[];
  delay: Address;
  periodSeconds: 86400;
  periodAnchor: bigint;
  cooldownSeconds: number;
  expirationSeconds: number;
  assets: readonly AssetPolicy[];
}>;

export type AssetSpendState = Readonly<{
  window: bigint;
  baseSpent: bigint;
  instantSpent: bigint;
}>;

export type Lane = "base" | "step-up" | "delayed" | "blocked";
```

- [ ] **Step 1: Write failing table tests**

Cover repeated transfers below X, exact X, X+1, exact Y, Y+1, a transfer crossing X, step-up before X, base after step-up, both per-transaction caps, aligned reset, native/ERC-20 decoding, unknown token/recipient, approvals, Permit2, batches, delegate calls, malformed calldata, Safe configuration, and recovery calls.

- [ ] **Step 2: Prove the tests fail**

Run `npm run test:unit -- --grep "classifyAction"`; expect the missing classifier failure.

- [ ] **Step 3: Implement fail-closed classification**

Return `base` only when both remaining X and Y permit the transfer, `step-up` when Y permits it, `delayed` for a recognized transfer above Y or enumerated weakening/recovery action, and `blocked` otherwise. Reject `X <= 0`, `Y <= X`, misaligned periods, duplicate signers, or invalid caps.

- [ ] **Step 4: Verify and commit**

Run the classifier tests and `git diff --check`. Commit as `feat: define single-safe tiered policy`.

---

### Task 3: Verify Safe, passkey, Delay, and Policy Engine assumptions

**Files:**
- Create: `docs/security/policy-engine-lessons.md`
- Create: `src/config/deployments.ts`
- Create: `scripts/verify-dependencies.ts`
- Create: `test/unit/config/deployments.test.ts`

**Interfaces:** Produces `resolveVerifiedDeployments(client, chainId): Promise<VerifiedDeployments>` for Safe singleton/factory, passkey signer factory/verifier, MultiSend, and Delay.

- [ ] **Step 1: Write rejection-first deployment tests**

Reject unsupported chains, zero code, mismatched hashes, unknown releases, known-vulnerable Delay versions, and any Safe release lacking module guards.

- [ ] **Step 2: Record exact upstream lessons**

At the pinned Policy Engine commit, review `SafePolicyGuard`, `CoSignerPolicy`, `IncreasedThresholdPolicy`, `SignatureExtension`, and stateful-policy tests. Document dual guard installation, untrusted context, exact digest verification, `safeTxGas == 0`, `gasPrice == 0`, failed-module rollback, reentrancy gating, namespaced state, exact audit scope, and later security-relevant fixes. Do not copy code without recording license and provenance.

- [ ] **Step 3: Verify exact Safe interfaces**

Record the Safe 1.5 transaction-guard and module-guard ABIs, call order, nonce timing, signature encoding, after-execution behavior, fallback-handler behavior, and Delay proposer/execution ABI. Confirm by tests against compiled upstream contracts rather than memory or old articles.

- [ ] **Step 4: Implement read-only bytecode verification**

Resolve addresses through official deployment registries, fetch runtime bytecode, hash it, compare to the committed allowlist, and fail closed on every missing or inconsistent read.

- [ ] **Step 5: Verify and commit**

Run unit tests and the Sepolia read-only verifier. Commit as `docs: verify single-safe security dependencies`.

---

### Task 4: Implement exact signer and transaction binding in the guard

**Files:**
- Create: `contracts/TieredSpendingGuard.sol`
- Create: `contracts/libraries/SafeSignatureDecoder.sol`
- Create: `contracts/libraries/PolicyDigest.sol`
- Create: `test/unit/guard/signatures.test.ts`
- Create: `test/integration/guard-signatures.test.ts`

**Interfaces:**

```solidity
enum AuthorizationTier { Base, StepUp, DelayedProposal, Emergency }

struct GuardConfig {
    address safe;
    address primary;
    address safeContractSecondary;
    address ecdsaSecondary;
    address delay;
    uint64 periodSeconds;
    uint64 periodAnchor;
}

function checkTransaction(
    address to,
    uint256 value,
    bytes calldata data,
    Enum.Operation operation,
    uint256 safeTxGas,
    uint256 baseGas,
    uint256 gasPrice,
    address gasToken,
    address payable refundReceiver,
    bytes calldata signatures,
    address executor
) external;
```

- [x] **Step 1: Write failing exact-hash tests**

Compare the guard's reconstructed hash with Safe `getTransactionHash`. Changing chain, Safe, target, value, calldata, operation, any gas/refund field, or nonce must change the digest. Account for Safe incrementing its nonce before the guard callback.

- [x] **Step 2: Write failing signature tests**

Require a validated `v == 0` contract-signature slot naming the configured primary passkey for all transfer paths. Reject approved-hash `v == 1`, raw EOA substitution, malformed offsets, duplicate/trailing ambiguity, wrong primary, and signatures not validated by Safe.

- [x] **Step 3: Define and test the ECDSA secondary extension**

Use a typed terminal envelope `[secondarySignature][uint256 length][bytes32 typeHash]` for the ECDSA secondary. Verify the configured ECDSA secondary with `SignatureChecker` over the exact Safe transaction hash. Reject missing, malformed, wrong-signer, wrong-chain, wrong-Safe, wrong-nonce, replayed, and user-rejected signatures.

- [x] **Step 4: Implement atomic guard mechanics**

Implement both guard interfaces, only-Safe entry checks, a reentrancy gate, `safeTxGas == 0`, `gasPrice == 0`, and after-execution reverts on failed owner or module execution. State writes during a failed inner call must roll back.

- [x] **Step 5: Verify against a real Safe and commit**

Run unit and integration tests with Safe 1.5, not the legacy mock. Commit as `feat: bind tiered policy to exact safe signatures`.

---

### Task 5: Implement base and step-up spending enforcement

**Files:**
- Modify: `contracts/TieredSpendingGuard.sol`
- Create: `test/unit/guard/spending.test.ts`
- Create: `test/integration/guard-spending.test.ts`
- Create: `test/invariant/spending.invariant.ts`

**Interfaces:** The guard exposes read-only `assetPolicy(token)`, `spendState(token)`, and emits `TransferAuthorized(tier, token, recipient, amount, baseSpent, instantSpent, window)`.

- [ ] **Step 1: Write failing decoding and policy tests**

Allow only native transfers with empty calldata and ERC-20 `transfer(address,uint256)`. Test exact token, recipient, per-transaction cap, `CALL` operation, and zero unknown trailing calldata. Reject approvals, Permit/Permit2, fallback calls, batches, delegate calls, and unknown selectors.

- [ ] **Step 2: Write failing X/Y accounting tests**

Use X=100 and Y=1,000. Prove repeated primary-passkey transfers total at most 100; crossing X requires one configured secondary signer; all immediate ordering and splitting totals at most 1,000; base consumes X and Y; step-up consumes Y only; failed transfers consume nothing; both counters reset on the same anchored daily boundary.

- [ ] **Step 3: Implement minimal tier accounting**

Compute the window from the immutable 86,400-second period and anchor. Update counters before execution, emit only after checks, and rely on the enforced revert behavior from Task 4 for atomic rollback.

- [ ] **Step 4: Add stateful invariants**

Generate arbitrary sequences of base attempts, step-up attempts, failures, boundary timestamps, tokens, and recipients. Assert `baseSpent <= X`, `instantSpent <= Y`, no unauthorized balance movement, and no counter decrease inside a window.

- [ ] **Step 5: Verify and commit**

Run unit, real-Safe integration, and invariant suites. Commit as `feat: enforce daily primary and secondary tiers`.

---

### Task 6: Integrate Delay, cancellation, tightening, and recovery

**Files:**
- Modify: `contracts/TieredSpendingGuard.sol`
- Create: `src/queue/delay.ts`
- Create: `test/unit/queue/delay.test.ts`
- Create: `test/integration/delayed-tier.test.ts`
- Modify: `docs/security/call-graph.md`

**Interfaces:** Produces Zodiac-compatible `queueFingerprint`, a separate Safe/Delay/queue-nonce monitoring fingerprint, queue/cancellation/execution builders, and paired hash/creation-time queue-item reads.

- [x] **Step 1: Write delayed-proposal tests**

A direct transfer above remaining Y must fail. A Safe call to the exact Delay queue selector succeeds only with the primary passkey plus one configured secondary signer and only when the decoded inner action is an allowed transfer or enumerated weakening action. Mutation of inner target, value, calldata, operation, nonce, cooldown, or expiration fails.

- [x] **Step 2: Write module-path tests**

Only the verified Delay address may call the Safe module path. Execution before Z, after expiration, after cancellation, through another module, or by delegate call fails. An exact queued transfer succeeds after Z through an unprivileged relayer.

- [x] **Step 3: Implement cancellation and emergency rules**

Permit only the primary passkey plus one configured secondary signer to call the configured Delay's nonce-advance cancellation or guard freeze functions immediately. Enumerate every ordered queue item invalidated by cancellation. Deny recovery transfers and arbitrary queue creation.

- [x] **Step 4: Implement delayed recovery and configuration**

Allow delayed maintenance to queue only fixed signer replacement, guard repair, and policy repair selectors. Limit increases, recipient additions, delay reductions, owner/module/guard/fallback changes, and unfreezing require Delay. Immediate tightening functions must prove limits only decrease, recipients only disappear, or the system only becomes more restrictive.

- [x] **Step 5: Prove removal and fallback safety**

Test atomic delayed replacement of both guard slots, no intermediate unguarded execution, no unlisted module, no unrestricted fallback handler, no direct `signMessage`, and rejection of approved-hash authorization. If Safe cannot replace both guards atomically without a broader delayed batch, stop for a focused maintenance design.

- [x] **Step 6: Verify and commit**

Run queue, module, recovery, and configuration integration tests. Commit as `feat: add cancellable delayed vault tier`.

---

### Task 7: Build and verify the deterministic one-Safe topology

**Files:**
- Create: `src/topology/build.ts`
- Create: `src/topology/verify.ts`
- Create: `test/unit/topology/build.test.ts`
- Create: `test/unit/topology/verify.test.ts`
- Create: `test/integration/topology.test.ts`
- Create: `scripts/plan-deployment.ts`
- Create: `scripts/verify-deployment.ts`
- Create: `docs/security/call-graph.md`

**Interfaces:** `buildVaultPlan(input)` accepts only official resolver output and fails closed until a reviewed concrete atomic setup path exists; deterministic draft calldata is isolated to `test/fixtures/topology-draft.ts` and requires exact verified evidence. `verifyTopology(input): Promise<TopologyReport>` requires official resolver-branded infrastructure plus branded vault prerequisite evidence before any topology report or RPC read, then re-reads every invariant.

- [x] **Step 1: Write deterministic plan snapshots**

Assert one Safe address, owners `[primary passkey, safe-contract secondary, ECDSA secondary]`, threshold 1, zero fallback handler, the same guard in both guard slots, Delay as the only Safe module, Safe as Delay owner/avatar/target/only enabled upstream module, exact policy hash, and no extra account deployment.

- [x] **Step 2: Implement atomic planning**

Generate the Safe initializer, proxy-factory deployment call, and unsigned calls for policy, both guards, and the module graph. Require a reviewed atomic encoder; if none exists, fail closed rather than emit a partially protected final state. Never broadcast from the planner.

- [x] **Step 3: Implement fail-closed verification**

Verify Safe singleton/version, owners, threshold, fallback, guards, modules, guard code hash/config/counters, Delay code hash/owner/avatar/target/members/cooldown/expiration, and absence of unexpected approvals recorded by the runbook.

- [x] **Step 4: Write the complete call graph**

Document base, step-up, queue, Delay execution, cancellation, freeze, recovery, configuration, replacement, and forbidden paths with caller, signer requirement, value capability, and timing.

- [x] **Step 5: Verify and commit**

Run deterministic planning twice for byte-identical output, assert fail-closed behavior where the local harness cannot prove the production atomic path, verify the topology fixture, mutate each invariant individually, and require failure. Commit the corrected implementation with a conventional message.

---

### Task 8: Add primary passkey and secondary signer adapters

**Files:**
- Create: `src/signers/types.ts`
- Create: `src/signers/passkey.ts`
- Create: `src/signers/eip1193.ts`
- Create: `test/unit/signers/passkey.test.ts`
- Create: `test/unit/signers/eip1193.test.ts`
- Create: `test/integration/signer-flow.test.ts`
- Modify: `docs/security/signer-provider-evaluation.md`

**Interfaces:** A role-neutral `VaultSigner` returns a signature bound to `{chainId, safe, safeTxHash, typedData}`; the safe-contract secondary returns a Safe-contract signature and the EIP-1193 secondary adapter returns the exact ECDSA guard extension.

- [x] **Step 1: Write provider-neutral conformance tests**

Reject chain, Safe, hash, account, or typed-data changes; invalid ERC-1271 response; wrong recovered EOA; duplicate signature; provider account/chain change; user rejection; and extension ambiguity.

- [x] **Step 2: Implement Safe-native passkey signing**

Use the reviewed Safe passkey contracts and verify the configured signer contract identity. Produce the canonical contract signature expected by Safe and the guard.

- [x] **Step 3: Implement configured secondary adapters**

Use Safe-native passkey signing for the safe-contract secondary and `eth_signTypedData_v4` through a reviewed non-WalletConnect boundary for the ECDSA secondary. Verify recovered addresses locally. Do not invoke undocumented NFC/libhalo commands or bypass provider confirmation/PIN behavior.

- [x] **Step 4: Prove the complete signer matrix**

The primary passkey succeeds only for base. Secondary-only and recovery-only transfers fail. Primary plus a configured secondary succeeds within Y and queues above Y. Recovery succeeds only for cancellation, freeze, and enumerated delayed repair if a future reviewed recovery design adds that role.

- [x] **Step 5: Verify and commit**

Run signer unit tests and real-Safe integration tests. Commit as `feat: add tiered safe signer adapters`.

---

### Task 9: Monitor step-up and delayed activity

**Files:**
- Create: `src/monitoring/guard-events.ts`
- Create: `src/monitoring/delay-events.ts`
- Create: `src/monitoring/notifier.ts`
- Create: `scripts/watch-activity.ts`
- Create: `test/unit/monitoring/guard-events.test.ts`
- Create: `test/unit/monitoring/delay-events.test.ts`
- Create: `test/unit/monitoring/notifier.test.ts`

**Interfaces:** `ActivityAlert` is a union of confirmed `step-up-executed`, `delayed-queued`, `delayed-cancelled`, `delayed-executed`, and derived `delayed-expired` records. The notifier has no signer or RPC write capability.

- [x] **Step 1: Write event decoding tests**

Verify chain/log identity, confirmation depth, cursor persistence, reorg removal, restart replay, idempotency, exact guard/Delay addresses, decoded asset/recipient/amount, X/Y state, queue fingerprint, and lifecycle transition.

- [x] **Step 2: Implement verified monitoring**

For step-up events, re-read guard counters and transaction input before notification; do not notify for base events. For Delay events, re-read the queue item and state before notification.

- [x] **Step 3: Implement stdout and webhook notifiers**

Send only public data. Store no private key, passkey assertion, PIN, wallet session, cancellation credential, or method capable of authorizing a transaction.

- [x] **Step 4: Verify and commit**

Run monitoring tests including suppressed, duplicate, malformed, and reorged events. Commit as `feat: monitor tiered vault activity`.

---

### Task 10: Prove the threat model end to end

**Files:**
- Create: `test/integration/adversarial.test.ts`
- Create: `test/integration/recovery.test.ts`
- Create: `test/invariant/call-graph.invariant.ts`
- Create: `scripts/rehearse.ts`
- Create: `slither.config.json`
- Modify: `package.json`
- Modify: `docs/security/call-graph.md`

**Interfaces:** Produces `npm run security:check` as the reproducible local security gate.

- [x] **Step 1: Add one test per bypass class**

Test split X/Y spending, counter rollback, period boundaries, wrong signer combinations, signature replay/mutation, approved hashes, arbitrary messages, fallback installation, approvals, batches, delegate calls, extra modules, explicit removal or one-slot mutation of either guard, direct Delay injection, immediate weakening, retained unsafe owners, cancelled/expired execution, and notification-service authority.

- [x] **Step 2: Add recovery and denial-of-service tests**

Test lost primary passkey, unavailable secondary factors, cancellation of a valid delayed ERC-20 transfer with pre/post cooldown and unchanged balances, requeue and actual execution, immediate freeze, delayed signer rotation, delayed guard repair, ordered collateral cancellation, and inability of any recovery placeholder to move assets before Z. Document unavoidable guard-bricking risks.

- [x] **Step 3: Add static and invariant gates**

Run coverage, Slither, and stateful invariants. Require executable ABI/state-surface checks for every repository security contract plus review of every external/public function, storage write, call, signature parse, and authorization branch. Slither uses a committed reviewed baseline and fails on new findings or tool errors; imported Safe/Zodiac analysis is not presented as their audit.

- [x] **Step 4: Implement the rehearsal**

On the actual local Hardhat time-controlled network: verify the reported chain identity, deploy one Safe, spend repeatedly through X, step up through Y, reject Y+1 direct, queue Y+1, prove queue/cancellation evidence, cancel, prove non-execution and unchanged balances, queue again, advance Z, execute, expire another item, freeze, and rehearse delayed recovery repair. Refuse chain ID 1 and reject credential/provider/broadcast environments without forwarding them.

- [x] **Step 5: Verify and commit**

Run `npm run security:check`, the complete integration suite, rehearsal, and `git diff --check`. Commit as `test: prove single-safe tiered threat model`.

---

### Task 11: Produce and execute the Sepolia runbook

**Files:**
- Create: `docs/security/testnet-runbook.md`
- Create: `deployments/sepolia.example.json`
- Create: `config/sepolia.example.json`
- Modify: `scripts/plan-deployment.ts`
- Modify: `scripts/verify-deployment.ts`

**Interfaces:** Produces an unsigned reproducible deployment plan, verified public manifest, and testnet evidence bundle with no secrets.

- [x] **Step 1: Write explicit stop conditions**

Stop on any owner, threshold, fallback, guard slot, Safe module, Delay upstream module, bytecode hash, signer identity, X/Y counter, period anchor, cooldown, expiration, queue fingerprint, or notification mismatch.

- [x] **Step 2: Define the public manifest**

Include chain, Safe, guard, Delay, dependency hashes, policy hash, setup transaction hashes, and verification report hash. Exclude seeds, passkey material, PINs, provider tokens, and private RPC credentials.

- [x] **Step 3: Generate and human-review the unsigned plan**

Run the planner for Sepolia and compare every decoded setup call with the call graph before signing.

- [ ] **Step 4: Execute the low-value rehearsal**

Exercise base, both supported step-up secondary forms, queue, tier-2/tier-3 alerts, cancellation, expiry, delayed execution, freeze, lost-factor availability, signer rotation, and teardown using deliberately low-value test assets.

- [ ] **Step 5: Hold the architecture gate and commit**

Fail the gate if any security property depends only on UI classification, monitoring, relayer honesty, or operator discipline. Commit the runbook and redacted examples as `docs: add single-safe testnet runbook`.

The live Sepolia rehearsal and architecture gate were not completed in this worktree; no live evidence bundle was collected, so this task remains open.

---

## Completion criteria

- Exactly one Safe holds assets; no auxiliary Safe is deployed.
- Both Safe guard slots point to the reviewed `TieredSpendingGuard`.
- Delay is the only module enabled on the Safe, and the Safe is Delay's only enabled upstream module/proposer.
- The Safe has the exact owners, threshold 1, and no unrestricted fallback handler.
- Passkey-only daily outflow is bounded onchain by X per token.
- Combined immediate daily outflow is bounded onchain by Y per token regardless of ordering or splitting.
- One configured secondary signer is required above X and its approval is bound to the exact Safe transaction.
- Transfers above Y cannot execute before delay Z and can be cancelled.
- Recovery cannot immediately transfer funds or weaken policy.
- Failed owner and module executions cannot consume counters or authorizations.
- Direct owner calls, extra modules, approvals, arbitrary messages, approved hashes, batches, and delegate calls cannot bypass policy.
- Weakening, signer rotation, guard replacement, and module changes are delayed; immediate changes are provably tightening only.
- Tier-2 executions and the tier-3 lifecycle are independently monitored without authorization capability.
- Real Safe/Delay integration, invariant, static-analysis, and rehearsal gates pass.
- The repository makes no production-readiness or audit claim.

## Follow-on plans

After this plan passes, write separate plans for the consumer wallet UI, external review and audit remediation, carefully decoded DeFi actions, additional chains, and a deliberately capped production pilot.
