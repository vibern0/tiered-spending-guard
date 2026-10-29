# Ordinary USDC Period Successor Design

**Status:** approved by the user on 2026-10-29. Reviewed pre-approval bytes SHA-256: `3dd566a468700e94aaabd906b720bd7b6f93ca0f936eb1752cd44a85168cde17`. The standing-authorization amendment below supersedes earlier requirements to ask again before each in-scope successor execution.

**Goal:** Finish the untouched ordinary-Safe USDC baseline on the same Safe in a newly reviewed spending period. Preserve completed native evidence. Keep native ERC-4337 Tasks 1–13 gated.

## Why another epoch is needed

The approved 22-action recovery completed its three native actions on 2026-10-28. All three have successful canonical receipts, at least six confirmations, independent webhook delivery, official receiver acknowledgement, and keyless reconciliation. A two-provider clean-boundary capture is recorded in [`../../evidence/2026-10-28-native-recovery-clean-boundary.json`](../../evidence/2026-10-28-native-recovery-clean-boundary.json).

The remaining 19 actions include 11 broadcasts, eight read-only rejection proofs, a full 720-second expiry wait, and a separate 120-second ready wait. At 23:38:45 UTC, only 1,275 seconds remained before the approved midnight stop. Required canonical checks, signing, six-confirmation gates, observer delivery, acknowledgement, and reconciliation could not credibly fit. The operator stopped after reconciling action 3, with no outstanding queue or pending outer transaction. No USDC-tail attempt was materialized.

The current implementation deliberately binds both the raw native window and effective period to `1793145600`. Extending the wall-clock deadline alone would fail that reviewed gate. Its approved artifact and approval must stay immutable.

## Approaches

1. **Recommended: one closed USDC successor.** Bind the exact completed native prefix, derive a new effective period from actual canonical reads, and independently approve only the untouched 19-action USDC tail. Share existing execution mechanics and preserve one attempt per action. This is the only approach consistent with the reviewed same-Safe, append-only evidence requirements.
2. **Reuse or edit the current approval.** Rejected: it would bypass the explicit cutoff and period binding or rewrite approved evidence.
3. **Redeploy or replay the native matrix.** Rejected: unnecessary new setup and spend, loss of the required same-Safe lineage, and no solution to the approval-window problem.

This recommendation is the operator's proposal, not a claim that the user already approved successor implementation or transactions.

## Exact predecessor

Require the original proposal `0x22770c7944ee289543c10090b3483bdcd87f0d2c193887df4f32916c5782e45f`, unchanged historical 19-action/10-live-entry prefix `0x299d8cf298cf0a905046e4fbe569c44c2329b54207e159db551d41fee1dbb83d`, and original stopped row 19, nonce 809, permanently unchanged.

Require recovery proposal `0x3a92e6d8a383f015f16c1e35746ad84ea31915208c1cc36e9e724a02fcd9f857`, certificate `0x43742e96deb6855d1b2e86b268080892c700f453ffd36da4284de3ec2d252efc`, and approval `0x644bf0b6e9cd4710683717511db665684ff31a86107198282d2364c9816dee26`.

Require exactly these confirmed recovery receipts:

| Action | Transaction | Block |
| --- | --- | --- |
| Skip expired item 2 | `0x0b80a651b416e815930f1664558c29bee5525f496b1410291d40295f85eb11f7` | `12015599` |
| Queue replacement item 3 | `0x5dc85b25ee465159478ddb989dfb7818b9423a7f146510494f8108c3edb0aa3e` | `12015643` |
| Execute replacement item 3 | `0xd99c42d02e46371d4e94cb4ebdb85fd0a5d7127e0fe0399346590e9a9fac10fe` | `12015659` |

The other 19 recovery slots must remain `approved` with no materialization, signature, simulation, intent, transaction, receipt, or evidence fields. Preserve their exact planned commitments as superseded, unexecuted lineage; never mark them complete or executable through the old approval.

Require exactly 13 successful source live entries, no pending/reverted/stopped new attempt, no repair attachment, and no unresolved writer lock/temp file. Recompute a fixed successor-source hash from the complete original header, original 19 records/10 entries, entire frozen recovery attachment, and three appended recovery live entries. Later successor growth cannot change that hash.

Current clean state is Safe nonce `8`, Delay queue/transaction nonces `4/4`, Safe native `0`, Safe USDC `20000000`, funder USDC `0`. Raw native spend remains `(1793145600,10000000000000,30000000000000)`; raw USDC remains `(0,0,0)`. No Delay item is outstanding. The current narrow capture is evidence of this checkpoint, not a successor certificate or future-state promise.

