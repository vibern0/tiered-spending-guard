# Client-only native Safe ERC-4337 design

**Date:** 2026-10-17

**Status:** Design direction accepted by the user on 2026-10-19. Source analysis, not implemented or proven compatible. [Execution plan](../plans/2026-10-19-native-safe-4337.md) awaits review; baseline and compatibility gates remain open.

**Baseline:** `dd635fe`; [research](../../research/2026-09-16-personal-vault-research.md), [security-core plan](../plans/2026-09-16-personal-vault-security-core.md), [signer evaluation](../../security/signer-provider-evaluation.md).

**Predecessors:** [client-only spec](2026-10-16-client-only-pimlico-design.md), [blocker proposal](2026-10-16-pimlico-blocker-resolution.md), [compatibility report](../../security/pimlico-compatibility.md).

## Decision

Select one final Safe 1.5, a restricted ERC-4337 fallback handler, sponsored gas, and user-triggered execution after Delay. No Coinbase account, auxiliary wallet, user EOA, application deployment/relay key, WalletConnect, session key or new spending module.

Correct the earlier atomic-factory sketch: **validation creates only a locked Safe; execution deploys its supporting contracts and activates the protected topology.** Both phases can occur in the first sponsored UserOperation. If execution fails, the Safe may remain deployed and locked. Component creation, configuration and activation revert together. This is an explicit `ready or locked` guarantee, not a claim that the entire EntryPoint transaction rolls back the account deployment.

Use Safe's existing shared WebAuthn signer only during locked bootstrap, with its credential configuration in Safe-owned storage. Activation replaces that owner with the credential-specific primary signer for the **same public key**. The handler never becomes an owner or a general ERC-1271 message validator.

This is a selected architecture for investigation. Custom-contract review, measured validation, provider acceptance and the prior ordinary-Safe live gate still precede implementation/release approval. None is marked passed by this document.

## Why this approach

| Approach | Result |
| --- | --- |
| Stock Safe4337Module, possibly from a different bundler | Reject: module execution and inherited message validation do not preserve the present guard boundary. Changing providers does not change those contracts. |
| Native handler; locked Safe in validation; activation in execution | **Select:** ordinary owner guard for transfers; Delay-only module; one account; no custom passkey verification algorithm. Requires a narrow new handler/bootstrap exception and gas/trace proof. |
| Provider broadcasts a complete deployment outside ERC-4337 validation | Reserve alternative if the selected bootstrap cannot fit canonical validation. Requires an actual browser-callable, bounded provider deployment service; no such service is established here. |

