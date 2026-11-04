# Personal Vault: Wallet-Security Research and Product Direction

**Status:** Research baseline
**Date:** 2026-09-16
**Repository:** `recent-tx-safe-guard`

## 2026-10-19 supersession: approved native Safe ERC-4337 candidate

The approved [native Safe design](../superpowers/specs/2026-10-17-native-safe-4337-design.md) replaces the stock Safe4337Module, nested owner-call wrapper, and funder-paid EntryPoint-deposit direction. The selected candidate keeps one asset-holding Safe, an ordinary guarded Safe transaction as the policy-bearing inner action, Delay as the only enabled module, and sponsored gas. It adds only a selector-restricted fallback handler, locked bootstrap factory/helper, and inert creation-code anchors. The locked shared passkey owner must transition during the exact nonce-0 activation to the same public key's credential-specific signer. The active profile has one primary owner and one guard-only contract/passkey secondary; the ECDSA secondary is absent and disabled.

The nonzero fallback is allowed only with exact handler/runtime/profile identity, authenticated EntryPoint caller suffixes, canonical ABI, approved nonzero paymaster, zero missing-account funds, and denial of both ERC-1271 message selectors and unknown calls. Handler or sponsor-profile changes are delayed maintenance actions. Ordinary Safe Sepolia receipts, the X/Y/Z/cancel/expiry/repair matrix, and independent alerts remain a prerequisite; local tests and an unsigned package do not pass that gate. `apps/backend` remains required until a native replacement is independently evidenced.

## 2026-10-09 supersession: primary owner, guard-only secondaries

The approved [guard validation plan](../superpowers/plans/2026-10-09-guard-live-validation.md) supersedes the three-owner topology below. The primary passkey is the sole Safe owner at threshold 1. Contract and ECDSA secondaries are configured and independently validated by `TieredSpendingGuard` over the exact Safe transaction; neither is a Safe owner. Primary rotation atomically swaps the owner and guard identity after Delay. Secondary rotation changes guard configuration only, after Delay. No recovery owner is installed.

Ordinary Safe execution must pass real-cryptography local and live Ethereum Sepolia tests before ERC-4337 implementation. Automated credentials are not evidence of hardware/WebAuthn browser UX. Burner NFC remains deferred; supported secondary signature formats do not imply a working Burner integration. The remaining X/Y/Z, fail-closed execution, message restrictions, and no-WalletConnect rules remain binding.

## 2026-10-01 supersession: Option B secondary-signer prototype (historical)

The active secondary-signer design supersedes the earlier recovery-owner and Burner-specific topology for code, configuration, deployment examples, and verification. The prototype now uses exactly three Safe owners, ordered by Safe rules from the configured primary passkey, safe-contract secondary, and ECDSA secondary. `TieredSpendingGuard` remains the policy authority: base transfers require the primary passkey, while step-up transfers, delayed proposals, cancellation/freeze, and delayed maintenance require the primary plus exactly one enabled configured secondary signer over the exact Safe transaction.

The two supported secondary forms are a Safe-native contract-signature secondary and an ECDSA-extension secondary. A YubiKey-backed passkey is an example of the safe-contract form. WalletConnect is not accepted for the prototype. Direct Burner NFC/libhalo signing remains a future spike and is out of scope until documented HaLo signing proves the exact Safe transaction can be signed, recovered, and accepted without changing the custody graph. The recovery owner described below is deferred until a separate reviewed design can restore control without adding an immediate withdrawal, signer-repair, owner, module, fallback, or message-signing bypass. For this testnet prototype, losing the primary passkey or all configured secondary factors is an accepted denial-of-service risk: funds may become unavailable until a future delayed recovery mechanism is designed, implemented, reviewed, and tested. This is preferable to shipping a recovery signer that silently weakens the active call graph.

Historical analysis in this document is left intact as evidence and product direction. Where it conflicts with this supersession note, the active Option B secondary-signer baseline controls implementation.

## Executive summary

The original project idea remains valuable, but it should no longer be framed as only a recent-transaction guard. The stronger product is a single-Safe personal vault with three authorization tiers:

1. A base instant tier for ordinary payments. A passkey may authorize multiple transactions while their cumulative amount stays within the token's daily limit X.
2. A step-up instant tier. The primary passkey and one configured secondary signer must both approve, and all base plus step-up transactions share a cumulative daily ceiling Y.
3. A delayed tier for transfers above Y and for unusual or security-weakening actions. The guard-required signer set approves first, then the exact action remains cancellable during a mandatory delay Z.

The two instant tiers are enforced onchain through per-transaction, per-period, per-token, destination, function, and signer restrictions. X and Y are cumulative daily ceilings, not single-transfer thresholds, and must satisfy `0 < X < Y`. Base transactions consume both the X allowance and the shared Y allowance; step-up transactions consume the shared Y allowance. This prevents an attacker from spending X on one path and then another full Y on the other path.

The desired primitives now exist across Safe, Zodiac, passkeys, and inexpensive NFC hardware signers. Gnosis Pay is production evidence that a Safe can be combined with Roles and Delay modules to create constrained immediate spending plus delayed administrative actions. Argent previously shipped a closely related consumer experience, while Loopring provides daily quotas and guardian controls. ERC-8238 now proposes a near-exact vault model, but it is still a draft with a small reference implementation.

