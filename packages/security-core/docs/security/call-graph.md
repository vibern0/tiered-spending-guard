# Security-core call graph

This document records the primary-owner/guard-secondary topology and execution paths. The repository remains a testnet security prototype; the planner is unsigned and the verifier must pass before funds are deposited.

## Topology authority

One asset-holding Safe has exactly one owner: the configured primary passkey, with threshold 1 and no fallback handler. Contract and ECDSA secondary signers are guard-only identities; the guard verifies their exact-transaction approvals independently. The same TieredSpendingGuard occupies both Safe transaction-guard and module-guard slots. Zodiac Delay is the only Safe module. Delay has the Safe as owner, avatar, and target, and the Safe is its only upstream module. No second Safe, recovery signer, module, or custody account is created.

The primary contract-signature slot must come first, including when a contract secondary has a numerically lower address. Only that first slot authorizes Safe execution. The guard revalidates the primary via Safe and the secondary via ERC-1271 over the identical Safe transaction hash. ECDSA approvals retain the exact-hash terminal envelope. Primary rotation swaps the sole owner and guard identity atomically through Delay; secondary rotation never changes Safe ownership. ERC-4337 remains gated on live ordinary-path evidence and a restricted-fallback design review.

`buildVaultPlan` never signs, broadcasts, invents registry addresses, or accepts unverified infrastructure evidence. It requires a resolver-branded deployment infrastructure object, the exact observed deployer nonce, expected runtime code hashes for the four prerequisites, Safe proxy creation code, the deterministic four-prerequisite CREATE sequence, and a policy Delay address that matches that sequence. The selected atomic path uses `SafeAtomicSetupHelper` as the one Safe setup delegatecall target; the helper is stateless and derives the final Safe as `address(this)` so the initializer does not embed the Safe address. The production plan derives the Safe proxy address from the Safe factory, singleton, proxy creation code, initializer, and salt, and rejects a policy Safe that differs. The production plan emits unsigned transactions only: setup helper, guard, Delay, maintenance, then Safe proxy factory creation.

Before the Safe factory transaction is ready for submission, `verifyVaultPrerequisites` must re-read all four planned prerequisite deployments at their deterministic addresses, compare live runtime hashes with the expected planned hashes, brand their evidence, and confirm guard, Delay, and maintenance bindings against the same plan. `assertSafeCreationReady` then rejects unbranded evidence, evidence from another plan, and any deployer nonce other than `startingNonce + 4`. `scripts/plan-deployment.ts` remains the public snapshot/runbook planner and fails closed if asked to emit atomic Safe creation without the `buildVaultPlan` prerequisite evidence flow. `verifyTopology` first requires the runtime brand returned by the official resolver, then re-reads proxy bytecode/singleton/version, Safe graph, guard policy/configuration/counters/asset enumeration/recipients, and Delay settings; structurally fabricated deployment objects fail before any topology check or RPC read.

## Task 7 setup sequence

1. Resolve verified deployment infrastructure and compare every runtime hash from RPC; absent evidence is a hard stop.
2. Plan and deploy setup helper, guard, Delay, and maintenance instances at the four contiguous deployer nonces, then verify their runtime/binding evidence at stage `before-setup` and require the deployer nonce to equal `startingNonce + 4`. The prerequisite runner stops here.
3. In a separate reviewed stage, re-estimate the exact Proxy Factory call with `setup([primary passkey], 1, setupHelper, setupData, 0, 0, 0, 0)`. Require explicit gas, fee, balance, and aggregate outlay caps before signing. The repository has no live Safe-creation executor until this gate is implemented and reviewed.
4. In the helper's fixed Safe-originated sequence, configure every asset, configure the safe-contract secondary before guard installation, set maintenance, install the same guard in both guard slots, enable Delay as the only Safe module, and enable the Safe as Delay's only upstream module. Delay owner/avatar/target are the Safe.
5. Re-run prerequisite verification at stage `after-setup`, then `verifyTopology`; do not fund until it passes. Pre-setup evidence cannot certify the installed vault. Verify the maintenance runtime and its Safe/Delay bindings as well as the guard's maintenance address.

## Instant owner path

`Safe.execTransaction` → transaction guard `TieredSpendingGuard.checkTransaction` → exact Safe signature and policy check → Safe target call → `checkAfterExecution`.