## Fresh public certificate and period

Reverify the exact predecessor through both fixed public providers. Independently verify canonical receipt/effect/confirmation evidence, stored delivery and official acknowledgement bindings, original nonce-809 invalidation, current topology/runtime/policy/signers, balances, raw spend, Safe/Delay nonces, funder latest/pending state, fees, and absence of a pending journal transaction. Do not use a balance delta as proof of no transaction.

Snapshot selection is fixed: read both canonical latest heads, select block number `min(headA,headB)-5`, and require both providers to return the same non-null block hash, timestamp, and controlled-state values at that number. Each provider must have at least six confirmations of that snapshot and each predecessor receipt. Re-read the selected block hash through both providers after all reads; any mismatch, missing field, reorg, or unresolved nonce/pending discrepancy stops. No caller-supplied block, clock, or confirmation override. If the selected confirmed block still belongs to the old period, wait read-only; do not substitute an unconfirmed new-period tip. Current-action preflight and later boundary rechecks remain mandatory after this historical certificate is pinned.

Choose the execution period only from a new agreed canonical snapshot: `anchor + floor((timestamp-anchor)/86400)*86400`. Require it to be later than `1793145600`. A 2026-10-29 snapshot would derive `1793232000`; that value is conditional until observed. No forecast, caller-supplied epoch, local clock override, or retrospective blessing.

Bind the unchanged **raw native tuple** separately from the **effective execution period**. This tail performs no native spending. The guard may retain an old raw native window because no new native transfer updated it. Do not reset it, forge a native operation to refresh it, or require it to equal the new effective period. Preserve and compare its exact captured bytes throughout. Its old spent values are historical raw counters, not effective new-period consumption.

The first actual USDC base receipt establishes the USDC window for this successor. Require base/instant counters `10/10`, then `10/20`, then `10/30` USDC in that same effective period. Top-ups never reset counters. Every applicable pre-private, pre-signature, pre-outer, broadcast, and receipt boundary checks the approved effective period, exact raw tuples, policy and state. A further rollover stops; it grants no new attempt.

Approval binds hard deadline `D = approvedEffectivePeriod + 86400`, exclusive. No override or automatic extension. At proposal generation and financial-review handoff require at least **11,640 seconds** remaining until both D and receiver expiry: 3,600 review + 7,200 execution + 180 confirmations + 60 delivery + 300 acknowledgement + 300 keyless reconciliation. Before the first action require at least **8,040 seconds** remaining. Compare both finite root UTC time and the canonical chain timestamp; the smaller remaining allowance wins. The observer lifetime and exact schedule are content-bound to approval.

Closed scenarios and execution allowances are: instant actions 1–7 (2,400 seconds); cancellation actions 8–12 including its 1-USDC top-up (1,500); expiry actions 13–16 including the full 720-second wait (1,800); ready execution actions 17–19 including the 120-second wait (1,500). Before starting a scenario require the sum of its and all later scenario allowances plus the 840-second reconciliation margin to remain before D and receiver expiry. Queue proposals additionally require the entire current scenario allowance plus that margin. These conservative admission budgets do not promise network progress. Do not start a scenario after its admission gate fails. Once begun, drift or cutoff still forces a stop; never shorten checks or claim that a queue cannot be stranded by network failure.

At or after D, no new materialization, private loading, signing, or broadcast is permitted. Exact already-persisted hashes may be observed and reconciled keylessly after D; accept matrix completion only for receipts included in the approved effective period and acknowledgement/delivery captured within their bound receiver window. An ordinary Safe transaction has no onchain expiry merely because the operator stopped submitting. If a previously broadcast envelope is included late or changes unexpected state, record its actual receipt/effect and stop, never re-sign, label it successful period evidence, or manufacture retry authority. The exact financial review must disclose this submission-versus-inclusion boundary. No contract change is proposed to hide it.

## Closed 19-action successor

Use the exact USDC semantics from recovery actions 4–22, in order: base 10; contract-secondary step-up 10; recycle 10; legacy-secondary step-up 10; overspend/replay/unsupported-path rejection proofs; recycle 1; cancellation queue/early rejection/cancel/cancelled rejection; expiry queue/early rejection/720-second skip/expired rejection; ready queue/early rejection/120-second execution.

