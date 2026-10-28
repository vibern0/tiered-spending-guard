# Task 0 Hashless Interrupted-Attempt Recovery Proposal

**Status:** public design proposal; no implementation or live authorization

**Date:** 2026-10-28

**Interrupted-attempt revision inspected:** `1e24c636b665b8d44f5755e0e30fd6d485939d35`

**Current repository revision:** `653f322d9cf3ddc56dc77ddfd5d81e643dba2668`

**Scope:** preserve the interrupted FIRST38 attempt and continue the required semantic evidence without a new EOA, redeployment, generic retry path, or new financial authority.

## Decision

Implement one closed, append-only **expired hashless continuation** in the existing atomic scenario journal. The old attempt remains immutable. A new public artifact enumerates the exact 22-action continuation, and a new exact group approval binds that artifact and every action commitment. The original proposal and approval authorize none of it.

The initial implementation has no ready-execution recovery branch. Canonical item 2 expired at `1793209608` (`2026-10-28T17:46:48Z`) before this design could be reviewed and approved. The only accepted route is: prove the source item expired without execution, skip it, queue and execute a replacement one-wei delayed transfer, then run a fully rebased USDC matrix.

The original FIRST38 proposal never becomes complete. Task 0 may use the preserved original evidence plus the separately approved continuation as one explicit semantic lineage.

## Public facts

- Original artifact bytes hash: `0xe72746e38c34a75d3e4fba829a085c0fa15590a6f0948b2391fa4661b568e831`.
- Original package hash: `0x08568eb5edbd050dcd4a21eceedaff48e2d0be8b9acac54e28d024cec795e571`.
- Original proposal hash: `0x22770c7944ee289543c10090b3483bdcd87f0d2c193887df4f32916c5782e45f`.
- Original approval hash: `0x9f4af3d3a6142dd901019a7acd5dc10c69af23c89a884cb018c201b095e4e4a1`.
- Public hashless-state artifact SHA-256: `fc9c71e506c6941496501178fc2b826575ede10839fc61fbda838bb747a8f339`.
- Canonical nonce-invalidation proof SHA-256: `efbde290c5fa6a39008c6f1a3c66fb72c5b24f1ce0b7fc036bc9df1b46fcfcd3`.
- Interrupted journal bytes SHA-256 at design time: `6cd8213656cb5efb2b5bfafbab7192be93462f2d290f81916fb6eb9eaa657c74`.
- Journal rows 1-18 are terminal and remain byte-for-byte evidence.
- Row 19 is `native-queue-ready-execute`, commitment `0x2e024d850e4b7f18fe03fac5165285160f60fa0a417ff6c5afd2e1caaefbc813`, status `signed-simulated`, historical outer nonce `809`, gas `300000`, fees `28/2`, with no intent hash, transaction hash, receipt, or embedded live entry.
- The original embedded `LiveJournal` has 10 entries and ends at confirmed queue proposal `0xf78f36e9b8a128d780936111278bb76850079eb9b4492bf2ad0b039078a5072f`.
- Exact materialization-hash recovery selected canonical prestate block `12013857`, hash `0x197add23b0385bce509adab0a3f3234b58b71e63d0ebccad9aa2e99ba5f44e20`, timestamp `1793209056`.
- A preliminary public tip snapshot at block `12013882`, timestamp `1793209356`, still had outer nonce `809` unused.
- Canonical controlled state was Safe nonce `7`, Delay `queueNonce=3`, Delay `txNonce=2`, queued item 2 created at `1793208888`, and Safe native balance `1` wei.
- Two independent public sources later agreed at certificate block `12013934`, hash `0x05d0f3b8f503bfee60455adc88c717e330aa2bafaffb6badca3b5c8215f3948e`, that nonce `809` was canonically consumed with at least six confirmations by successful transaction `0x83923abf9c1224125296a3485f8cc0a910e7f729ea5d5a73d6f01bf1cdbfe1f5` in block `12013885`.
- The consuming transaction targets `0xadb8f835e565ac7e71d2df6cfbd0fc003fa22c27` with input hash `0x25491caa28455d896a7211a1c4532ab1e72412bdb15293292e2e37e5f9406c63`. Row 19 targets Delay `0xB8E143098CcCb9935228022173c2c987DF5FD53a` with data hash `0xc1e7bbfb9942640a3d4bfadf4540cbe0f5c8bd92f1cd8adeb0ca58bcaba7c24f`. The transactions are unambiguously different.
- At the certificate block, funder nonce was `811`; Safe nonce `7`, Delay `3/2`, Safe native balance `1`, Safe USDC balance `20000000`, item-2 fingerprint, and expired unexecuted queue state were unchanged.