The offchain signer path is provider-neutral: the passkey adapter accepts only the resolver-branded aggregate returned by the official deployment-verification boundary, selects its factory-bound `passkeySigner` instance record, pins provider chain identity before and after signing, and emits canonical Safe contract-signature slots only after an `eth_call` to the exact Safe-native passkey/ERC-1271 verifier identity. A caller cannot substitute `evidence: "verified"` or an arbitrary runtime hash because cloned/unbranded aggregates fail at the signer boundary. The same Safe-contract signer format is used for the configured primary passkey and the safe-contract secondary when each role is selected. The EIP-1193 secondary adapter uses `eth_signTypedData_v4` only after checking the configured chain/account and recovers the exact SafeTx locally. Every request must use the canonical SafeTx domain keys, `SAFE_TX_TYPES`, `primaryType`, and message fields before any provider call. The ECDSA secondary extension is terminal and versioned; secondary-only EOA output is never sufficient because the guard first requires the configured primary passkey contract-signature slot. Step-up, delayed proposal, cancellation/freeze, and delayed maintenance paths require the primary plus exactly one configured secondary signer: either the safe-contract secondary signature or the ECDSA secondary extension.

Only native transfers and selected ERC-20 `transfer` calls are admitted. The guard rejects delegate calls, batches, approvals, Permit/Permit2, arbitrary messages, unknown calldata, and non-passkey transfer signatures. Failed execution rolls back the counter update.

## Delayed proposal and execution

`Safe.execTransaction` → transaction guard → `Delay.execTransactionFromModule(to,value,data,operation)` with the exact single queued tuple → Delay queue.

After cooldown and before expiration, an unprivileged relayer calls pinned Zodiac Delay v1.1.1 `executeNextTx(to,value,data,operation)` → Safe `execTransactionFromModule` → module guard `checkModuleTransaction` → exact native/ERC-20 transfer → `checkAfterModuleExecution`. The module guard admits only the configured Delay address and supported `CALL` transfer tuples; Delay owns cooldown, FIFO ordering, expiration, `skipExpired`, and nonce cancellation semantics.

## Cancellation and emergency freeze

The configured primary passkey plus exactly one configured secondary signer may submit the configured Delay `setTxNonce(uint256)` cancellation or the guard `freeze()` call. Queue builders expose the next nonce so callers can enumerate all ordered queue items invalidated by cancellation before signing.

Immediate `setAssetPolicy` is accepted only for an unset token or a numeric decrease/equal value with a recipient subset. Policy increases and recipient additions are rejected on the owner path. `repairPolicy(address,uint256,uint256,uint256,uint256,address[])` (`0xc4f605f4`) is admitted only as an exact `CALL` execution from the configured Delay after the primary plus exactly one configured secondary queued the action; policy invariants and exact ABI encoding are checked onchain. Direct queued `repairSigner(uint8,address,address)` (`0x28033279`) calls to the guard are denied; signer repair is available only through `GuardReplacementMaintenance.replaceSigner` so primary rotation updates the sole Safe owner and guard atomically, while secondary rotation updates only the guard. Role `2` and every other role value revert. A queued `repairPolicy` change becomes effective only through the verified Delay module after cooldown. Immediate Delay tightening uses `setTxCooldown(uint256)` (`0xebb2b4a2`) and `setTxExpiration(uint256)` (`0x9b56d5be`); `setAssetPolicy(address,uint256,uint256,uint256,uint256,address[])` is `0x7291b570`.

## Atomic dual-guard replacement

`Delay` -> Safe module execution with `DELEGATECALL` -> `GuardReplacementMaintenance.replaceGuards(address,address)` (`0x7ec60d4f`) or `replaceSigner(address,uint8,address,address,address,uint256,bytes)` (`0x2d72b26a`). `replaceGuards` accepts only deployed code whose runtime hash is the reviewed `TieredSpendingGuard` artifact hash `0x9321a6a896d85ec04efe82171b12f5f93c4e0c4ea9b34eb376b63ddbbb4ec070`; it also checks both guard slots and requires the replacement guard to preserve the current Safe, Delay, 24-hour period, primary passkey, safe-contract secondary, and ECDSA secondary bindings before installation.

The module guard permits this one target, selector, and operation only when the caller module is the configured Delay. In Safe storage, the maintenance code verifies both current guard slots, verifies both interfaces on the replacement, sets a reentrancy lock, and performs exactly two Safe self-calls: `setGuard` and `setModuleGuard`. Any failure reverts the complete operation. No arbitrary target list, calldata batch, or general delegatecall is exposed.

