# Dynamic PWA Provisioning Envelope and Recovery Design

## Intent

Replace stale per-transaction Sepolia gas and fee constants with a just-in-time, dual-RPC transaction envelope. Preserve the fixed deployment plan, the `0.05 ETH` Phase One outlay ceiling, durable-before-broadcast behavior, and exact transaction authorization. Add narrow recovery for a journal containing a confirmed contiguous prefix so the current two confirmed signer deployments can resume without deletion, replay, or a new wallet.

This remains local-profile Sepolia research. It does not make the backend an independent security authority and does not authorize mainnet.

## Goals

- Derive each signed gas limit from the higher of two independent live estimates plus at least 30% margin.
- Derive EIP-1559 fee fields live instead of rejecting future network conditions against stale constants.
- Keep a fixed aggregate maximum outlay of `0.05 ETH` as the economic safety boundary.
- Persist the exact quote, observations, margin, fee fields, and authorization before signing.
- Resume only an exact, fully verified, successful journal prefix; never replay confirmed work.
- Recover the current prefix containing `primary-signer` and `secondary-signer` at nonces `959` and `960` without package-specific code.
- Keep the browser unable to choose an RPC, gas, fee, nonce, destination, calldata, artifact, or recovery package.

## Non-goals

- No automatic recovery of pending, reverted, uncertain, reorged, malformed, or non-prefix journals.
- No fee optimization, replacement transaction, cancellation transaction, or arbitrary nonce repair.
- No weakening of runtime hash, topology, confirmation, package, plan, or outlay checks.
- No new Solidity, signer provider, dependency, or mainnet behavior.
- No claim that two public RPCs or the Phase One backend provide independent authorization.

## Constraints

- Chain ID is exactly `11155111` and profile is exactly `sepolia-pwa-phase-one-v1`.
- Transaction identities and immutable fields remain the reviewed seven-item plan.
- Every completed step still requires six confirmations, a canonical receipt, and the exact expected runtime.
- The configured relay RPC remains the only signer/broadcaster transport.
- Quote providers are the two distinct, committed providers already in the PWA profile. Browser or environment input cannot replace them.
- The existing `0.05 ETH` aggregate ceiling remains committed code policy.
- All generated operational state remains outside the repository.

## Approaches considered

### Fixed per-transaction ceilings

Rejected. Sepolia's state-gas repricing made the committed values obsolete, and another upgrade can do so again.

### One live estimate plus 30%

Rejected. It removes stale constants but lets one unavailable, stale, or faulty provider determine the signed envelope.

### Protocol-derived calculation

Rejected. Bytecode deposit can be calculated, but constructor execution, storage creation, proxy setup, and future gas schedules make a complete local formula brittle.

### Selected: two live estimates plus 30%, bounded by total outlay

For the next exact transaction, query both committed providers against the same canonical block and exact sender, destination, value, and calldata. Take the higher estimate and apply a 30% ceiling margin. Derive fees from the common block base fee plus both providers' priority-fee observations, apply the same 30% margin, and then require cumulative confirmed spend plus pending and new reservations to remain at or below `0.05 ETH`. Future unquoted steps are not reserved; if earlier steps leave insufficient budget, the sequence stops before another signature.

## Canonical quote

Before each new signature:

1. Read both provider heads and choose the lower head.
2. Require both providers to return the same block hash and chain ID for that height.
3. Require that block to contain the exact expected deployer nonce and prerequisite state.
4. Estimate the exact transaction on both providers at that block.
5. Reject a zero estimate or provider disagreement greater than 10% of the higher estimate.
6. Set `gasLimit = ceil(max(estimateA, estimateB) * 130 / 100)`.
7. Require `gasLimit` not to exceed the canonical block gas limit. There is no invented or provider-specific transaction-limit input.
8. Require a common non-null base fee at the quote block. Read `eth_maxPriorityFeePerGas` from both providers, take the higher tip, set `maxPriorityFeePerGas = ceil(tip * 130 / 100)`, and set `maxFeePerGas = ceil((2 * baseFee + tip) * 130 / 100)`. Require priority fee not to exceed maximum fee.
9. Require both quote-provider heads to be no more than two blocks ahead of the common quote block. Immediately before authorization, require the relay provider to report the same canonical quote-block hash and the exact next nonce for both `latest` and `pending`.
10. Recompute the aggregate budget as confirmed actual costs plus any pending reservation plus the new exact envelope. Reject above `0.05 ETH`. Separately require current relay balance to cover only pending plus new reservations, so confirmed spend is not double-counted against post-spend balance.

The 30% value and `0.05 ETH` are policy ratios/budgets, not assumptions about how much gas a named contract consumes. Future gas repricing changes the live estimate without requiring a code edit.

## Authorization and persistence

Change the local authorizer from one seven-transaction fixed-cap approval to a per-transaction authorizer. It accepts only:

- the opaque reviewed plan;
- the next exact plan transaction;
- the current confirmed journal prefix;
- the canonical dual-RPC quote;
- the aggregate reservation facts.

It returns the exact gas limit and EIP-1559 fields to sign. No caller may override a returned field.