The generic CLI error does not identify the cause. Fee-suggestion drift is a statically visible fragility, but it is not proven to have caused the interruption. Nonce `809` was consumed later than the failed invocation; its later consumption invalidates any retained envelope but does not explain the earlier failure. No design or report may infer a cause.

## Why row 19 stays immutable

The executor intentionally refuses `materialized` or `signed-simulated` rows without a durable outer hash. The lost transient calldata and EIP-1559 envelope cannot be reconstructed under the old exact approval. Resetting the row, marking it terminal in place, re-signing it, or reusing approval `0x9f4a…` would convert one exact attempt into retry authority.

`submitLiveIntent` computes and durably persists the outer hash before its broadcast callback. The journal therefore proves that the reviewed executor did not reach that broadcast boundary. Public RPC cannot prove global absence of an unbroadcast private envelope. Process and journal lineage are necessary evidence, but they are not sufficient to unlock financial recovery.

Recovery unlocks only after historical outer nonce `809` is canonically consumed with at least six confirmations by a transaction whose recovered sender is the shared funder and whose target, value, calldata hash, gas, or fees prove it differs from row 19's persisted outer tuple. Consumption makes any privately retained nonce-809 envelope permanently invalid. If every persisted outer field matches, the canonical transaction supplies the previously unknown hash; recovery stops and routes to receipt/hash reconciliation. The public invalidation proof satisfies this safety gate with a different target and input hash. It is evidence, not execution authority.

## Rejected approaches

- Mutating or deleting row 19, or retrying it under the original approval.
- A manual transaction, separate recovery journal, budget reset, or quick private-key path.
- A generic action append, generic `to/value/data` runner, retry counter, or wildcard nonce/fee approval.
- A ready-successor branch with a human-review timing margin. The source item is already expired.
- A new EOA, new wallet funding flow, Safe/module redeployment, or contract change.
- Treating unused nonce `809`, process provenance, or mempool-provider absence as sufficient recovery authority.

## Immutable historical prefix

Add one `hashlessContinuation` object to the same journal. Its header fixes:

- recovery kind `FIRST38_NATIVE_READY_HASHLESS_EXPIRED_V1`;
- the four original identity hashes above;
- `historicalActionCount: 19` and `historicalLiveEntryCount: 10`;
- `historicalPrefixHash` over the canonical original journal identity header, `actions.slice(0, 19)`, and `liveJournal.entries.slice(0, 10)`;
- row 19's persisted materialization, prestate, request, signature-bundle, signed-calldata, simulation, and outer-data hashes;
- the public hashless-state certificate hash;
- original cumulative actual phase cost and unchanged `0.05 ETH` ceiling;
- new continuation proposal hash, new approval hash after human approval, exact ordered action commitments, and cumulative continuation reservation.

New continuation records live inside `hashlessContinuation.actions`. New outer entries append to the existing `liveJournal.entries`. On every load, the decoder recomputes the historical hash from only the fixed slices and rejects any changed historical row, entry, count, order, hash, receipt, or status. Later live-entry growth cannot change the historical hash.

The recovery object is closed to this exact source state and exact continuation IDs. Loading the original approval cannot manufacture continuation authority.

## Hashless-state certificate

The public certificate must bind:

1. Exact hashes of the source revision, executor, CLI adapter, submission module, descriptor, original approval, original journal bytes, and failed command/exit artifacts.
2. Static control-flow proof that broadcast follows signed-envelope validation, hash derivation, live-entry append, and awaited atomic persistence.
3. The 19-action/10-live-entry prefix and absence of any row-19 live entry, intent hash, transaction hash, or receipt.
4. Exact materialization-hash derivation of prestate block `12013857` and canonical block/hash stability.
5. Safe nonce `7`, Delay `3/2`, exact item-2 tuple/fingerprint/createdAt, Safe native balance `1` wei, and absence of the exact Delay lifecycle/state transition.
6. Latest and pending funder nonce classification and canonical sender history through nonce `808`. External shared-funder balance changes are classified as unrelated activity; recipient or funder balance deltas are not used as absence proof.
7. The canonical nonce-809 proof: transaction `0x83923…fe1f5`, its recovered funder, successful receipt/block, six-confirmation depth, target and input-hash mismatch, and unchanged Safe/Delay/asset controlled state. It supplies `NONCE_809_INVALIDATED`. The general verifier must still route exact outer-field equality to `MATCH_FOUND_RECONCILE` and forbid continuation.
8. Canonical expiry at `1793209608`, followed by a sufficiently confirmed current snapshot proving item 2 remains unexecuted and is eligible only for expiry handling.

Independent public providers must agree on canonical blocks, nonce-809 consumption, and controlled state. Pending-only nonce advancement, unused nonce `809`, a discovered matching hash/effect, provider disagreement, reorg, unresolved journal lock/temp file, or changed prefix stops. A discovered match routes to the existing hash reconciliation path, never this continuation. The already-observed passive consumption required no recovery action and grants no new financial authority.

## Closed 22-action continuation

The new artifact contains exactly these stages, fully expanded into 22 ordered descriptors and commitments:

1. `native-queue-ready-hashless-skip`: exact public `skipExpired()` for item 2; Delay `txNonce 2 -> 3`.
2. `native-queue-ready-replacement`: existing Safe nonce `7` queues the same exact one-wei native transfer as Delay item 3; Safe `7 -> 8`, Delay `queueNonce 3 -> 4`.
3. `native-queue-ready-replacement-execute`: after item 3's canonical `createdAt + 120`, exact public execution; Delay `txNonce 3 -> 4`, Safe native balance `1 -> 0`.
4. The original 19 USDC semantic actions, in their original order and with unchanged intended amounts, recipients, selectors, signer roles, rejection meanings, cooldown, expiration, and alert requirements, but with every Safe hash, Safe nonce, Delay item, fingerprint, dependency, state transition, reservation, and timing binding recomputed from the new state.

The source item's `expired-unexecuted` classification belongs to the hashless-state certificate and continuation header. It is not a 23rd executable or rejection-proof action.

The original USDC commitments are retained as superseded planned lineage. They are not executable: the replacement native queue consumes Safe nonce `7`, so old `usdc-base-x` at nonce `7` is stale. The rebased USDC Safe spine starts at nonce `8` and ends at Safe nonce `15`. Its Delay items shift from original `3..5` to `4..6`, and its terminal Delay state becomes `queueNonce=7`, `txNonce=7`.

The group approval enumerates all 22 action IDs and commitments, derivation rules, action caps, total reservation, observer binding, and `maxBroadcastAttempts: 1` per successful broadcast action. There is no fallback action kind or append API.

## Materialization, nonce, and fee rule

For each continuation action that broadcasts, approval permits one append-only final outer-materialization revision immediately before outer signing. It records the current shared-funder nonce, frozen EIP-1559 quote, gas cap/positive estimate, pinned block, and reservation. The nonce must be greater than historical `809` because the six-confirmation invalidation gate precedes continuation. No earlier preflight fixes the later current nonce.

After this final revision:

- nonce drift stops before signing and requires a newly reviewed continuation artifact and approval;
- the action cannot rematerialize, re-sign, or make a second broadcast attempt;
- pre-outer verification does not rerun the provider's fee-selection heuristic and require its suggestion to equal the frozen quote;
- the frozen quote must remain within approved caps, cover canonical base fee plus priority fee, preserve reservation/balance checks, and pass every controlled-state gate;
- an unaffordable quote stops before signing; it is never silently changed.

The interrupted revision's equality-to-fresh-suggestion check could reject a still-valid prepared quote when the heuristic changed. Current revision `653f322` corrects that ordinary-path behavior. The continuation must preserve the corrected frozen-quote rule. The old behavior is statically testable, but it is not evidence of the actual failure cause.