Signer repair updates guard configuration; only primary repair swaps the sole Safe owner atomically. Primary repair requires the sentinel predecessor; secondary repair requires zero predecessor. In both cases, the existing sole owner must match the guard primary and threshold must equal one; replacement guards receive the same maintenance authorization before the old guard can be removed. Both currently installed guard slots and the old guard's Safe, Delay, and role-signer configuration are checked before rotation. Role 0 rotates the primary passkey and requires deployed replacement code plus an ERC-1271 response over the exact domain-separated passkey-replacement proof hash. Role 1 rotates one configured secondary: the safe-contract secondary requires the same deployed-code/ERC-1271 replacement proof, while the ECDSA secondary requires empty replacement proof bytes. Role 2 reverts. All other module addresses, targets, selectors, and operations are denied by the module guard.

## Forbidden paths

Direct owner transfers, unlisted modules, a second enabled module, nonzero fallback handler, delegatecalls outside fixed maintenance, batches, approvals, Permit/Permit2, arbitrary messages, unknown calldata, unknown assets/recipients, malformed Delay calls, nonzero Safe gas/refunds, approved-hash authorization, and any missing or inconsistent verification read are rejected. Monitoring and relaying can observe or execute an already-delay-approved item, but neither is an authorizer.

## Repository security-contract ABI inventory

The following is the complete ABI surface of the repository security contracts. Every entry is classified by mutability and authorization role; imported Safe/Zodiac ABIs are out of scope for this inventory.

| Surface | Classification |
| --- | --- |
| `TieredSpendingGuard.ECDSA_SECONDARY_SIGNATURE_TYPE_HASH` | view constant |
| `TieredSpendingGuard.allowedRecipient` | view state |
| `TieredSpendingGuard.assetPolicy` | view state |
| `TieredSpendingGuard.ecdsaSecondaryAuthorizationUsed` | view state |
| `TieredSpendingGuard.ecdsaSecondary` | view state |
| `TieredSpendingGuard.checkAfterExecution` | state-changing, Safe-only callback |
| `TieredSpendingGuard.checkAfterModuleExecution` | state-changing, Safe-only callback |
| `TieredSpendingGuard.checkModuleTransaction` | state-changing, Safe-only callback |
| `TieredSpendingGuard.checkTransaction` | state-changing, Safe-only callback |
| `TieredSpendingGuard.computeSafeTransactionHash` | view pure computation |
| `TieredSpendingGuard.config` | view state |
| `TieredSpendingGuard.configureSafeContractSecondary` | state-changing, Safe-only setup |
| `TieredSpendingGuard.decodeEcdsaSecondaryExtension` | view decoder |
| `TieredSpendingGuard.decodePasskeySignature` | view decoder |
| `TieredSpendingGuard.freeze` | state-changing, Safe-only emergency action |
| `TieredSpendingGuard.frozen` | view state |
| `TieredSpendingGuard.getConfiguredTokens` | view inventory |
| `TieredSpendingGuard.getPolicyRecipients` | view inventory |
| `TieredSpendingGuard.maintenance` | view state |
| `TieredSpendingGuard.policyHash` | view inventory |
| `TieredSpendingGuard.primarySigner` | view state |
| `TieredSpendingGuard.repairPolicy` | state-changing, Safe-only delayed repair |
| `TieredSpendingGuard.repairSigner` | state-changing, Safe-only delayed repair |
| `TieredSpendingGuard.setAssetPolicy` | state-changing, Safe-only monotonic policy action |
| `TieredSpendingGuard.setMaintenance` | state-changing, Safe-only one-time setup |
| `TieredSpendingGuard.spendState` | view state |
| `TieredSpendingGuard.supportsInterface` | pure interface probe |
| `TieredSpendingGuard.safeContractSecondary` | view state |
| `GuardReplacementMaintenance.delay` | view immutable configuration |
| `GuardReplacementMaintenance.maintenanceAddress` | view immutable self-binding |
| `GuardReplacementMaintenance.replaceGuards` | state-changing, configured Delay-only maintenance |
| `GuardReplacementMaintenance.replaceSigner` | state-changing, configured Delay-only maintenance |
| `GuardReplacementMaintenance.safe` | view immutable configuration |

## Live Runner Bootstrap Boundary

`scripts/live/submission.ts` provides a Sepolia-only bounded intent journal: snapshot the intent; verify chain, identity, receipts, nonce, balance and aggregate 0.05 ETH reservation; sign via a supplied local boundary; decode and recover the signed EIP-1559 envelope and compare every transaction field and funding sender; persist the locally computed hash before broadcast; resume by receipt without rebroadcast. A vanished receipt restores the full reservation and pending status. Prior changed receipts block new intents.