Before signing, write a versioned, append-only PWA-specific authorization sidecar next to the provisioning journal using the existing atomic write, `fsync`, rename, directory-`fsync`, and the same exclusive-lock discipline as the journal. Each canonically hashed record binds:

- package hash and plan hash;
- transaction ID, immutable transaction hash, and nonce;
- quote block number and hash;
- both provider identities and observations;
- 30% margin;
- exact signed gas and fee fields;
- prior and resulting aggregate reservation;
- authorization hash and timestamp.

An authorization is single-use. If signing fails before a durable transaction hash exists, a retry rechecks every fact and appends a new authorization; the earlier record remains as superseded evidence and is never silently overwritten. Journal IDs map explicitly from authorization transaction ID `id` to submission ID `pwa-${id}`.

`submitLiveIntent` remains the signer/broadcaster and continues to persist the signed transaction hash before broadcast.

## Recovery

Startup no longer rejects every non-empty provisioning journal. It classifies it:

- empty: normal onboarding;
- confirmed-success prefix: candidate recovery;
- anything else: hard stop requiring separate review.

Candidate recovery must pass all of these checks:

1. Journal identity matches Sepolia and the configured relay account.
2. Entries are a contiguous prefix of the seven fixed IDs, with consecutive nonces, `success` status, and receipts.
3. Each receipt is still canonical and has at least six confirmations.
4. The corresponding onchain transaction is read through both committed providers where available, is from the relay account, and exactly matches one unique review package's nonce, destination, value, calldata, and operation.
5. Recomputing each historical signed intent from the onchain gas and fee fields reproduces the stored intent hash.
6. Each expected deployed runtime is present and exact; every future planned address has no code.
7. Review package bytes and content are validated independently of the filename. Byte-identical duplicate packages count as one candidate. The unique package hash and plan hash are valid, and a recovery-only planner that permits an already-deployed verified prefix rebuilds the same package, policy, addresses, and immutable transactions from signer calldata plus committed artifacts.
8. Both `latest` and `pending` relay nonces equal the next planned nonce.
9. Confirmed actual costs plus the next dynamic reservation stay within `0.05 ETH`.

Recovery never trusts a filename alone, never accepts browser-selected data, and never changes already confirmed intent fields. It resumes at the first missing transaction.

Startup validates and prepares a recovery candidate but does not broadcast. The existing empty `POST /v1/vaults/auto-provision` request starts or rejoins recovery. In recovery mode the provisioner uses the reconstructed reviewed plan and does not require newly registered credential metadata to deploy the remaining exact transactions.

The current journal has no dynamic-authorization sidecar for its already confirmed signer prefix. Migration accepts those historical entries only through the complete onchain/package/intent-hash verification above. Every new transaction requires the new sidecar before signing.

## Credential continuity

The deployment plan contains the two credential public-key coordinates in the exact signer-factory calldata, so recovery can reconstruct and verify deployment without private passkey material. Credential IDs and counters are not used to authorize relay deployment.

After recovery, the backend exposes a role-specific rebind challenge and verification flow. The browser supplies only a standard WebAuthn assertion; its credential ID comes from the signed assertion response, not from a deployment field. The backend reconstructs the expected ES256 public key from the role's reviewed coordinates, starts from counter baseline `0`, verifies user presence and user verification against the fixed RP ID/origin/challenge, then stores the verified credential ID and returned counter in memory. A credential for one role cannot rebind the other role because its signature will not verify against the other reviewed key.

Both primary and secondary roles must rebind before any transfer is prepared, approved, submitted, or reconciled. Rebinding is not required to finish the fixed relay deployment. The recovered vault may be returned and persisted by the UI before rebind completes, but the UI must show both roles as requiring verification and the backend must fail closed on every spending path until both succeed.

## Failure behavior

- Either quote provider unavailable, wrong-chain, noncanonical, or materially inconsistent: stop before authorization.
- Estimate, fee, block, nonce, code, package, receipt, or reservation changes after authorization: stop before signing and generate no replacement automatically in the same call.
- Pending or uncertain journal entry: reconciliation only; never sign another transaction.
- Reverted transaction or changed canonical receipt: hard stop.
- Recovery package ambiguity: hard stop.

## Tests and evidence

- Unit tests for 30% ceiling arithmetic, disagreement, fee arithmetic, total reservation, and exact authorization binding.
- Dual-provider tests for common block/hash selection and fail-closed divergence.
- Recovery tests for valid prefixes of length one through six and rejection of gaps, reordering, changed intent hashes, mismatched reviews, pending/reverted entries, nonce drift, runtime drift, and reorgs.
- Credential-rebind tests for role/key mismatch, wrong RP/origin/challenge, missing user verification, counter rollback, and spending before both roles rebind.
- A regression fixture for the current two-entry confirmed prefix without embedding its package hash, addresses, transaction hashes, or nonces in production code.
- Integration tests proving no signing before durable authorization and no replay of a confirmed prefix.
- Update the call graph and automated provisioning design to replace fixed caps and document the recovery path.

## Rollback

Code rollback restores the previous hard startup stop. It must not delete or rewrite the provisioning journal, authorization sidecar, review packages, or onchain deployments. A non-empty journal remains recoverable only by a version that implements and verifies this design.
