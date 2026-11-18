# Pimlico blocker resolution proposal

**Date:** 2026-10-16
**Status:** Focused proposal for review; implementation blocked.
**Related:** [Compatibility report](../../security/pimlico-compatibility.md), [client-only spec](2026-10-16-client-only-pimlico-design.md).

## Problem

The stock Safe4337 candidate does not yet preserve the vault's arbitrary-message denial, exact inner SafeTx authorization, sponsored prerequisite deployment and permissionless ready Delay transport. The ordinary Safe Sepolia matrix is also outstanding. No new custom fallback, module, factory or public executor is authorized by this proposal.

## Proposed disposition

Keep the existing backend profile and write boundary active. Complete the prior ordinary-Safe live gate under its separate capped authorization and runbook. Do not treat a signer deployment or read-only simulation as an ordinary-Safe execution rehearsal.

After that gate, investigate existing reviewed primitives for these exact boundaries:

| Boundary | Required resolution before implementation |
| --- | --- |
| Fallback | Identify an existing reviewed selector-restricted forwarding primitive that permits exact EntryPoint validation/execution while rejecting both Safe ERC-1271 message entry points and other forbidden selectors onchain. Establish immutable caller/target binding, source/audit scope and runtime identity. Stock inherited handler is unsuitable without such proof. |
| Nested guard | Within the approved guard/helper exception only, specify an exact envelope state machine: idle, bound outer module envelope, one matching inner owner check, completed inner result, matching outer after-hook, idle. Keep Delay separate. Bind the complete canonical self-CALL and inner signatures/digest; deny unrelated nesting and roll back on every failure. This sketch is a review requirement, not an approved design or code. |
| Prerequisites | Identify a reviewed sponsored deployment route for credential signers, setup helper, guard, Delay and maintenance, followed by atomic protected Safe setup. Show public deterministic addresses, constructor/source/runtime bindings, no nonce-owned external deployer dependency and no transient unguarded asset-holding state. |
| Permissionless Delay | Identify a reviewed non-custodial sponsored route allowing anyone to call ready `executeNextTx` without original primary/secondary signatures, hidden relay key, broad Safe module authority or second custody account. Paymaster sponsorship alone supplies no account authorization. |
| Sponsorship and bundler | Document browser-distributable credentials with enforced provider budgets/limits/CORS and exact paymaster binding; pin a standards-enforcing bundler digest/command and validate real passkey/storage/staking behavior. Reject vault prefund and token charging onchain. |

If reviewed existing primitives cannot satisfy these boundaries, return a second explicit design decision identifying exactly which accepted constraint would need amendment. Any new security-critical contract falls outside `AGENTS.md`'s approved Solidity exception and needs a separate reviewed proposal before code. Do not weaken message policy, use a broad module exception, add an EOA secret, require original signers for ready execution, or silently relax sponsorship-only operation.

## Reopening acceptance

All rows require exact source/version/audit/address/runtime evidence, rejection-first integration tests, nonce/digest mutation coverage, complete call-graph updates and actual bundler validation. Preserve one primary owner, guard-only secondaries, one asset Safe, both guards, X/Y rollback, cancellable Z, delayed weakening and independent non-authorizing alerts.

The client-only implementation plan remains blocked until the ordinary live gate and every compatibility row pass. This proposal changes no active contract, dependency, topology, browser/backend boundary or release claim.