`npm run live -- <plan|preflight|submit|resume|evidence>` supplies the locked durable CLI/RPC adapter. It accepts only a zero-value funder self-probe or the exact `SafeWebAuthnSignerFactory.createSigner` tuple for the locally loaded primary or contract-secondary credential, verifies the full decoded intent before submission, and requires `LIVE_SUBMIT=YES` for a broadcast. It is deliberately not a vault-deployment or spending runner. Safe, guard, Delay, ERC-20, and policy-matrix transactions remain unavailable until their own exact-plan verifier is implemented and reviewed.

`src/topology/reviewed-artifacts.ts` is the planned-deployment trust boundary. It reads `proxyCreationCode()` from the already verified official Safe factory, parses the fixed-digest Zodiac Delay v1.1.1 artifact, derives all constructor payloads locally, and uses no-state-change EVM creation simulations to obtain each expected runtime hash. `buildVaultPlan` accepts only opaque artifact evidence produced by this resolver. `scripts/live/vault-runner.ts` exports only the prerequisite stage: it accepts an opaque reviewed plan, signs at most the four prerequisite transactions in nonce order, persists/reconciles each receipt, verifies all four bindings, checks the exact next nonce, and returns. It cannot request fees for, sign, or broadcast Safe creation. `scripts/live/deploy-disposable.ts` calls only that stage and reports `PREREQUISITES_COMPLETE_SAFE_REVIEW_REQUIRED`. A later Safe-creation executor must consume a fresh plan-bound estimate with explicit approved gas, fee, balance, and total-outlay caps, then perform post-setup and topology verification; that executor is deliberately absent pending review.

`scripts/live/secrets.ts` loads owner-only regular files outside the repository and persists generated P-256 credentials with exclusive creation and fsync. Symlinks, shared permissions, hard links, malformed keys, and mismatched public coordinates fail closed; errors do not include secret contents. Credentials remain software test identities, never frontend inputs. Existing planners and local rehearsal remain unsigned/non-broadcasting.

## Monitoring Execution

Read-only log polling → RPC chain identity/address/topic/confirmation checks → exact pinned `TieredSpendingGuard.TransferAuthorized` decoding → Safe transaction lookup whose outer RPC `to` must equal `MONITOR_SAFE`, exact Safe transaction fields/nonce, and event-block-tagged `spendState` re-read → suppress base-tier events → `step-up-executed` alert. Read-only log polling → exact pinned Delay ABI (`TransactionAdded`, `TxNonceSet`) → event-block-tagged queue tuple/hash/creation-time and nonce reads → `delayed-queued` or `delayed-cancelled` alert. Because the pinned fixture emits no execution/expiry lifecycle events, the watcher derives `delayed-executed` only from a successful canonical receipt to Delay whose receipt depth is at least the configured confirmation count, decoded `executeNextTx` tuple, and pre/post nonce transition exactly match persisted queue evidence; it derives `delayed-expired` only from a successful canonical receipt with the same confirmation depth for `skipExpired`, exact queue hash/creation-time state, post-expiry canonical block timestamp, and a nonce transition covering that item. Failed, unconfirmed, non-canonical, undecodable, ambiguous, or cancellation-covered observations produce no derived alert. Derived records use the receipt transaction hash, canonical receipt block hash, and synthetic log index 0 because no fixture lifecycle log exists. The durable monitoring ledger atomically persists a block cursor, log records, and pending notification outbox before notification; it fsyncs replacements, holds an exclusive writer lock, reconciles canonical block hashes, removes reorged records, and retries undelivered alerts after restart. Delivery is marked only after notifier success.

The notifier boundary accepts only public `ActivityAlert` data and exposes only `notify`. Stdout and webhook implementations cannot sign, send, execute, mutate chain state, or retain passkey, Burner, RPC-write, or session credentials. Unknown and malformed events fail closed; monitoring never changes guard, Safe, Delay, queue, signer, or policy state.

## EURC Browser And Backend Boundary

Browser `@simplewebauthn/browser` registration/assertion → loopback-only `apps/backend` → server-side WebAuthn verification bound to configured RP ID, localhost origin, credential, Sepolia chain, Safe, and exact Safe transaction digest. The browser emits only the Safe WebAuthn ABI payload; it never receives the relay key or deployment credentials.

