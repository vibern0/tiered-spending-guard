# Policy Engine lessons

**Reviewed commit:** `405ba1d91e85d0fd26abf0f645bf216822c8c595` from `safe-research/policy-engine` `main` (2026-09-17)

**Status:** Closely related prior art and a potential future comparison or migration candidate. It is not a deployment dependency for this prototype.

## Provenance and license

The source was reviewed at the commit above in the Safe Research GitHub repository: <https://github.com/safe-research/policy-engine/tree/405ba1d91e85d0fd26abf0f645bf216822c8c595>. Its repository license and per-file SPDX notices govern any later reuse. This repository does not copy its implementation.

## Similar-project status update

Status checked 2026-11-04 against upstream `main` at `8ee68a8cdac65b4aba5d9a10e9f9018c2efb10b3`:

- The project is a direct architectural analogue: a Safe transaction/module guard dispatches deny-by-default policies for owner and module executions.
- Certora's [first recorded audit](https://github.com/safe-research/policy-engine/blob/main/audits/audit.md#audit-1) covered `PolicyEngine`, `SafePolicyGuard`, `AccessSelector`, and `SignatureExtension`, finalized at the locally reviewed `405ba1d91e85d0fd26abf0f645bf216822c8c595`. Five low-severity findings were reported; two were fixed and three acknowledged.
- Certora's [second recorded audit](https://github.com/safe-research/policy-engine/blob/main/audits/audit.md#audit-2) covered the listed policy contracts and finalized at `8c300329d9c2158b7778066c0e1531bc1725056e`. It excluded `OneTimeAllowPolicy`; upstream also states that vendored Safenet cryptography, test contracts, and the demo application were outside the audit scope.
- Upstream `main` continued changing after those snapshots. Later commits [restricted `NativeTransferPolicy` to plain transfers](https://github.com/safe-research/policy-engine/commit/5236128eac4ac3aeb05651bd6b71ecf3a17f712f) and [rejected module transactions in `CoSignerPolicy`](https://github.com/safe-research/policy-engine/commit/8ee68a8cdac65b4aba5d9a10e9f9018c2efb10b3), so the audit reports must be mapped to an exact candidate commit rather than applied to current `main` as a blanket claim.
- The built-in policies still do not implement this project's shared per-token cumulative X/Y accounting or its cancellable delayed withdrawal tier Z. The general policy interface omits Safe refund fields and therefore cannot itself reconstruct the complete Safe transaction hash.

Any proposal to adopt or extend the Policy Engine must pin a candidate commit, map every relied-on contract and change to audit scope, compare its exact transaction binding and post-audit fixes with `TieredSpendingGuard`, preserve the approved native Safe ERC-4337 constraints, and receive an explicit architecture amendment. Until then, it remains a similar project to monitor, not trusted infrastructure.

## Security lessons recorded

- `SafePolicyGuard` must occupy both Safe guard slots: `setGuard` for owner transactions and `setModuleGuard` for module transactions. Install both atomically where possible; one slot alone leaves a complete authorization bypass.
- `CoSignerPolicy`, `IncreasedThresholdPolicy`, and `SignatureExtension` demonstrate that context is untrusted caller-supplied data. It is acceptable only as self-authenticating material, such as a signature over a recomputed digest; it is never an identity claim.
- Exact digest verification must bind every transaction field that matters. A policy must not authorize an open-ended context window or an unrelated Safe transaction.
- Stateful checks require `safeTxGas == 0` so a failed inner owner call cannot commit accounting state. Module failures need the module after-execution hook to revert as well; otherwise a failed module call can consume state without moving funds.
- `gasPrice == 0` removes Safe refund payment from the policy surface. Refund fields then cannot move value outside the policy, but this is a deliberate invariant that must be enforced.
- Reentrancy gating surrounds top-level policy checks. Recursive checks are limited to the same Safe, and policy state must be namespaced by `(policy guard, safe)` so one Safe cannot consume another Safe's state.
- Stateful-policy tests show that failed-module rollback, same-Safe recursion, and cross-Safe isolation are security properties, not optional test conveniences.

## Interface and topology notes

Safe 1.5 exposes separate transaction-guard and module-guard interfaces. Owner execution enters the transaction guard before `execTransaction` and invokes its after-execution hook; module execution enters the module guard before `execTransactionFromModule` (and its return-data variant) and invokes the module after-execution hook. Safe increments its nonce as part of owner execution before the guard's post-signature execution path; exact digest reconstruction must account for the nonce selected for the signed transaction.

Safe contract signatures use the Safe signature encoding, including EIP-1271 contract-signature slots; approved-hash signatures are persistent and therefore are not an acceptable substitute for exact, per-transaction authorization here. The fallback handler is a separate Safe routing surface and must be explicitly constrained or left unset.

The Delay proposer/execution path is a module call that queues an exact target/value/calldata/operation tuple, waits for its cooldown, and then permits execution by an unprivileged executor. Its proposer and upstream Safe/module relationships must be checked from the deployed instance; an old or independently enabled module can bypass the intended delay.

These notes are verification requirements for later integration, not evidence that this repository has audited or deployed the Policy Engine, Safe, passkey, or Delay composition. Upstream component audits do not audit this project's X/Y/Z policy or its complete configured call graph.