No currently available general-purpose consumer wallet found in this research packages all of the following into one approachable product:

- A Safe-based vault
- A passkey as the convenient daily signer
- A configured secondary signer, either Safe-contract or ECDSA-extension, as a step-up signer
- Per-transaction and daily limits
- Mandatory post-approval delays for larger transfers
- Independent alerts and cancellation
- Recovery that cannot immediately bypass the vault policy
- A bank-like interface that hides the account/module topology

The opportunity is therefore not merely another timelock contract. It is a safe composition, verification, and consumer experience around existing audited components, with as little new security-critical Solidity as possible.

## Problem statement

Conventional self-custody usually has a binary failure model: a valid signature can authorize the complete loss of the account. Hardware wallets make key extraction harder, and multisig requires more keys, but neither necessarily protects a user who is shown false transaction details and legitimately signs the wrong operation.

The system should instead make one compromised credential, one deceptive interface, or one mistaken approval survivable. It should provide the same useful property that bank transfer controls provide: routine activity can happen promptly, while unusually valuable activity creates time and an independent opportunity to intervene.

This matters more as phishing, impersonation, malicious interfaces, and targeted social engineering become cheaper to produce. AI changes the volume and personalization of attacks; it does not change the underlying security requirement. Deterministic onchain policy should remain the authority. AI may help explain, simulate, or flag a transaction, but it must not be a root authorizer.

## Security objectives

The product should satisfy these properties:

1. **Bounded compromise:** Compromise of the daily passkey or its phone cannot immediately drain the vault. Passkey-only loss is bounded by X, and all immediate base plus step-up spending is bounded by Y, per token and daily period.
2. **Post-approval delay:** A large action remains delayed even after all required signers approve it.
3. **Exact authorization:** An approval is bound to the intended chain, account, destination, value, calldata, operation, and nonce. It cannot become an open time window for an unrelated transaction.
4. **Non-bypassable execution:** Direct owner calls, enabled modules, delegate calls, multisends, token approvals, Permit/Permit2, and arbitrary EIP-1271 signatures cannot silently bypass the policy.
5. **Independent cancellation:** A queued action produces an alert on a separate channel and can be cancelled or paused before execution.
6. **Delayed weakening:** Increasing limits, shortening delays, adding signers or modules, expanding permissions, or disabling enforcement is itself delayed.
7. **Safe recovery:** Recovery restores control without becoming an immediate withdrawal path.
8. **Understandable operation:** The interface expresses policy in user terms: “primary passkey up to X today,” “approve with a secondary signer up to Y today,” “available after this time,” and “cancel this transfer.”
9. **Fail-closed behavior:** Unknown calls and unsupported assets do not fall through an empty fallback or permissive default.
10. **Recoverability without a backdoor:** No vendor, relayer, or hosted service can unilaterally spend. Loss of one user factor does not permanently lock the account.

## Threat model

### In scope

- A malicious browser extension or dapp
- A compromised phone, browser, or wallet front end
- Theft of one signer or one authenticated session
- Deceptive transaction presentation and blind signing
- Malicious token approvals or signed messages
- Incorrect or malicious module configuration
- Front-end or dependency supply-chain compromise
- Loss of a phone, primary passkey, safe-contract secondary, or ECDSA secondary device/account
- An attacker attempting to weaken policy before withdrawing
- A legitimate user making an irreversible mistake
- Coercion or duress where the attacker has access to the daily signer but not every independent recovery/cancellation factor

### Outside the first MVP

- Privacy-preserving transfers
- Cross-chain policy synchronization
- Arbitrary DeFi calldata and protocol adapters
- Aggregate USD limits that depend on price oracles
- Automated fraud scoring as an authorization mechanism
- Protection after an attacker simultaneously controls every signer and the cancellation channel
- Formal coercion resistance comparable to a mature, audited implementation of the ERC-8238 proposal

## What exists today

### Safe smart accounts

Safe separates proposing, signing, and executing. A signer does not need to hold funds or gas. This is a strong foundation for separating day-to-day authorization from vault custody.

