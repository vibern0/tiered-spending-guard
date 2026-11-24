# Two passkey approvals for a sponsored GLD queue request

**Implemented for a separate local Safe.** The earlier installation signs an inner Safe transaction with both credentials and then signs its sponsored submission with the primary credential. The new installation accepts a sponsored queue request signed once by each credential. Its scope is enqueueing a GLD withdrawal.

## Authorization and execution

1. Have the wallet obtain final gas and paymaster fields before prompting. Present “Queue 20 GLD” with the approved recipient and the 120-second delay. Request one WebAuthn assertion from each of the two distinct configured credentials over the same versioned, queue-specific digest. Bind the EntryPoint operation hash, Safe, router, guard and Delay address. The canonical operation commits to chain, nonce, token, recipient, full amount, validity deadline, zero native value, CALL, and sponsorship. A changed quote requires fresh approval.
2. In a new local router version, authenticate the Safe and EntryPoint, verify the pinned paymaster and require zero missing account funds. Verify the sole primary owner through the Safe and the configured secondary through its contract signer. Recheck both proofs for the operation supplied at execution, the deployed runtime identities and both guard slots. Keep the queue digest distinct from instant sending, cancellation and ready execution.
3. Permit exactly one Safe module call to the configured Delay to enqueue the canonical GLD transfer. The module guard binds that call to this operation and rechecks the configured token, allowed recipient, positive amount and remaining daily allowance at execution. If the transfer now fits the instant allowance, reject it and return to review. Consume the authorization within this execution and revert the whole operation if enqueue fails. The sole effect is appending the full transfer to Delay. Both token balances and instant spending counters stay at their previous values.
4. Use the queue entry's onchain creation time to start the cooldown. Preserve the existing sponsored paths for cancellation and execution, including their current signer requirements, queue ordering, and the 600-second execution window after the cooldown. Activation belongs on a separate local installation because the user's current installation pins the router runtime and has no configured replacement path.

## Acceptance on the local chain

- Starting with 10.1 GLD of instant spending, queue 20 GLD through the browser. Count two successful WebAuthn requests, one per distinct credential, with the same challenge. Match the successful sponsored operation to one Delay entry for exactly 20 GLD. Check unchanged token balances and spending counters, and match the paymaster's deposit charge to the EntryPoint receipt with zero Safe gas contribution.
- Prove cancellation during cooldown prevents later execution. Queue again and prove execution fails at 119 seconds, succeeds once at 120 seconds, and transfers exactly 20 GLD. Verify expiry with a separate entry.
- Require both credentials. Check that altered signed fields, stale limits, replayed approvals and attempts to use the queue proof for an instant transfer or another action are rejected. Cover multiple operations in one bundle and atomic rollback on enqueue failure. Record the new execution path in the call graph alongside the tests before deployment.

## Local rehearsal on 23 November 2026

Chromium used two distinct virtual WebAuthn credentials for Safe `0x4208AE1Fa766350fb4Ca389fC0D53078995DBD9E`. After 1 and 9.1 GLD instant sends, each of the following 20 GLD queue requests produced one credential request and one successful assertion per credential, over a shared challenge. Historical block reads showed 89.9 GLD in the Safe and 10.1 GLD at the recipient immediately before and after each enqueue.

| Action | Transaction | Paymaster charge in wei |
| --- | --- | ---: |
| Queue withdrawal 0 | `0x5fbae1ac1e4de7ebf4c5f1b004b11fa81d6bfec96e55391b498374e6f91c3e70` | 3191863423260075 |
| Cancel withdrawal 0 | `0xbe8ecc3887793823cb4a03a2704b6e95fa4d37ee62e5886ebe1fed8a3bdc78da` | 3055597680874896 |
| Queue withdrawal 1 | `0x4a7f4625f05dcf6f42e38bc1e7a3667d1ea6dbed9fb1af638268a91cb4e71ff6` | 3119986414454908 |
| Execute withdrawal 1 | `0x8e5bafb589fe4263a52d7de1c7d7d4c104dff8eb4606108bd647fa26b0e00376` | 2402941293377880 |

The successful browser execution landed 121 seconds after enqueue. The recipient received 20 GLD once, the instant total stayed at 10.1 GLD, and each paymaster deposit decrease matched the EntryPoint receipt. In the separate controlled-time EntryPoint test, execution failed at 119 seconds, succeeded at 120 seconds, and failed on a repeat attempt. Restoring the pending queue and advancing to 721 seconds verified expiry.