Before proposal creation, private loading, final materialization, outer signing, and broadcast, require the applicable exact Sepolia block, runtimes, topology, policy, signer identities, Safe/Delay nonces, queue tuple/time, balances, raw spend tuples, effective guard window, dependencies, observer readiness, historical prefix, pending journal state, outer nonce, phase accounting, caps, estimate, and shared-funder coverage. Any controlled-state drift stops and requires a new exact artifact and approval.

## Observer continuity

Historical delivery and official acknowledgement captured before the temporary receiver's `2026-10-28T18:51:57Z` expiry remain immutable evidence for their exact historical transactions. Later receiver expiry does not retroactively invalidate them.

Every new alert-producing continuation action requires a receiver/probe identity whose TTL covers proposal review, action execution, six confirmations, delivery, acknowledgement, and keyless confirmation. If the existing receiver lacks that remaining lifetime, create a fresh public readiness/probe record and bind its new observer evidence hash in the continuation proposal before approval. This changes monitoring evidence only; it adds no transaction or policy authority. No old endpoint hash, expired acknowledgement source, startup probe, or historical acknowledgement may stand in for a new action's delivery and acknowledgement.

## Rebased repair and freeze boundary

The old repair design hardcodes a fully terminal 38-row predecessor at Safe nonce `14` and Delay `6/6`. That prerequisite is superseded for this lineage. After the 22-action continuation, the canonical semantic predecessor is:

- the immutable original rows 1-19;
- the hashless certificate and expiry classification;
- the 22 separately approved continuation actions;
- complete native and USDC semantic coverage;
- Safe nonce `15`, Delay `queueNonce=7`, Delay `txNonce=7`.

A later repair proposal must bind this exact lineage and recompute every formerly fixed repair value. Expected shifts are:

- repair queue: Safe nonce `15`, Delay item `7`, then Safe `16`, `queueNonce=8`, `txNonce=7`;
- repair ready execution: Delay `txNonce 7 -> 8`;
- old-secondary rejection and identical new-secondary queue: Safe nonce `16`, item `8`, then Safe `17`, `queueNonce=9`;
- cancellation: Safe nonce `17`, Delay `txNonce -> 9`, Safe `18`;
- freeze: Safe nonce `18 -> 19`.

Every Safe hash, maintenance calldata hash, proof-bound queue fingerprint, policy phase, cap, reservation, dependency, and observer binding must be regenerated and independently reviewed. These expected shifts are design checks, not authority or copied executable values.

The original “38 terminal rows” prerequisite is replaced only for this explicit lineage by semantic coverage plus immutable provenance. No generic predecessor substitution is allowed.

## Reporting and completion

The original proposal status is permanently `INTERRUPTED_HASHLESS_AT_19_OF_38`. The continuation may become `EXPIRED_SOURCE_REBASED_CONTINUATION_COMPLETE` only after all 22 exact actions and their evidence are terminal.

Task 0 remains open until the lineage proves all required native and USDC X/Y, cancellation, expiry, ready execution, observer delivery/acknowledgement, repair/rotation, freeze, balances, topology, regression, and independent review gates. Reports must distinguish original terminal evidence, immutable row 19, the public certificate, superseded original USDC commitments, new continuation actions, and later rebased repair evidence.

No report may call row 19 confirmed, infer its transaction hash or failure cause, count its signed simulation as execution, claim the original FIRST38 complete, or hide the additional skip/requeue lineage.

## Implementation and review boundary

This document authorizes no code, private load, signing, simulation with private material, or broadcast. A later plan may change only the closed ordinary executor/store/CLI, exact descriptors, evidence renderer, call graph, and focused tests. It may not add a generic recovery engine, arbitrary transaction runner, new EOA, redeployment path, contract/dependency change, or private-byte persistence.

Required adversarial proofs include historical-slice mutation, original-approval reuse, any source hash/live entry, unused/pending nonce `809`, wrong-sender consumption, matching nonce-809 reconciliation, six-confirmation different-transaction invalidation, provider disagreement, expiry/state drift, external shared-funder traffic, prefix growth correctness, action-order/commitment mutation, stale USDC hashes, shifted Safe/Delay spine, cumulative budget reset, observer TTL/identity mismatch, heuristic fee changes, post-materialization nonce/base-fee drift, duplicate broadcast, and repair/freeze use of old `14/6/6` assumptions.

A fresh builder check and independent security review must approve this design and the later exact artifact before seeking human authorization for any continuation action.