Safe supports WebAuthn passkeys as ERC-1271 signers for Safe accounts version 1.3 and later. A passkey can therefore be an owner without representing the vault as a conventional seed phrase. See [Safe passkeys](https://docs.safe.global/advanced/passkeys/passkeys-safe).

Safe v1.5 introduced module guards. This closes an important structural gap: before module guards, an enabled module could bypass the Safe transaction guard. A serious design must constrain both owner transactions and module transactions. See the [Safe v1.5 module-guard announcement](https://safefoundation.org/blog/introducing-safe-v1-5-0-module-guards-enhanced-smart-account-features).

Guards are also dangerous. A defective guard can deny service to the Safe, so every enforcement mechanism needs a deliberately designed recovery path. Safe documents this risk in the [`setGuard` reference](https://docs.safe.global/reference-smart-account/guards/setGuard).

Safe’s first-party Spending Limit module provides delegated one-time, daily, weekly, or monthly token allowances. It is useful prior art, but a delegate spends without the normal owner threshold and the feature does not provide mandatory delayed execution or cancellation for larger actions. See [Safe spending limits](https://help.safe.global/articles/3961440620-set-up-and-use-spending-limits).

Safe’s signed-message support also matters. An account may authorize offchain messages using threshold owner signatures and ERC-1271. A policy that protects only `execTransaction` can still be undermined by broad token approvals, Permit2, or an unrestricted message-signing path. See [Safe signed messages](https://help.safe.global/articles/7507962149-what-are-signed-messages).

### Zodiac Roles and Delay

The [Zodiac Roles Modifier](https://docs.zodiac.eco/developers/roles) gives a module fine-grained permissions over targets, functions, parameters, ETH value, and allowances. Its allowance model supports refill periods such as daily, weekly, or monthly. A value allowance alone does not restrict where funds go, so destination and function restrictions must be composed with it. See [Roles allowances](https://docs.zodiac.eco/developers/roles/allowances).

The [Zodiac Delay Modifier](https://docs.zodiac.eco/developers/delay) queues a module transaction for a cooldown period. The owner can invalidate queued transactions, anyone can execute after cooldown, and an optional expiration can prevent stale execution. The queue is ordered.

The central caveat is routing. Delay affects only calls that pass through it. Direct Safe-owner transactions or a separately enabled module can bypass it. A secure topology must remove those alternative spending paths or constrain them with an equivalent policy.

Version selection is security-critical. Current Zodiac documentation identifies old Roles 2.1.0 and Delay 1.1.0 releases as vulnerable. An implementation must resolve versions through the current registry, reject known-faulty releases, pin exact dependencies, and verify deployed bytecode rather than copying addresses from an old article or deployment.

### Gnosis Pay: production evidence for the composition

Gnosis Pay is the closest deployed architectural precedent. Each user account is a Safe with Zodiac modules. Roles limits the card path by amount and permitted settlement recipient. Delay protects slower administrative and withdrawal actions. Their documented architecture transfers Safe ownership to an inaccessible sentinel address, preventing a human EOA owner from bypassing module controls with a direct Safe transaction. See the [Gnosis Pay architecture](https://docs.analytics.gnosis.io/protocols/gnosis-pay/) and [self-custody explanation](https://help.gnosis.io/en/articles/15326301-how-does-gnosis-enable-card-payments-while-remaining-self-custodial).

This is evidence that the proposed composition is technically viable. It is not evidence that an old Gnosis Pay deployment or configuration should be copied verbatim. The pattern is reusable; every dependency, version, permission, and privileged path still requires current verification.

### Argent

Argent previously offered a particularly close consumer model: transfers under a daily limit were immediate, while an over-limit transfer waited 24 hours and could be approved or blocked with a guardian. See [Argent’s historical hardware-wallet and transfer-limit design](https://www.argent.xyz/blog/how-to-use-your-hardware-wallet-with-argent).

Argent later emphasized trusted addresses and guardians, and new Ethereum Vault wallets are no longer available to new users. See [Argent Vault availability](https://support.argent.xyz/hc/en-us/articles/5975236743569-Argent-Vault). The precedent validates the user experience but is not a currently open general-purpose path for this project.

### Loopring Smart Wallet

Loopring provides a daily quota, guardian locking and recovery, and delayed whitelist changes. The documented quota is ecosystem-specific and historically denominated in ETH with limitations. It is useful product prior art rather than a direct Safe-based solution. See [daily quota](https://docs-wallet.loopring.io/security/daily-quota) and [guardians](https://docs-wallet.loopring.io/security/guardians).

### Ambire

Ambire materially improves Safe operation through simulation, batching, clearer signing, and a smoother multisig flow. It supports using Safe accounts without relying on the Safe web interface. See [executing Safe transactions with fewer steps](https://help.ambire.com/en/articles/16146238-execute-safe-transactions-with-fewer-steps) and the [Ambire security model](https://help.ambire.com/en/articles/13714175-ambire-wallet-security-model).

Ambire addresses usability and transaction understanding, but this research did not find the complete general policy of bounded instant spending plus mandatory, cancellable delayed large withdrawals.

### Rhinestone

Rhinestone exposes developer infrastructure for passkeys, MFA, spending-limit hooks, smart sessions, and timelocked cold-storage behavior across modular accounts. It is evidence that these controls are converging into reusable wallet infrastructure. It remains an SDK/infrastructure option rather than the requested finished consumer experience. See [Rhinestone’s module SDK overview](https://www.rhinestone.dev/blog/modulesdk-now-supports-12-core-modules-and-smart-sessions-9a6c54d49472) and [spending-limit policy](https://docs.rhinestone.dev/smart-wallet/smart-sessions/policies/spending-limit).

### Safe Research Policy Engine

The [Safe Research Policy Engine](https://github.com/safe-research/policy-engine) is a closely related Safe-based project and a potential future consolidation or migration candidate. It provides a general mandatory-access-control layer that installs on transaction and module paths, applies deny-by-default policies, requires co-signers or higher thresholds, restricts transfers, and delays configuration or guard removal.

It overlaps with this project's dual-path enforcement, signature-extension, stateful-policy atomicity, transfer restriction, and delayed-weakening requirements. It does not currently provide the complete product policy: primary-passkey-only cumulative spending up to X, shared base-plus-step-up cumulative spending up to Y per token, and a cancellable delayed withdrawal tier Z. Its general policy interface also cannot reconstruct the complete Safe transaction hash because it omits the gas-refund fields; this project deliberately binds its tier authorization to the exact Safe transaction while separately enforcing zero refund behavior.

Status checked 2026-11-04: upstream [records two Certora audits](https://github.com/safe-research/policy-engine/blob/main/audits/audit.md), one for the engine/guard finalized at `405ba1d91e85d0fd26abf0f645bf216822c8c595` and one for the listed policy implementations finalized at `8c300329d9c2158b7778066c0e1531bc1725056e`. The recorded scope excludes `OneTimeAllowPolicy`, vendored Safenet cryptography, test contracts, and the demo application. Upstream `main` subsequently changed, including security-relevant policy fixes, so those reports are not blanket evidence for every later commit or for this project's composition. Track the Policy Engine as a similar project and possible future architecture input, but do not deploy or trust it here without a new pinned-commit review, scope mapping, adversarial comparison, and explicit design amendment.

### ERC-8238

[ERC-8238: Coercion-Resistant Vault](https://ethereum-magicians.org/t/erc-8238-coercion-resistant-vault/28130) proposes hot-wallet epoch limits, delayed vault withdrawals, cancellation, guardians, emergency pause, delayed configuration changes, per-token limits, and DeFi whitelists. It is remarkably close to the target product.

The proposal remains an [open ERC pull request](https://github.com/ethereum/ERCs/pull/1703), not an established standard. Its [reference repository](https://github.com/DeFiRe-business/eip-proposal-5wrench) is small and should be regarded as research code until the proposal, implementation, audits, and adoption mature.

## Burner NFC card assessment

[Burner](https://www.burner.pro/) is an NFC secure-element hardware wallet. Its private key is designed to be non-extractable, it uses a PIN, and it supports encrypted card-to-card backup rather than a seed phrase. See Burner’s [key and backup explanation](https://help.burner.pro/articles/why-doesn-t-burner-have-a-seed-phrase-and-how-is-my-private-key-secured). Its wallet-connection path is not accepted for this prototype under the current no-WalletConnect rule.

The underlying [libhalo library](https://github.com/arx-research/libhalo) supports signing data, including EIP-191/EIP-712-related flows. This makes the card technically suitable as a secp256k1 Safe owner or signer exposed through a wallet connection.

The limitation is transaction display. The card has no screen on which it can independently render the destination, token, amount, chain, and consequences. The phone or browser constructs and displays the request. A compromised interface may therefore deceive both the phone passkey and the Burner card into signing a malicious operation. Two signatures made through one compromised display are not fully independent security factors.

Burner should consequently be treated as:

- A strong possession factor and protection against key extraction
- A convenient named co-signer for step-up and delayed proposals from the single Safe
- A recoverable physical signer when paired with a duplicate stored separately
- Not an independent trusted transaction display
- Not a replacement for onchain policy, mandatory delay, and independent alerts

For high-value use, a second device or display should verify the transaction fingerprint and human-readable details. The importance of this property was reinforced by the Bybit/Safe incident, where compromised infrastructure could deceive legitimate signers. The Ethereum ecosystem’s [clear-signing initiative](https://blog.ethereum.org/2026/05/12/clear-signing-announcement) addresses this class of failure.

## Passkey and onboarding-provider assessment

The security-core prototype should start with Safe-native signer paths rather than choosing an embedded-wallet vendor as a foundation. Safe's passkey module can make a WebAuthn credential a Safe owner, while a reviewed non-WalletConnect signer boundary can represent an ECDSA secondary if it preserves exact Safe transaction binding. These are the narrow signer primitives the vault needs.

Pimlico and `permissionless.js` are useful account-abstraction infrastructure for bundlers, paymasters, gas sponsorship, and ERC-4337 user-operation transport. They should be treated as execution infrastructure, not as the authority for vault policy. The onchain Safe, `TieredSpendingGuard`, and Delay configuration remains the source of truth.

[Cometh Connect](https://docs.cometh.io/) remains a credible onboarding option. Its current documentation describes a white-labeled Web/TypeScript SDK for ERC-4337 smart wallets controlled with biometrics, built on WebAuthn and Gnosis Safe. This makes it relevant for the future consumer wallet. It should not be selected as the MVP's security baseline until it proves that it can sign for the exact configured Safe without introducing an alternate wallet, recovery, relayer, owner, fallback, or module path that bypasses the guard or Delay.

Other embedded-wallet and smart-wallet SDKs, including Privy, Dynamic, Turnkey, ZeroDev, Kernel, Biconomy, and Alchemy smart wallets, should be evaluated the same way. The question is not whether they offer passkeys or gasless transactions; many do. The required question is whether they can act through the project's signer adapter while preserving the verified Safe/Zodiac call graph.

The implementation should therefore expose a small signer boundary first:

- Safe-native passkey adapter
- Reviewed non-WalletConnect adapter for ECDSA secondary hardware wallets
- Optional future provider adapters, such as Cometh, only after conformance tests prove they sign the exact Safe transaction and cannot bypass the configured policy

## Recommended architecture

### Account topology

```text
Primary passkey ──────────────────────────────────────┐
safe-contract secondary or ECDSA secondary ────────────────┤
                                                       v
                                              Single Vault Safe
                                                       │
                         TieredSpendingGuard on owner + module paths
                             │              │                 │
                       base <= X/day   step-up <= Y/day   queue above Y
                    primary passkey    primary+secondary primary+secondary
                             │              │                 │
                             └──── immediate ┘          Zodiac Delay
                                                            │ delay Z
                                                            v
                                                        execution

Independent service ── step-up execution + delayed lifecycle alerts
```

Historical note: the original recovery-owner wording in this section is superseded by the active secondary-signer design. The active prototype deploys exactly one Safe with exactly the primary passkey signer contract, safe-contract secondary, and ECDSA secondary as owners at threshold 1; it has no recovery owner, recovery signer adapter, or active recovery selector. The low Safe threshold is not the security policy: the mandatory `TieredSpendingGuard` validates which named signer authorized each operation and requires exactly one configured secondary approval when the tier demands it. Secondary-only transactions are rejected by the guard.

The guard is installed as both the Safe transaction guard and Safe 1.5 module guard. Exactly one execution module is enabled: a reviewed Zodiac Delay instance whose owner, avatar, and target are the Safe. The Safe itself is the only Delay proposer. Owner transactions may queue through Delay only when the guard validates the inner action and required signers; Delay is the only module allowed to execute against the Safe. Every other owner or module path is denied.

The Safe uses no unrestricted fallback handler. Direct `signMessage`, arbitrary ERC-1271 validation, approved-hash signatures, delegate calls, batches, approvals, Permit/Permit2, and unknown calldata are denied in the first prototype. Guard removal, module changes, owner changes, signer rotation, limit increases, delay reductions, and permission expansion can execute only as previously queued Delay module transactions.

### Tiered spending guard

`TieredSpendingGuard` is the new security-critical contract this project exists to build. It implements both Safe guard interfaces and maintains per-Safe, per-token spending state. The selected Safe Research Policy Engine is prior art, not a trusted production dependency. The implementation should adopt and test its relevant lessons:

- Install enforcement on both owner and module paths.
- Treat signature-extension context as untrusted until its signature is verified over a digest recomputed by the guard.
- Bind authorization to chain ID, Safe, destination, value, calldata, operation, gas/refund fields, and Safe nonce.
- Require `safeTxGas == 0` and `gasPrice == 0` so a failed inner call reverts policy state.
- Revert failed module executions from the after-execution hook.
- Use a reentrancy gate around stateful checks.
- Namespace all state by Safe and asset even if the MVP deploys one guard instance per Safe.
- Deny by default and explicitly enumerate every target, selector, signer path, and module.

The contract is testnet research until its code, configured call graph, deployment, and recovery process are independently reviewed and professionally audited.

### Signer rules

For transfers, the Safe-validated threshold signature must include the configured primary passkey contract signature; pre-approved-hash signatures are rejected. The guard recognizes signer identity from the canonical Safe signature encoding after Safe has validated it.

Step-up and delayed proposals carry exactly one configured secondary approval. A safe-contract secondary is another Safe-validated contract-signature slot. An ECDSA secondary is the versioned ECDSA terminal extension over the exact Safe transaction hash recomputed by the guard, produced only through a reviewed non-WalletConnect boundary. The secondary approval is not trusted merely because it appears in the signatures bytes, and it cannot be replayed against another Safe, chain, nonce, destination, amount, calldata, or operation.

Historical note: the recovery-owner rule above is superseded for the active prototype. There is no recovery owner. Cancellation, freeze, queued signer repair, and queued policy repair require the configured primary passkey plus exactly one enabled secondary signer. Loss of the primary or all configured secondary factors is an accepted testnet availability risk until a future delayed recovery design is separately written, reviewed, implemented, and rehearsed.

For the highest assurance, the root passkey should be device-bound or held on a hardware security key. A synced passkey is still materially stronger than SMS or a reusable password, but its cloud-account recovery domain must be included in the threat model.

### Base instant tier

The guard permits the Safe transaction immediately when:

- Native ETH transfers and explicitly supported ERC-20 `transfer` calls only
- The Safe-validated signer is exactly the passkey owner
- The amount is within the base per-transaction cap
- Base spending plus the amount is at most X for the asset's current 86,400-second period
- Shared instant spending plus the amount is at most Y for that same period
- The token, recipient, selector, and operation are explicitly allowed
- No delegate calls
- No arbitrary contract calls
- No token `approve`, Permit, Permit2, Safe owner changes, module changes, guard changes, or policy changes
- Deny by default for unrecognized calldata

A successful base transfer consumes both the base X counter and shared instant Y counter. The guard updates counters before execution and relies on enforced atomic Safe behavior to roll them back if execution fails.

### Step-up instant tier

When a transfer does not fit the remaining base X allowance but remains within shared Y, the guard requires both the Safe-validated primary passkey signature and exactly one valid configured secondary approval over the exact Safe transaction hash. The same token, recipient, selector, operation, and per-transaction restrictions apply. Every successful step-up transfer consumes the shared Y counter but not the base X counter. A transfer may use the stronger step-up tier before X is exhausted, but doing so still reduces the remaining Y capacity. Across every ordering and number of base and step-up transactions, immediate outflow for an asset cannot exceed Y during the daily period.

The first MVP should use token-denominated limits. USD-denominated aggregate limits require price oracles, staleness handling, manipulation resistance, and failure behavior that do not belong in the initial security core.

### Delayed tier

When a recognized transfer would make shared daily spending exceed Y, the guard rejects direct execution and permits only a call from the Safe to queue that exact transfer in Delay. The queue transaction requires the primary passkey Safe signature plus exactly one configured secondary approval. Security-weakening configuration changes and signer repair use the same delayed primary-plus-secondary path; no recovery owner may queue repair in the active prototype. Approval does not immediately execute the action. The queue record must bind:

- Chain ID
- Safe address
- Destination
- Native value
- Calldata
- Call/delegate-call operation
- Queue nonce
- Earliest execution time
- Expiration, if configured

The default target for the prototype should be a 24-hour cooldown with a finite expiration. Higher-value production profiles may use 48–72 hours.

Anyone may execute a valid queued transaction after cooldown; execution should not depend on the original signer remaining online or holding gas. A relayer may improve usability, but it must have no authorization beyond executing an already-valid queue item.

### Cancellation, alerts, and pause

A delay is useful only if the owner learns about queued actions and can respond. Every delayed-tier `TransactionAdded` event must be monitored. Alerts should include decoded human-readable details and a canonical transaction fingerprint.

Every confirmed step-up execution must also produce an independent notification containing the asset, amount, recipient, chain, Safe, transaction hash, and resulting daily Y usage. The guard emits the tier and post-authorization counters; the service verifies those values against the transaction and onchain state before notifying. This notification is observational and normally arrives after the immediate transaction executes. It is not a substitute for the configured secondary approval or the onchain Y limit. Base-tier transactions do not require service notifications.

At least one notification channel must be independent from the proposing browser session. Examples include a second-device push notification, email with no signing capability, or an operator-selected webhook. Notification compromise must not authorize spending.

In the active Option B prototype, the primary passkey plus exactly one configured secondary signer may invalidate queued items and freeze both instant tiers through exact guard allowlists. There is no recovery owner. Because Zodiac Delay is ordered, advancing its transaction nonce may invalidate earlier queued items; the cancellation builder and UI must enumerate every affected nonce before approval.

### Policy and recovery changes

Changes that weaken security must not become effective immediately:

- Raising a limit
- Shortening a cooldown or extending queue expiration
- Adding a token, recipient, function, signer, module, or guard exception
- Removing a signer, guard, or module that participates in enforcement
- Expanding message-signing capability
- Changing future recovery authority, if a later separately reviewed recovery design is added

Security-tightening actions may be immediate:

- Pausing either instant tier
- Lowering a limit
- Removing an allowed recipient or function
- Cancelling a queued transaction
- Freezing instant transfers after a signer compromise

This asymmetry is a required property, not merely a UI convention. The effective onchain call graph must enforce it.

### Signed messages and approvals

Transaction-only policy is insufficient. The design must explicitly address:

- Safe EIP-1271 message validation
- Token `approve` and `increaseAllowance`
- EIP-2612 Permit
- Permit2
- Session keys and smart sessions
- Pre-existing allowances created before installation
- Multisend and nested calls

The MVP should deny arbitrary instant-tier message signing and all approval mechanisms. A delayed-tier exact approval may be supported after the UI can clearly show spender, token, amount, expiry, and revocation behavior. Unlimited approvals should not be part of the supported product path.

## User experience

The interface presents one Safe and its three authorization tiers. Modules and guard state remain inspectable, but the user never has to manage auxiliary custody Safes.

### Onboarding

1. Create or select a passkey.
2. Connect a configured secondary signer: safe-contract secondary, reviewed non-WalletConnect ECDSA secondary, or both for the active Option B testnet profile.
3. Confirm no independent recovery signer is active in the security-core prototype.
4. Choose conservative per-token base daily limits X, shared immediate daily limits Y, and per-transaction caps, with `0 < X < Y`.
5. Choose the delay period Z and alert channel.
6. Deploy one Safe plus its TieredSpendingGuard and Delay module, then configure them atomically.
7. Show a verifiable summary of Safe owners, threshold, guard, module, X/Y limits, delay Z, and recovery.
8. Require base, step-up, queue, notification, cancellation, and recovery exercises before accepting substantial deposits.

### Sending

The send screen classifies an action before signature:

- **Primary passkey:** the transfer fits within the remaining base X and shared Y daily allowances.
- **Primary + secondary:** the transfer exceeds the remaining base allowance but fits within the remaining shared Y allowance.
- **Delayed:** the transfer exceeds the remaining shared Y allowance, requires primary passkey plus one configured secondary approval, and shows the exact execution time after delay Z.
- **Unsupported:** cannot be represented safely by the current policy.

The UI’s classification is advisory. The onchain TieredSpendingGuard and Delay contracts are authoritative.

### Queue

The queue must show:

- Human-readable asset, amount, and recipient
- Raw address and chain
- Calldata decoding and warnings
- Who proposed and approved
- Earliest execution and expiration
- Transaction fingerprint
- A prominent cancellation action
- Execution and cancellation history

### Recovery

Historical note: recovery-owner rehearsal guidance is superseded for the active Option B prototype. The product should remind the owner to verify each configured secondary factor without moving funds or exposing secrets, but it must not describe, collect, or rely on an offline recovery signer until a separate delayed recovery design is written, reviewed, implemented, and tested.

## Assessment of the existing repository

The current code is a historical prototype and should not be hardened incrementally into production.

### Critical findings

1. `RecentTransactionGuard.onlySafe()` contains no authorization check. Any caller can change the validator and timing parameters.
2. `validateNext()` records only a block number. It does not bind validation to a Safe, chain, transaction hash, destination, value, calldata, operation, or nonce.
3. `checkTransaction()` ignores every transaction argument and treats a recent block marker as authorization for the next call.
4. State is global rather than isolated per Safe.
5. The contract creates neither a delayed queue nor a cancellation mechanism.
6. There are no per-transaction, daily, per-token, destination, function, or approval restrictions.
7. The fallback silently accepts unknown calls, which is incompatible with fail-closed enforcement.
8. The mock disables authorization and omits meaningful Safe signature and after-execution behavior, so its tests do not establish real Safe compatibility or security.
9. The project depends on `@gnosis.pm/safe-contracts` 1.3.0 and predates Safe 1.5 module guards.

The old code remains useful as a record of intent and as negative test material. New work should preserve it under `legacy/`, implement the one-Safe policy from current Safe 1.5 interfaces and reviewed Delay components, and test against real Safe behavior rather than the permissive mock.

## Options considered

### Option A: Single Safe + narrow custom guard + Zodiac Delay — recommended prototype

Keep custody in one current Safe. Implement the exact X/Y signer and accounting policy in one purpose-built transaction/module guard, and use a reviewed Zodiac Delay only for the Z queue.

**Advantages**

- Preserves one Safe as the only custody account
- Reuses Safe signature validation and the established Delay queue
- Strong ecosystem compatibility
- Implements the product's exact named-signer and daily-limit semantics
- Keeps new Solidity focused on the genuinely missing policy layer

**Costs and risks**

- The guard is security-critical new Solidity
- Signature parsing, stateful accounting, module execution, recovery, and guard removal require adversarial proof
- A defective guard can lock the Safe
- Production use requires independent review and professional audit

### Option B: Deploy and extend Safe Research Policy Engine

Deploy the research engine and add a custom tiered-spending policy to it.

**Advantages**

- Provides useful transaction/module guard structure, signature extensions, and atomic stateful-policy patterns
- Reduces some bespoke guard framework code

**Costs and risks**

- Audited in scoped snapshots, but still evolving beyond those audit commits
- The listed policies do not supply the required cumulative X/Y behavior
- The project would inherit a broader framework and still require security-critical custom X/Y/Z policy Solidity plus a composition-specific review

The recommended implementation studies this code and records the exact commit reviewed, but does not deploy it as an opaque dependency.

### Option C: Standalone ERC-8238-style vault

Build or adopt a native vault account centered on hot limits, delayed withdrawals, guardians, and pause.

**Advantages**

- Closest semantic match
- Can enforce all paths in one purpose-built state machine
- Avoids accidental Safe module/owner bypasses

**Costs and risks**

- Draft standard and immature ecosystem
- Largest new audit surface
- Less interoperability and tooling than Safe
- Risks duplicating work underway elsewhere

## Recommendation and product position

Proceed with Option A as a security-core prototype. Use Option B as security prior art and a possible future migration target after audits and maturity. Track Option C as a possible standards-based consolidation path.

Position the product as:

> A personal self-custody vault with three authorization tiers: passkey spending up to X per day, passkey-plus-NFC spending up to a shared Y per day, and cancellable delayed withdrawals above Y.

The primary differentiation is the complete consumer workflow:

- Safe defaults
- Automatic base/step-up/delayed classification
- NFC tap as understandable step-up approval
- Delay after approval rather than before approval
- Independent notification and cancellation
- Recovery without an immediate withdrawal backdoor
- Verifiable configuration and plain-language signing

## MVP scope

The first security-core prototype should include:

- One EVM test network
- One Safe holding assets, with exactly the primary passkey signer contract, safe-contract secondary, and ECDSA secondary as owners at threshold 1, and no recovery owner
- One non-upgradeable `TieredSpendingGuard` installed as transaction guard and module guard
- One reviewed Zodiac Delay as the only enabled execution module
- One native asset and selected ERC-20 assets
- Per-transaction limits, a passkey-only daily X allowance, and a shared immediate daily Y allowance per token
- Onchain proof that base transactions consume X and Y while step-up transactions consume Y, so all immediate spending remains at or below Y
- Exact primary passkey Safe-signature enforcement and one configured secondary approval over the full Safe transaction hash
- Explicit recipient/function permissions
- A delayed tier with a default 24-hour cooldown and finite expiration
- Queue listing, execution, and cancellation
- Passkey and reviewed non-WalletConnect hardware-wallet signer adapters
- Direct Burner NFC/libhalo remains a future spike outside this prototype
- No default embedded-wallet SDK dependency; Cometh and similar providers are evaluated later through the signer-adapter boundary
- Independent notifications for confirmed step-up executions and the delayed queue lifecycle
- Full topology/configuration verification
- Adversarial integration tests using real Safe behavior

The first prototype should not support arbitrary DeFi, bridges, NFT operations, batch calls, delegate calls, arbitrary EIP-1271 messages, Permit2, unlimited approvals, multiple chains, or mainnet deployment.

## Delivery gates

1. **Architecture proof:** Every execution and configuration path is diagrammed and tested. Both Safe guard slots point to the same expected guard, Delay is the only module, and no unrestricted owner, module, fallback, signed-message, or approved-hash path remains.
2. **Adversarial proof:** Tests demonstrate passkey-only loss bounded by X, all immediate loss bounded by Y across both instant tiers, mandatory delayed-tier delay, successful cancellation, and inability to weaken policy immediately.
3. **Testnet rehearsal:** Setup, base send, step-up send, both notification types, queue, cancel, execute, lost-factor recovery, and signer rotation are exercised from clean accounts.
4. **Independent review:** A Safe guard/signature specialist and a Zodiac Delay specialist review the contracts, topology, and assumptions.
5. **Audit:** `TieredSpendingGuard`, its signature helpers, and the complete configured call graph receive professional review before production funds.
6. **Product pilot:** A small invited cohort uses strict caps on a testnet and then a deliberately low-value production pilot.

## Immediate next actions

1. Execute the linked security-core implementation plan.
2. Contact Safe, Gnosis Guild, Burner/Arx, and the ERC-8238 authors to validate assumptions and avoid duplicating active work.
3. Produce a separate wallet-UX implementation plan only after the onchain topology passes its architecture and adversarial gates.
4. Do not deploy the historical guard or place funds in the prototype.

## Primary sources

- [Safe passkeys](https://docs.safe.global/advanced/passkeys/passkeys-safe)
- [Safe v1.5 module guards](https://safefoundation.org/blog/introducing-safe-v1-5-0-module-guards-enhanced-smart-account-features)
- [Safe guard recovery warning](https://docs.safe.global/reference-smart-account/guards/setGuard)
- [Safe modules](https://help.safe.global/articles/5490514177-what-is-a-module)
- [Safe spending limits](https://help.safe.global/articles/3961440620-set-up-and-use-spending-limits)
- [Safe signed messages](https://help.safe.global/articles/7507962149-what-are-signed-messages)
- [Safe hardware-wallet verification guidance](https://help.safe.global/articles/4369997924-how-to-verify-safewallet-transactions-on-a-hardware-wallet)
- [Zodiac Delay](https://docs.zodiac.eco/developers/delay)
- [Zodiac Delay reference](https://docs.zodiac.eco/developers/delay/reference)
- [Zodiac Roles](https://docs.zodiac.eco/developers/roles)
- [Zodiac Roles allowances](https://docs.zodiac.eco/developers/roles/allowances)
- [Gnosis Pay architecture](https://docs.analytics.gnosis.io/protocols/gnosis-pay/)
- [Gnosis Pay self-custody explanation](https://help.gnosis.io/en/articles/15326301-how-does-gnosis-enable-card-payments-while-remaining-self-custodial)
- [Safe Research Policy Engine](https://github.com/safe-research/policy-engine)
- [ERC-8238 discussion](https://ethereum-magicians.org/t/erc-8238-coercion-resistant-vault/28130)
- [ERC-8238 pull request](https://github.com/ethereum/ERCs/pull/1703)
- [ERC-8238 reference implementation](https://github.com/DeFiRe-business/eip-proposal-5wrench)
- [Burner](https://www.burner.pro/)
- [Burner key and backup model](https://help.burner.pro/articles/why-doesn-t-burner-have-a-seed-phrase-and-how-is-my-private-key-secured)
- [libhalo](https://github.com/arx-research/libhalo)
- [Cometh documentation](https://docs.cometh.io/)
- [Pimlico permissionless.js](https://docs.pimlico.io/references/permissionless/)
- [Ambire Safe flow](https://help.ambire.com/en/articles/16146238-execute-safe-transactions-with-fewer-steps)
- [Ambire security model](https://help.ambire.com/en/articles/13714175-ambire-wallet-security-model)
- [Argent historical transfer limits](https://www.argent.xyz/blog/how-to-use-your-hardware-wallet-with-argent)
- [Argent Vault availability](https://support.argent.xyz/hc/en-us/articles/5975236743569-Argent-Vault)
- [Loopring daily quota](https://docs-wallet.loopring.io/security/daily-quota)
- [Loopring guardians](https://docs-wallet.loopring.io/security/guardians)
- [Rhinestone modular wallet infrastructure](https://www.rhinestone.dev/blog/modulesdk-now-supports-12-core-modules-and-smart-sessions-9a6c54d49472)
- [Ethereum clear-signing initiative](https://blog.ethereum.org/2026/05/12/clear-signing-announcement)