Deploying all prerequisites in `initCode` is rejected as the default. Constructors and initializers write guard/Delay/maintenance storage outside the sender. Factory stake does not generally authorize arbitrary child storage writes. Large creation artifacts also cannot be placed in the operation. [ERC-7562](https://eips.ethereum.org/EIPS/eip-7562) distinguishes validation from execution and limits packed operation size to 8,192 bytes and verification gas below 500,000. Source inspection alone does not show the minimal Safe bootstrap fits that budget.

The inspected [Alto parser](https://github.com/pimlicolabs/alto/blob/482c08bb660989bac211cd426d5c6300fd502358/src/rpc/validation/TracerResultParserV07.ts) also imposes concrete creation/storage checks. Its behavior must be pinned and tested; staking, a permissive local node or a different mempool cannot stand in for selected-provider acceptance.

Read-only inspection of existing compiled baseline artifacts measured guard creation/runtime at 15,884/15,187 bytes, setup helper at 3,906/3,879, and maintenance at 5,961/5,567. These were not rebuilt or verified against the proposed profile. Even before Delay or signers, their combined creation artifacts are 25,751 bytes. At the reference 200-gas-per-runtime-byte deposit rate, the guard alone costs 3,037,400 gas to deposit, excluding constructor work. This gives a concrete reason to move creation out of validation and keep code in separate anchors; it is not a gas estimate for the proposed locked Safe. [Reference EVM constants](https://github.com/ethereum/go-ethereum/blob/master/params/protocol_params.go).

## Scope and security contract

- One Safe holds assets. Primary passkey remains the sole owner at threshold 1, including the same credential through the bootstrap owner transition. Contract secondary is guard-only.
- Final `TieredSpendingGuard` occupies both guard slots. Delay is the only enabled module; the Safe is its owner, avatar, target and only proposer.
- Keep X, shared Y, per-token/per-transaction bounds, exact SafeTx approval, cancellable Z, delayed weakening and mandatory independent non-authorizing monitoring.
- Use primary plus a distinct reviewed contract/passkey secondary. The no-EOA profile must explicitly support an absent, disabled ECDSA secondary. No dummy EOA or inaccessible sentinel credential.
- Instant paths remain native/selected ERC-20 transfers only. No batches, approvals, Permit/Permit2, arbitrary messages or unknown calldata. The bootstrap's one fixed delegatecall is initialization-only and is unavailable after activation.
- Manual Execute requires the primary online for its sponsored outer operation. The already-approved queue item does not require a fresh secondary signature. Delay's public execution remains permissionless; autonomous execution and guaranteed factor-independent sponsored transport are deferred.
- Client-only means the browser prepares, signs and submits directly to providers. Bundlers/paymasters and independent monitoring remain external services. Infrastructure funding is still required; sponsorship does not mean deployment is free.

## Profile and public infrastructure

Select EntryPoint **0.8.0** as the candidate protocol, commit `4cbc06072cdc19fd60f285c5997f4f7f57a588de`, candidate canonical address `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108`. Reject 7702 initialization, signature aggregators and alternative nonce keys. Do not silently fall back to legacy 0.6, the stock module's SafeOp digest or an alternate mempool. [Official release](https://github.com/eth-infinitism/account-abstraction/releases/tag/v0.8.0).

Retain existing Safe 1.5.0, passkey 0.2.0 and reviewed Delay 1.1.1 source pins as candidates. This proposal adds no dependency or compiler change. Source/audit correspondence and runtime verification are separate gates, especially for the previously unused shared signer and the entire composition.

Shared, predeployed infrastructure comprises:

1. Pinned Safe singleton/proxy factory, passkey shared signer/factory/verifier and Delay implementation.
2. New immutable restricted handler, locked-bootstrap factory/setup helper and fixed activation helper.
3. Immutable creation-code anchors for components whose creation artifacts cannot fit together in one deployer's runtime or one UserOperation. Each anchor is data, with no authority or asset custody.

A third-party infrastructure provider/operator must fund and publish the new shared contracts before users can onboard. This is not permission to introduce an app-owned EOA under an “operator” label. The wallet does not obtain a broadcaster key or require an application backend. No such deployment service or funding arrangement is established here, and no new contract here has a verified deployment address or audit. Do not substitute an arbitrary unverified address to make the browser work.

The factory accepts only the pinned EntryPoint SenderCreator for the AA deployment route. It forwards a fixed, manifest-derived Safe initializer to the existing proxy factory, creating only the final Safe during validation. Initialization writes only Safe-owned slots; public infrastructure must be stateless/immutable on this path. A final trace decides whether factory staking is necessary for any remaining read, not a blanket assumption.

## Bootstrap manifest and address derivation

Define a versioned canonical `BootstrapManifest` containing chain, deployment/profile IDs, user salt, both distinct P-256 public keys and verifier bindings, asset/recipient policies, X/Y/per-transaction bounds, period anchor, Z/expiry, sponsor restrictions and the exact approved infrastructure/code hashes. Its commitment is stored in a reserved Safe storage namespace separate from Safe and maintenance slots.

The manifest contains inputs and template identities, **not** a self-referential final Safe address/component-address list. Derivation order is:

```text
manifest + fixed locked initializer + salt -> Safe address
Safe + template hashes + manifest -> Delay address
Safe + Delay + primary/profile -> guard address
Safe + Delay + maintenance template -> maintenance address
credential coordinates + pinned signer factory -> per-key signer addresses
derived components + policy -> exact activation SafeTx and hash
```

Derive all addresses locally before approval. Store the manifest commitment, not an activation hash that itself changes the Safe initializer/address. The bootstrap guard recomputes the expected activation from the committed manifest and actual Safe. Reject a caller-supplied claimed address/hash that differs from this derivation. The manifest must also exclude final policy hashes containing the derived Safe and all assertion/signature bytes. “Exact activation” means the nonce-0 SafeTx fields and hash; canonical signature envelopes are checked separately. Fresh WebAuthn assertions may differ without changing that transaction.

Creation templates live in pinned immutable anchors, copied and hash-checked by the activation helper; constructor arguments are typed and derived from the manifest. Components are created with deterministic Safe-context CREATE2 during the activation delegatecall. Deploy/initialize Delay first, then guard and maintenance, then configure their links. `GuardReplacementMaintenance` can use its existing zero `expectedSelf` constructor form, which binds `address(this)` without a circular self-address constructor input.

Use inert anchor runtime `STOP || creationTemplate`; copy only the bytes after STOP, with exact length and template hash checks. Anchors contain no dispatch/administration or mutable dependency. Keep each anchor/helper runtime within a conservative 24,576-byte bound and each constructor initcode within 49,152 bytes, even if a selected network permits more. Rebuild and measure the proposed artifacts; baseline sizes are not final artifact guarantees.

Each template, appended initcode and deployed runtime must fit the chain's limits; the activation helper must also fit runtime limits. Component reuse is allowed only after exact runtime, constructor, ownership and configuration checks. An incompatible existing instance fails closed. No arbitrary runtime or raw constructor program comes from the browser.

## State machine and first operation

| State | Allowed behavior | Failure / next state |
| --- | --- | --- |
| Absent | Approved factory creates the final locked Safe. | Validation failure reverts deployment; successful validation may persist it. |
| Locked | Threshold 1; shared primary signer configured for the committed key; restricted handler is fallback and both guards; zero modules. Only exact manifest-bound activation is permitted. | Reverted activation leaves this state. No transfers, owner changes, messages, arbitrary delegatecall or module route. |
| Activating | An execution-local phase/lock while the exact activation runs. | Any failed creation, signature, call, false return or invariant reverts the execution frame. |
| Active | Per-key primary sole owner; final guard in both slots; Delay-only module; bootstrap sealed; restricted handler remains fallback. | Return to locked/activation is forbidden. Later repairs use existing delayed maintenance. |

Locked Safe setup delegatecalls a fixed helper to configure the shared signer and reserved bootstrap commitment, set both guards and install the restricted fallback. The shared signer [stores x/y/verifier data in the Safe and reads it with `getStorageAt`](https://github.com/safe-fndn/safe-modules/blob/14a2a1ef7c9b4f872668213d7c7fc4345563e1fd/modules/passkey/contracts/4337/SafeWebAuthnSharedSigner.sol). It does not require a per-user signer deployment during validation. Unknown callback/message selectors remain closed.

The first sponsored operation then performs:

1. **Validation:** authenticate the outer primary assertion through the shared owner; inspect only canonical transport structure and permitted Safe-owned state. No guard counters, token balances or Delay state.
2. **Execution:** deploy or verify both credential-specific signer contracts through the pinned existing factory. This occurs before the ordinary Safe transaction checks contract signatures.
3. Submit the exact nonce-0 activation SafeTx to `Safe.execTransaction`. Primary signs that SafeTx through the shared owner; bootstrap guard independently verifies the committed secondary's real contract signature over the same hash. Outer approval never substitutes for either inner approval.
4. Its fixed activation-helper delegatecall deploys/configures components, swaps the shared owner for the same-key credential-specific primary, installs both final guards, enables only Delay, verifies all policy/topology bindings and seals bootstrap. No asset movement is included.
5. Safe's **captured old bootstrap guard** receives the after-hook even though the guard slot changed. It must require success and verify the final topology, owner/key continuity, policy commitment and sealed phase. Failure reverts the execution frame. The handler also bubbles a false `execTransaction` result.

The activation entry point cannot be an externally callable initialization shortcut. It requires the Safe delegatecall context, exact locked profile/manifest and the authenticated activation state established by the bootstrap guard. Concretely, the pre-hook sets a per-Safe pending activation digest/nonce in handler storage, during execution only. The helper requires that pending record before setting Safe phase to activating. The old after-hook verifies the matching record and final invariants, then clears it. Nested activation or a mismatched/missing after-hook fails. Account validation never reads/writes this handler mapping. This context check, guard handoff and storage namespace are explicit review targets.

A retry reconciles code, phase, receipts and both nonce domains first. If the locked Safe already exists, use empty initCode, current EntryPoint nonce and Safe nonce 0; obtain a fresh sponsor quote and outer assertion. The inner nonce-0 activation is reusable only while all committed transaction fields remain identical; its assertions can be renewed. No arbitrary bootstrap repair or manifest replacement is available.

Public precreation of the identical Safe or credential signer can invalidate a pending factory operation, but must not change authority. Reverify exact code/manifest and rebuild the outer operation. Do not treat an RPC timeout as permission to issue a different deployment.

## Native account protocol

Proposed interfaces only; no product contract is added:

```solidity
validateUserOp(PackedUserOperation userOp, bytes32 userOpHash,
               uint256 missingAccountFunds) returns (uint256 validationData)
executeUserOp(PackedUserOperation userOp, bytes32 userOpHash)

NativeCall {
  mode: BOOTSTRAP | OWNER_TRANSACTION | READY_DELAY,
  validAfter: uint48, validUntil: uint48,
  profileId: bytes32, expectedGuard: address,
  primary: { x: uint256, y: uint256, verifiers: uint176 },
  safeNonce: uint256, body: bytes
}
```

`callData = IAccountExecute.executeUserOp.selector || abi.encode(NativeCall)`. The pinned [EntryPoint substitutes the full operation and hash at execution](https://github.com/eth-infinitism/account-abstraction/blob/4cbc06072cdc19fd60f285c5997f4f7f57a588de/contracts/core/EntryPoint.sol). The handler parses the tagged envelope inside `userOp.callData`; it does not confuse this with the ABI for the full execution function. This avoids storing an outer authorization ticket between validation and execution.

For both account methods require `msg.sender == userOp.sender`, zero value, exact installed handler/profile and the real appended original caller equal to the pinned EntryPoint. [Safe appends the original caller to fallback calldata](https://github.com/safe-fndn/safe-smart-account/blob/v1.5.0/contracts/base/FallbackManager.sol). Strip exactly that suffix, enforce canonical ABI, and reject forged/double suffixes, extra trailing bytes, offset aliasing and direct handler impersonation.

Expose no general execute adapter. Reject both Safe ERC-1271 selectors, message helpers, batches, arbitrary module execution, deposits/withdrawals, simulation callbacks and unknown selectors through fallback. Bootstrap guard hooks are authenticated direct Safe-to-guard methods, not generally available fallback capabilities. Do not inherit CompatibilityFallbackHandler or ExtensibleFallbackHandler.

For bootstrap guard methods, `onlySafe` by itself is insufficient: an attacker can call a guard selector on the Safe and have fallback forward it with the Safe as `msg.sender`. Genuine Safe guard hooks have exact canonical ABI **without** an appended caller suffix. Require that form, the expected activation digest/nonce and correct pre-/after-hook sequence; reject the suffixed fallback form before any pending lock write. Conversely, account validate/execute methods require the real suffix. Test forged hooks both before activation and during signer/factory reentrancy. Interface-introspection support required for guard installation must be narrow and must grant no execution capability.

### Validation

- Require finite signed validity, profile limits, key-0 EntryPoint nonce and appropriate locked/active mode. Validity lives in callData and is therefore signed; return the packed window without reading the clock.
- Require a complete 0.8 paymaster header, exact approved nonzero paymaster and bounded gas/fees. Reject `missingAccountFunds != 0`, empty sponsorship, token payment, vault prefund and refunds. Nonzero existing EntryPoint deposits do not excuse an absent paymaster.
- Validate exactly one canonical `v=0` primary contract signature with Safe `checkNSignatures(address(0), userOpHash, signature, 1)`. Reject ECDSA, approved-hash shortcuts, secondary extensions and extra outer signatures.
- In locked state the current sole owner is the configured shared signer, and the public primary descriptor matches its committed Safe-owned configuration. In active state read the current sole owner and threshold from Safe storage; require its address to equal the pinned factory's deterministic `getSigner(x,y,verifiers)` derivation for the signed public descriptor and approved verifier profile, then validate that owner's contract signature. The pinned factory derivation uses immutable code/parameters, with no mutable registry read; it can be reproduced locally. Exact credential runtime/constructor/factory binding is additionally enforced during activation and every delayed owner rotation. Do not obtain that binding from guard storage during AA validation, and never compare a rotated active owner to the historical bootstrap key. Bootstrap metadata is inactive after sealing. [Pinned signer factory](https://github.com/safe-fndn/safe-modules/blob/14a2a1ef7c9b4f872668213d7c7fc4345563e1fd/modules/passkey/contracts/SafeWebAuthnSignerFactory.sol).
- Trust the hash supplied by the authenticated pinned EntryPoint; browser hashing independently uses the exact 0.8 EIP-712 algorithm. Never call `EntryPoint.getUserOpHash` during validation. No separate stock-module SafeOp is used.
- Do not execute spending policy, consume X/Y, set a pending guard lock or read guard/Delay/token state here. All those checks remain in execution. Mutable external credential registries are also excluded.

Current rules recognize P256VERIFY, but the inspected Alto collector has a narrower precompile allowlist. Therefore do not assume the working onchain `0x100` precompile proves bundler acceptance. Trace the exact configured verifier; a Solidity verifier fallback can increase the bootstrap gas enough to matter. Required proof covers factory creation **plus** account validation under the selected limit. No disabled tracing mode is acceptable evidence.

### Ordinary owner operations

```text
EntryPoint -> Safe fallback -> restricted handler
          -> Safe.execTransaction(exact inner SafeTx + signatures)
          -> TieredSpendingGuard owner hooks -> allowed action
```

Owner body includes the full SafeTx and canonical inner primary/secondary signatures. Recompute its ordinary SafeTx hash and check the expected Safe nonce at execution. Require zero `safeTxGas`, gas price/refund payment and refund receiver according to the existing guard's strict profile. The handler calls ordinary Safe execution and reverts if it returns false.

The guard remains the authority for transfer classification, exact secondary authorization, X/Y accounting, cancellation/freeze and delayed maintenance. It runs once. The handler is not an enabled module, so this path creates no outer module hook and needs no nested-guard exception.

### Manual ready Delay execution

Queue submission is itself a sponsored onchain transaction through the ordinary guarded owner path. Delay emits the full proposed action in `TransactionAdded` and stores its hash and creation timestamp. Anyone can inspect that record. Z starts at the onchain queue timestamp, not when the browser collects signatures. Assets remain in the Safe until a separate ready-execution transaction succeeds.

```text
EntryPoint -> Safe fallback -> restricted handler
          -> configured Delay.executeNextTx(exact queued tuple)
          -> Safe.execTransactionFromModule
          -> TieredSpendingGuard module hooks -> approved queued action
```

Ready body binds Delay address, queue nonce, destination, value, data and operation. At execution verify the current guard/Delay binding and exact next queue fingerprint. Call only that Delay selector, forwarding zero ETH. Delay enforces Z/expiry/order; the module guard enforces the approved action. A changed, cancelled, premature or expired item fails.

Do **not** wrap Delay execution in a Safe owner transaction: that would enter the owner guard before the module guard and recreate the nesting conflict. Do not read queue readiness or block time during validation. Display a pending/failed operation accurately if queue state changes after simulation.

## Signing, sponsorship and reconciliation

Inner SafeTx signatures bind the existing chain/Safe/action/gas/nonce domain. The outer primary signs the final canonical 0.8 userOpHash, covering sender, EntryPoint/chain domain, nonce, initCode, complete tagged callData, sponsor data, gas and fees. Delay fingerprints are a third domain. They are never interchangeable.

Build inner approvals first, estimate with a conservative fixed-size outer-signature stub, obtain final sponsor fields, then obtain the outer primary assertion. A sponsor/gas/callData change after that requires a new outer assertion. If signature encoding changes preVerificationGas enough, repeat finalization explicitly. Never mutate a signed operation silently.

The browser persists public manifests, plan hashes and operation IDs only. Keys remain in authenticators. The UI distinguishes absent, locked, submitting, uncertain and active states. An outer transaction receipt alone is insufficient: reconcile EntryPoint success, inner Safe/guard events, final topology and policy, balances/queue state and reorg/confirmation status. Do not show an active wallet or suggest funding before read-only topology verification passes.

Monitoring observes all owner/module/bootstrap paths and connects userOpHash to the bundler transaction, SafeTx hash and queue fingerprint. It requires an independent closed-browser alert test. Monitoring has no submission or signing authority.

## Provider evidence and selected route

Read-only probes on 2026-10-17 used no credentials and submitted no UserOperation:

Raw public capability responses are retained in [provider evidence](../../evidence/2026-10-17-native-safe-provider-capabilities.json).

| Endpoint | Observed capability | Limit |
| --- | --- | --- |
| `https://public.pimlico.io/v2/11155111/rpc` | Bundler reports EntryPoints 0.6/0.7/0.8/0.9; paymaster capability reports 0.6/0.7/0.8. Responses included `Access-Control-Allow-Origin: *`. | No native profile sponsorship, browser preflight, validation trace or inclusion evidence. Earlier public sponsorship request lacked the required policy. |
| `https://api.candide.dev/public/v3/11155111` | Bundler and paymaster report 0.6/0.7/0.8/0.9; same CORS response header. | Earlier quote was for a different account/profile. It proves neither custom Safe acceptance nor funding of this expensive activation. |

Select Pimlico's 0.8 bundler as the first compatibility target. Test Candide's public testnet paymaster first for keyless sponsorship; if it declines the custom profile, provision an explicit bounded sponsor policy with Pimlico or Candide. Provider mixing is conditional on actual paymaster/deposit/trace acceptance, not assumed interoperability. [Candide RPC](https://docs.candide.dev/wallet/paymaster/rpc-methods/) describes public and private policies; documented support is not a native-profile quote.

Any browser-distributed identifier is public. Sponsor admission must enforce profile/factory/handler, inner operation scope, per-Safe and total budgets, rate and fee/gas limits, expiry and abuse resistance. CORS/origin is not authorization. A required private server secret would fail the client-only selection; do not build a hidden proxy. Neither provider gets a Safe role or spend authority.

The onchain approved paymaster set is immutable per reviewed handler/profile deployment. Dashboard policy changes cannot expand it. A sponsor/profile change requires an enumerated Delay-only maintenance operation that verifies old/new handler runtime/profile identities, preserves owner/guard/Delay topology and sealed phase, and atomically updates the fallback and Safe-owned active profile. Add this operation explicitly to delayed maintenance classification and adversarial tests; the current helper does not implement it. No operator setter or immediate fallback swap. If all pinned sponsors refuse service, sponsored wallet operation is unavailable until a supported delayed transition can execute; the MVP makes no unconditional liveness promise or hidden EOA fallback.

Primary/secondary repair in this profile must enforce the approved factory-derived passkey class, runtime and verifier binding **onchain**. The current maintenance helper's general ERC-1271 proof is insufficient for that new restriction: an arbitrary stateful or permissive ERC-1271 signer could otherwise enter through repair and break canonical AA admission or the passkey-only profile. No caller-supplied `verified` flag is accepted. Rebind maintenance's approved guard runtime hash to the reproducible changed guard artifact; do not retain the old hash while claiming the new profile is accepted.

The expensive component creation moves into `callGasLimit`, where provider/chain limits still apply. Acceptance requires a quote for the real maximum supported activation, successful validation and inclusion. Earlier Coinbase gas measurements are excluded from this native profile's proof.

## Required policy amendments before code

This proposal requests narrowly scoped amendments; it does not enact them:

1. Permit a restricted handler, locked bootstrap factory/helper and immutable artifact anchors as new security-critical infrastructure beyond the current guard/helper exception. No generic module or message authority.
2. Permit the initialization-only shared-signer owner, same-key owner swap and exactly bound activation delegatecall. Preserve the credential-specific primary and guard-only secondary in the active topology.
3. Permit an EOA-free profile: enabled contract secondary, ECDSA secondary absent/disabled throughout constructor, configuration, rotation, maintenance, encoding and verification. No implicit re-enabling during repair.
4. Replace the zero-fallback invariant with exact restricted-handler identity and selector/caller invariants, including the enumerated Delay-only handler/profile maintenance path. Pin approved paymasters without introducing an instant sponsor-administration escape or resetting sealed bootstrap state.
5. Replace `apps/backend` as the browser write boundary only after equivalent browser encoding/binding, provider abuse controls, receipt reconciliation and closed-browser monitoring are proven.
6. Record manual primary-authorized sponsored Execute as the MVP availability scope. Keep public Delay execution; factor-independent sponsored transport and autonomous relayers remain later work.

The ordinary-Safe live gate and active backend boundary remain in force. A separate explicit revision must resolve their sequencing before ERC-4337 code; read-only investigation and this proposal do not complete that gate.

## Rejection-first proof gates

Each row needs retained exact versions, source/runtime hashes, commands, traces and pass/fail evidence. A source argument is not an executed test.

| Gate | Required proof / stop condition |
| --- | --- |
| Baseline | Complete the outstanding ordinary-Safe live X/Y/Z, cancellation, repair and independent alert matrix; resolve approved sequencing. |
| Locked deployment | Real Safe/shared signer; only sender storage and one sender creation in validation; both bootstrap guards; no modules. Attempt native/ERC-20 outflow, arbitrary owner/configuration calls and both ERC-1271 selectors before activation. |
| Canonical admission | Pinned standards-enforcing 0.8 bundler and real selected provider: combined validation gas, packed operation size, all storage/code/opcode/precompile accesses. Measure maximum supported manifest/assertions. No unsafe mode. |
| Bootstrap authentication | Missing/wrong primary or secondary, wrong key/verifier, manifest/code hash, salt, chain, helper, policy or constructor byte fails. Verify both inner approvals and distinct outer approval. |
| Atomic activation | Inject failure after each signer/component creation, configuration, owner swap and guard swap. All execution-stage state rolls back; locked Safe remains; no spend path opens. Verify old after-hook checks final topology. |
| Retry and races | Account precreation, matching signer precreation, incompatible runtime, sponsor expiry, timeout, dropped/replaced operation and execution revert. Reconcile EntryPoint versus Safe nonce; seal forbids activation replay. |
| Guarded operations | Base/step-up/queue/cancel/freeze/expiry/maintenance through native transport with real cryptography; primary-only cannot substitute for secondary; X/Y update once and roll back on failure. |
| Manual Execute | Ready succeeds with outer primary only; early/cancelled/expired/wrong tuple/order fails. Only Delay module hook runs. Public Delay execution remains possible independently. |
| Caller/digest isolation | Mutate real/synthetic suffixes, ABI offsets/trailing bytes, sender, chain, EntryPoint, profile, sponsor, fees, every SafeTx field, each nonce and every signature. Reject fallback-spoofed bootstrap hooks before any lock write; genuine direct hooks must work. Reject other nonce keys/7702/aggregators. |
| Gas isolation | Reject absent/wrong sponsor, nonzero missing funds, prefund, refund, token charge and malformed sponsor data. Confirm vault ETH/ERC-20 funds never pay gas on successful or failed operations. |
| Rotation/control | Delayed primary repair updates active AA validation through current Safe owner; old key fails. ECDSA stays absent; handler/factory/profile changes cannot weaken policy immediately. |
| Provider/browser | Real CORS preflight and browser requests; native bootstrap and every supported mode sponsored/included; enforced budgets, rate/fee ceilings, expiry and abuse tests. No private browser credential. |
| Monitoring | Independent alerts with browser closed; userOp/SafeTx/queue linkage, failures and reorgs; no authorizing key. |

Each implementation change adding a path must update the call-graph and adversarial tests in the same change. Each security dependency change must update dependency review. Keep signer evaluation, topology verifiers, monitoring/runbook, live evidence and implementation-plan checkboxes current throughout the work. Independent review and professional audit remain required before production consideration.

## Present disposition

The original module/message/nesting conflicts have concrete architectural replacements. Canonical bootstrap admission and native-profile sponsorship remain **unmeasured**, rather than declared impossible or passed. If the minimized locked deployment exceeds the selected gas/trace limits, reject this exact profile and return to the provider-broadcast deployment alternative or a separately reviewed optimization; do not silently weaken signatures, guards or mempool checks.

This proposal changes no active contract, dependency, authorization rule or backend behavior. It is the concrete artifact to review before an implementation plan and contract probes.