Successor IDs are distinct: replace the leading `usdc-` in each of the 19 old semantic IDs with `usdc-successor-`. Freeze that literal private catalog; this rule is documentation, not an exported user-selectable ID transformer. Dependencies, replay source, queue lookup, live entries, repair evidence and reporting use these new IDs. The frozen 22-action attachment retains its old `usdc-*` planned slots. Do not use unscoped fallback matching, silently rename historical entries, or alter a SafeTx solely to change its hash.

Same Safe, funder/recipient, signers, USDC, X/Y, per-transaction limits, policy, Delay, runtime pins, and signature domains. Safe nonce `8→15`; Delay `4/4→7/7`; terminal balances Safe native/USDC `0/0`, funder USDC `20000000`. USDC gross transfer 31 with 11 recycled; no additional faucet claim or native principal.

Recompute all descriptors, before/after state, dependencies, Safe hashes, queue fingerprints, commitments and period bindings from the closed constructor. Some SafeTx hashes may equal prior unexecuted planned hashes because the exact Safe fields and nonces remain equal; do not manufacture a hash difference or treat equality as approval reuse. Fresh successor approval and fresh transient signing remain mandatory.

No exported arbitrary action array, user-selected start index, generic recovery engine, or automatically renewed authorization. Existing original and 22-action entrypoints retain their exact behavior and rollover refusal.

## Journal and authority

Add one closed sibling attachment for this exact 19-action successor in the same atomic journal. The complete predecessor is frozen; only new successor records and appended live entries mutate. The decoder and writer enforce exact counts/order/commitments, a private persisted snapshot, monotonic updates, and the fixed extended source hash on every load/save.

Private mechanical execution may use an explicitly closed view joining verified historical dependencies with the new 19 descriptors. Never search duplicate planned IDs across epochs or select a superseded queue head. Resolve replay only to the successor's confirmed USDC base transaction. Keep the CLI writer lease through the awaited execution promise.

Produce opaque certificate, proposal, and approval capabilities after closed parsing and independent verification. Exact new approval binds source and certificate hashes, effective period, deadline, observer/probe, all 19 commitments, caps, reservation, and `maxBroadcastAttempts=1`. The current approval, original approval, cloned objects, or a structural object grant no successor authority.

Freeze one current outer nonce, quote, estimate, block, and remaining reservation per new broadcast action. Preserve the durable-hash-before-broadcast boundary. No reset, rematerialization, re-signing, nonce/fee refresh, or second attempt after a materialized/hashless interruption. A durable pending hash blocks all new work and supports exact-hash keyless reconciliation only. Timely historical receipt/alert evidence survives a later period or receiver expiry; new signing/broadcast does not.

## Accounting and monitoring

Keep gas caps: seven Safe transactions × `2000000`, two public Delay transactions × `300000`, two funder top-ups × `740292`; eleven possible broadcasts. Both fee ceilings remain `1000000` wei/gas. Maximum additional reservation: `16080584000000` wei (`0.000016080584 ETH`), no native principal.

Completed recovery gas is `26659740` wei; its native principal is 1 wei. Preserve all earlier actual gas and gross principal. With the currently recorded costs, successor maximum cumulative outlay is `147116756317442` wei, below `0.05 ETH`. Independently recompute costs from canonical receipt gas products; never credit unrelated shared-funder inflows or double-count superseded reservations.

Fresh startup/probe and sufficient actual receiver TTL bind the new proposal. Historical receiver acknowledgements remain valid only for their exact historical transactions. New alerts require unmodified independent watcher decoding/scanning, six confirmations, actual successful delivery, and exact official list/raw receiver proof. Raw endpoints, credentials, assertions, signatures, and signed envelopes remain outside repository/logs. A failed official lookup can reconcile the existing delivery read-only; it never authorizes another POST, wallet transaction, or invented capture time.

Historical native monitoring inputs are the five frozen primary public files in [`../../evidence/2026-10-28-native-recovery-primary/manifest.json`](../../evidence/2026-10-28-native-recovery-primary/manifest.json): both exact stock-watcher ledger files and three exact public acknowledgement files. Manifest SHA-256 is `0x96059e1e945b9201e84457f74b98d147c4a6b2d9bc93a2ce8978d4a2425295c6`. Certificate creation must hash and strictly parse these files, bind each target's unique watcher record to its canonical receipt, require no outbox/HTTP-2xx exact payload delivery, and validate exact acknowledgement endpoint/payload/transaction/timestamp/provenance against the existing approved observer window. Recompute payload hashes with the existing canonical notifier encoder, never trust a summary's Boolean. Historical verification checks these frozen root-captured official-API observations; it does not require a new POST or a later retrieval timestamp. This is trusted recorded observation, not a cryptographic receiver attestation. The clean-boundary JSON is derived corroboration and cannot replace missing or inconsistent primary files. Old receiver expiry does not erase timely history.

