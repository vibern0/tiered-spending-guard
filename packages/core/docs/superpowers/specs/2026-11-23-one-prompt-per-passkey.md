# One passkey prompt per signer for sponsored GLD sends

**Status** Implemented for a separate, local Safe 1.5 prototype on the `codex/one-prompt-safe` branch. The existing local wallet continues to use its installed router. [Existing route design](2026-11-19-installable-safe-4337-contract-routing-design.md)

| Projected instant GLD total for the UTC day | Wallet approval | Onchain result |
| --- | --- | --- |
| Up to and including 10 | Primary once | Transfer |
| Over 10, up to and including 30 | Primary once, secondary once | Transfer |
| Over 30 | Existing delayed proposal flow | Instant execution rejects. The approved withdrawal goes through the 120-second Delay. |

## Signing flow

1. Encode one action for the configured GLD contract and recipient. Include the exact positive amount, zero native value, CALL operation and requested tier. Obtain the final gas and paymaster fields before prompting. Use size-bounded placeholder proofs for estimation and require a sponsor that can finalize from the unsigned operation.
2. Bind both assertions to one versioned typed digest covering the EntryPoint operation hash, router, guard, validity window and tier. The operation hash binds the chain, EntryPoint, sender, nonce, call data, gas limits, fees and final paymaster data. Carry the actual assertions in the UserOperation signature field, outside the signed call data. Verify the primary with the Safe's signature checker using the single, configured passkey contract slot. Verify the distinct configured secondary over that same digest when required. Require the exact expected roles, canonical proof encoding and user verification.
3. For these sends, use the pinned EntryPoint 0.7 full-operation execution interface. It supplies the operation and hash again at execution. The stock Safe4337Module validator checks for its own execution selectors, so support for this path requires a versioned restricted router. Authenticate the Safe, EntryPoint caller suffix, current operation hash, sponsor, zero missing account funds and the closed transfer shape. Never request a deposit or gas refund from the Safe. [EntryPoint execution interface](https://github.com/eth-infinitism/account-abstraction/blob/v0.7.0/contracts/interfaces/IAccountExecute.sol) and [Safe module validation](https://github.com/safe-fndn/safe-modules/blob/75e56fd52b0ddbe01dc237eaae7edb9a102ffc5c/modules/4337/contracts/Safe4337Module.sol#L133-L162)
4. During execution, verify the signed operation presented by EntryPoint and make its exact authorization available to the module guard only for the duration of that transfer. Bind the authorization to the operation hash, Safe, guard, token call and verified signer set. The guard accepts it only from the pinned router, consumes it once, reads current onchain spending and checks the required tier again. Retain the ERC-20 pre/post balance checks, atomic counter rollback, both Safe guard slots, restricted owner path and existing Delay rules. A single pending approval shared across operations would be unsafe because EntryPoint can validate several operations before executing any of them.
5. Submit through the bundler with the paymaster covering gas. A provider change to signed fields requires fresh review. Reconcile an ambiguous submission by its operation hash before requesting another signature. A declined passkey, expired quote or concurrent send can require a retry. The prompt target applies to a successful send with stable signed fields.

## Acceptance on a separate local Safe

- Count actual WebAuthn assertion requests by credential ID around each Send through real EntryPoint 0.7 and the local paymaster. Send 1 GLD with one primary assertion, then 9.1 GLD with one assertion from each credential. Check receipts, amounts and token balances. Verify a zero ETH Safe balance and zero Safe EntryPoint deposit before and after.
- Verify exactly 10 and 30 GLD and the first unit above each boundary. At 10.1 spent, a new primary-only send must revert through any client. At 30 spent, immediate execution must revert even with both approvals. Verify UTC rollover, delayed execution and cancellation.
- Exercise two operations for the same Safe in one bundle, a stale reviewed tier, a failing token transfer and a replay. There must be one matching authorization per executed transfer, no cross-operation approval reuse, and no spending credit taken on failure.
- Verify changed sponsor, gas fields, nonce, validity, recipient, amount, token, operation, tier, signer, Safe, chain and router invalidate approval. Preserve rejection of unknown modules, direct owner transfers to GLD, generic messages, arbitrary calls and batches.
- Treat hosted bundler and paymaster acceptance as a separate compatibility test. The current installed profile has no configured router/guard replacement path. Testing this design requires a separately provisioned local installation and an explicit migration decision before using an existing wallet.

## Observed local run on 2026-11-23

Chromium used two distinct virtual WebAuthn credentials on Safe `0x804439E830df1e1212083cb2CEf772Ef0A7cba87`. The test counted both browser credential requests and successful authenticator assertions and compared credential IDs. For the second send the credentials signed the same challenge.

| GLD sent | Assertions | Instant total | Block | Paymaster charge (wei) | Local transaction |
| --- | --- | --- | --- | --- | --- |
| 1 | Primary | 1 | 54 | 2655697559344481 | `0x226983aaf081e1ca4971d558aa45d1ea9080f76d0caa9c6f7a1ac600bfe16b00` |
| 9.1 | Primary, secondary | 10.1 | 55 | 3009965916922448 | `0x100f2faf249748a9ea426fadad3e6b0f2b236e9ce3a7ca8bc5e575c52079abc8` |

Both EntryPoint events reported success. Historical reads at each receipt block and its parent showed the paymaster deposit decrease equalled the operation's actual gas cost. The Safe's ETH balance and EntryPoint deposit were zero on both sides of each transfer. Sender and recipient GLD balance changes matched each amount.

The separate EntryPoint integration test submitted signed operations directly. At a cumulative 10.1 GLD the guard rejected one token unit with the primary alone, accepted 19.9 GLD with both and then rejected one more unit with both. On the next UTC day a primary-only send of exactly 10 GLD succeeded. These checks also cover multiple operations validated together and rollback when a token transfer fails. The browser rehearsal uses local gas estimates and sponsorship. Physical authenticator UI and hosted bundler admission require separate testing.