The browser retains public credential identifiers and deployment/report references in its UI session after provisioning. Finishing the setup checklist changes only the local rehearsal marker and preserves those references; it neither approves a transaction nor changes the chain-derived policy. Limits-editor drafts likewise have no execution or signing capability.

Backend `prepare` → server-held vault record plus fresh chain reads → exact EURC `transfer(address,uint256)` calldata → zero Safe value, `CALL`, zero gas/refund fields, configured Safe/guard/EURC, allowlisted recipient, and current Safe nonce → Safe transaction hash. Backend `submit` → durable public request journal → exact-digest WebAuthn verification → existing verified Safe/guard/Delay transport → external gas key only broadcasts the exact already-signed Safe execution. The gas key is not an owner, secondary signer, policy authority, or browser input.

Backend `vault` provisioning → reviewed deployment evidence and two distinct browser credentials → existing unsigned/reconciled deployment runner and topology verifier → `VaultProvisioningResult` containing only public addresses and transaction/report evidence. Missing local secret, unreviewed artifact, unknown session, non-loopback request, arbitrary target/selector, approval/Permit/Permit2, batch, delegate call, direct module call, or uncertain duplicate submission is rejected before any broadcast.

Exact EURC send → chain-derived Safe nonce/guard policy and reviewed EURC recipient → `prepareEurcTransfer` → one `EURC.transfer(address,uint256)` CALL with zero Safe value/gas/refunds → Safe EIP-712 digest → primary browser assertion, then secondary browser assertion for step-up/delayed tiers → durable `SafeSubmissionService` journal → existing Safe/guard/Delay transport. Primary-only, secondary-only, modified digest, changed nonce/recipient/calldata, duplicate, or unreconciled uncertain broadcasts do not produce a second send.

Chain logs and verified Delay queue reads → deduplicated `projectVaultActivity` records → timestamp-derived queued/ready/expired/executed/cancelled display state. An unlisted recipient → `prepareRecipientPolicyRepair` → exact guard `repairPolicy` calldata wrapped in the configured Delay `execTransactionFromModule` queue call; it never becomes an instant transfer. `projectAlerts` exposes blocking topology/EURC health, near-limit, and queued-delay conditions as read-only UI state.

## Task 10 end-to-end proof matrix

The local security gate is `npm run security:check`. It is a reproducible testnet-prototype gate: compilation, the complete Hardhat suite, the call-graph invariant suite, coverage, Slither, a time-controlled local rehearsal, and whitespace validation must all pass. It does not deploy, sign, broadcast, use a secret, or claim an audit.

The adversarial integration suite proves split X/Y spending and anchored reset; state rollback after failed owner execution; wrong signer combinations; exact-signature mutation and replay; approved-hash authorization; arbitrary messages; fallback installation; approvals and unknown calldata; batches; delegatecalls; extra modules; one-guard-only topology; and direct Delay injection. The secondary-signer maintenance suites prove safe-contract secondary delayed queue/cancellation paths, ECDSA secondary freeze/cancellation/policy-repair paths, delayed signer repair for both secondary kinds, no secondary-only asset movement, mandatory Delay timing, role-2 rejection, and cancellation that prevents stale queue collateral from executing. Existing Task 4-9 integration suites provide the detailed Safe/Delay evidence for expiry, ordered cancellation, delayed weakening, and atomic guard repair.

The invariant suite performs an executable ABI inventory for `TieredSpendingGuard` and `GuardReplacementMaintenance`, checks the Safe-only modifier on guard entry points, rejects public spend primitives, and checks explicit fail-closed branches for signatures, queues, calls, and secondary-signer repair validation. Its text search is only a static documentation cross-check; it cannot prove complete reachability or inventory imported Safe/Zodiac code, and the test states that limitation. Imported Safe and Zodiac code is not represented as this repository's audit. Slither is filtered to repository security code and excludes legacy/test support; `slither-baseline.json` records the reviewed detector/function findings and this gate fails on any unlisted finding or tool error.

The rehearsal runs only on Hardhat chain 31337 with controlled time. It refuses chain 1, non-local networks, signatures, RPC URLs, private keys, Burner PINs, secret-bearing environment variables, recovery fields, and broadcast mode. It exercises the adversarial and secondary-signer maintenance flows and emits only unsigned public evidence. The Sepolia rehearsal package contains only the unsigned plan, decoded review, public manifest, and expected evidence hashes; live low-value Sepolia execution remains outstanding until the separate live runner, dependency review, and local-secret prerequisites are complete. All outputs remain security research and a testnet prototype until independent review and professional audit.