## Repair and reporting

Repair remains a later, separately reviewed financial group. Add only this closed third verified predecessor: original 19 records plus three completed native recovery records plus 19 completed successor records, with exactly 24 successful live entries. Superseded planned slots are preserved storage, not additional semantic evidence. Terminal Safe/Delay remain `15/7/7`; the existing repair spine remains `19/9/9`.

The new predecessor carries exact raw native/USDC tuples and the new effective execution period separately. Preserve all tuples and require that effective period throughout repair, rather than treating the stale raw native window as the current clock. Do not weaken old predecessor checks. Recompute repair hashes, queues, decoded maintenance, balances, caps, proof domains, accounting, observer binding, and exact approvals from this verified case. No repair signing follows from successor approval.

The public renderer reports original interruption, native recovery `3/22`, superseded untouched planned tail, new successor `0..19/19`, and later repair separately. It must never call the old 22-action proposal complete. Task 0 can close only with the explicit combined semantic lineage, repair/rotation/freeze evidence, full root regressions, and independent review. No native implementation, PR merge readiness, audit, hardware-browser claim, mainnet, or production status follows from this design.

## Delivery gates and builder choices

Implementation requires an approved design, then a focused task plan. Use requested GPT-5.6 medium workers, TDD for lineage/period/encoding/signers/queue/monitoring, scoped reviews, a fresh whole-change review, and root `security:check` before any new live review. Update call graph, runbook, honest evidence renderer, and parent Task-0 pointer. Dependencies and contracts stay unchanged.

Adversarial coverage must include mutated 19/10 and three-native prefixes; any started USDC slot; wrong/extra/reordered source live entries; forged capabilities; old approval/period/signatures; stale native raw versus effective-period confusion; new USDC rollover; duplicate ID/queue-head ambiguity; old replay source; cost/reservation mutation; pending/hashless retries; observer future/expiry/window failures; keyless after-cutoff reconciliation; all three repair predecessor cases; and actual awaited CLI writer exclusion. Use real Safe/guard integrations where policy/crypto behavior matters. Pure callback tests alone cannot establish the live path.

Builder may choose bounded filenames, private helpers, and test organization that reuse the existing modules. Builder may not widen the source states, action catalog, epoch count, runtime/dependency set, financial authority, or retry rules. Missing canonical data or unsupported predecessor stops before private loading. This document authorizes no implementation, private loading, signing, or broadcast.

## 2026-10-29 user authorization amendment

User instruction: “i approve the reviewed successor, but if it fails, create a new successor and execute right away, so it does not expire”. This directly approves implementation and prompt execution of a verified successor, including prompt replacement of a failed or expiring successor, within the same reviewed test scope and remaining aggregate caps. It supersedes the earlier implementation/financial-approval pauses; do not ask again for an unchanged bounded replacement.

Before any signing, still generate a concrete unsigned artifact, independently review its exact commitments, and persist its exact approval hash. Its approval must truthfully cite this standing bounded instruction, not claim the user reviewed a future hash. Preserve the actual authority evidence and every predecessor/failed artifact. Combined successor attempts share the remaining `16080584000000`-wei gas allowance and 31 gross test-USDC outflow allowance; replacements do not replenish either. The `0.05 ETH` whole-phase ceiling remains. Same Safe, existing test identities, recipients, assets, limits, delay, topology, and test semantics only. Later repair remains outside this successor authority.

An expired observer/proposal with no attempt may be replaced after fresh public verification. A known pending hash must reconcile first. A materialized/hashless attempt cannot be reset or retried: classify canonical nonce/envelope/effect evidence, invalidate any old usable envelope where required, and construct a separately recorded closed continuation from actual state. Never reuse a signature, infer failure from missing RPC data, duplicate a completed transfer, or invent a receipt. Implement/review any newly required exact source case when observed; do not build an arbitrary transaction/recovery engine in anticipation. If no safe continuation fits the authorized scope and remaining aggregate caps, report that concrete limit instead of widening authority.
