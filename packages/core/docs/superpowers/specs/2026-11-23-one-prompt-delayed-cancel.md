# Two passkey approvals for sponsored withdrawal cancellation

**Implemented for a separate local Safe.** Each configured passkey signs the same sponsored cancellation once. The wallet presents the oldest queued transfer and both the router and guard restrict the operation to that withdrawal.

## Signed action

Show the oldest pending withdrawal's number, GLD amount and recipient before requesting either passkey. Obtain final sponsorship and gas data. Both configured credentials sign one versioned `CancelWithdrawal` challenge bound to the EntryPoint operation hash, router domain, guard, Delay, queue entry number and stored transfer hash. The canonical calldata commits to those reviewed details and an approval deadline. The operation hash covers the Safe, chain, nonce and final paymaster terms.

At execution, verify both proofs for this operation and read the Delay contract again. Require the signed entry to be the current, existing head and match its stored hash to the reviewed transfer. Authorize one zero-value Safe call to that Delay's `setTxNonce(head + 1)`. Require the head to advance exactly once and consume the authorization atomically. A head change while either prompt is open invalidates the request, including when the next entry contains an identical payment.

Cancellation is available immediately upon inclusion of the queue request and while the entry remains pending. The existing Delay enforces its 120-second cooldown for execution. The configured paymaster pays for cancellation with zero Safe gas contribution.

## Verification before enabling on a user's wallet

- Queue two withdrawals, cancel the first from the browser, and count one WebAuthn request and successful assertion for each distinct credential over the same challenge. Verify one sponsored receipt, one skipped entry, the second entry still pending, and unchanged GLD balances and daily spending.
- Exercise cancellation during cooldown, after readiness and after expiry. Check that a stale or replayed cancellation cannot skip the next item. Require both credentials and reject changed amounts, recipients, hashes, queue numbers, targets and sponsor fields. Confirm cancellation proofs cannot authorize queuing or execution.
- Execute the surviving withdrawal only after its own 120-second delay. Update the call graph and verify the new router and guard bytecode on a separate local installation before any personal-wallet migration.
