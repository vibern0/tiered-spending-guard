# Independent implementation-plan preflight

**Verdict: NOT READY — one blocking observer-time ambiguity.**

The six-task split is otherwise internally consistent with the frozen source, mandatory different nonce-869 invalidation, dynamic current nonce only before one materialization, shared caps, literal 17-action catalog, narrow `getCode` retry, closed repair predecessor, and factual report. The source/canonical evidence boundaries, opaque certificate/proposal/approval flow, atomic store rules, file ownership, focused adversarial tests, call-graph updates, and final root gates cover the stated security properties without adding a signer, EOA, contract, dependency, retry runner, or repair authority.

## Blocking gap: reused observer evidence versus current admission

The spec requires the same receiver/endpoint and existing probe, with no duplicate probe, while Task 2 accepts an `observer` argument and mentions `11640/8040/UTC+chain+TTL`. It does not define what the new proposal must do when the prior observer's immutable `requiredThrough = prior.readyAt + 11640` is already past even though `expiresAt = 1793359577` and the current period deadline still leave enough time. Either naive interpretation is unsafe:

- recomputing `readyAt` or `requiredThrough` would manufacture fresh readiness from the old probe;
- using the past `requiredThrough` as the live admission deadline would either reject a valid reuse or, if ignored without a replacement rule, omit the mandatory current-TTL proof.

Resolve this in the spec and Tasks 2/4 before implementation with these exact semantics:

1. The recycle proposal must copy `source.priorProposal.observer` byte-for-byte. Require exact equality for `kind`, `publicId`, endpoint/startup/probe hashes, independence flag, `readyAt`, workflow schedule, `requiredThrough`, and `expiresAt`. Prefer deriving it from the opaque source; if the public constructor keeps an `observer` parameter, reject anything not deeply equal. Add no observer startup/probe flags and perform no probe side effect.
2. `readyAt` and `requiredThrough` remain historical evidence fields. Require the inherited invariant `requiredThrough == readyAt + 11640`, but permit `requiredThrough` to be earlier than review or execution time. Never rewrite either field and never present them as current readiness.
3. Current admission uses only fresh canonical time, root UTC, the fixed period deadline `D = 1793318400`, and inherited receiver expiry. At every gate compute `remaining = min(D-chainTimestamp, D-rootNow, expiresAt-chainTimestamp, expiresAt-rootNow)` using finite canonical seconds. Review requires `remaining >= 11640`. Initial scenario admission for action 1 requires `remaining >= 8040`. Later scenario admissions require `sum(remaining group budgets)+840`. A queue proposal at private and broadcast gates requires `remaining > currentGroupBudget+840`; other private/broadcast gates require positive remaining. At `D` or receiver expiry, only keyless reconciliation of an already durable new hash is allowed.
4. Task 4 `review` must call the Task 2 review admission check immediately after fresh certificate revalidation, using the certificate's fresh current checkpoint timestamp and the injected root `now`, before emitting review artifacts. Every `submit-one`/`resume-one` load must revalidate current chain/root time before private capability loading; the executor must repeat scenario/private/broadcast checks at their existing boundaries. The proposal hash binds the inherited observer object, while these fresh times remain runtime admission evidence and must not be caller-overridable.
5. Add tests where inherited `requiredThrough` is past but current `remaining` is exactly `11640` (review accepted), `11639` (rejected), exactly `8040` for initial scenario (accepted), and where either root UTC or chain time is the smaller bound. Also reject observer-field mutation, synthetic refreshed times/hashes, duplicate-probe invocation, non-finite time, rollover, and receiver-expiry-only sufficiency after `D`.

These rules preserve the original non-authorizing probe honestly and make current lifetime mandatory without duplicate probing.

## Confirmed plan properties

- **Task 1:** Full old row 3 remains immutable and nonterminal. A canonical different legacy nonce-869 transaction, reconstructed sender, exact tuple, receipt product `1247851 * 100000`, poststate, and at least six confirmations are mandatory. Matching/unused/pending-only evidence routes reconciliation or rejection. Fresh checkpoint equality is `snapshotNonce == latest == pending == N >= 870`; later `M >= N` is allowed only before first materialization.
- **Task 2:** The literal rows 3–19 mapping, new commitments, confirmed bridges, CALL-only policy, terminal `15/7/7`, nine broadcasts/eight read-only proofs, and one-attempt authority are closed. Known charge `124953955544`, remaining aggregate allowance `15955630044456`, new maximum `12080584000000`, gross/inward `11m/11m`, and phase maximum `143241710272986` are additive with no reset, netting, or inflow credit.
- **Task 3:** Old row 3 cannot be selected, resumed, rematerialized, or terminalized. The source prefix and old attachment remain immutable; one new sibling owns all new writes. Current nonce/quote/estimate/block/request/reservation freeze once, and later collision or drift stops permanently. Receipt inclusion precedes observer evidence; late receipts remain honest non-completion evidence.
- **Task 4:** The new-CLI-only pinned `getCode` exception is sufficiently narrow: explicit block number, same provider and parameters, exactly two total reads, one 250 ms delay, first error exactly JSON-RPC `-32001`. It cannot wrap state reads, materialization, simulation, signing, submission, receipts, or broadcast, and wrong returned bytes/reorg/non-`-32001`/second failure stay fatal. Existing canonical rereads and current state/nonce/time checks follow it.
- **Task 5:** The fourth repair predecessor is evidence-only. It preserves original/native/old/stopped/new lineage, requires all 17 new terminal records plus receipts/inclusions/alerts, and cannot inherit financial repair authority from the successor approval.
- **Task 6:** The renderer is pure and separates original unknown, native recovery, old 2-of-19 plus stopped row, new 17, and later repair. It cannot claim old-19 completion, Task 0, browser/hardware, native, audit, merge, or production readiness. Root code/artifact/live gates and a separate later repair approval remain mandatory.

After the observer rule above is inserted into the spec and plan, this preflight has no other blocking gap.

## Observer resolution recheck — READY

The current spec and plan resolve the sole blocking finding exactly:

- the recycle proposal inherits the prior observer byte-for-byte, including the possibly past `requiredThrough = readyAt + 11640`, and rejects mutation, refreshed proof data, new observer flags, or a duplicate probe;
- historical observer timestamps remain evidence only;
- every new-operation admission uses the fresh four-way minimum of period deadline and receiver expiry against both canonical chain time and root UTC;
- review, initial scenario, later groups, queue private/broadcast, and other private/broadcast gates use the required `11640`, `8040`, remaining-groups-plus-`840`, strict group-plus-`840`, and positive-remaining boundaries;
- Task 4 performs fresh review admission after certificate verification and rechecks before private loading/execution, while post-deadline or post-expiry handling is limited to historical operations and exact keyless reconciliation of one already durable new hash, with no new action, alert, private load, or authority;
- Task 5 preserves expired historical lineage but requires separate authority and fresh readiness for any new repair work or alert.

The specified boundary and mutation tests cover the prior ambiguity. **Scoped recheck verdict: READY.**
