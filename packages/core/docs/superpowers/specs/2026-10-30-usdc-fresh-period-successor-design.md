# Fresh-Period USDC Successor Design

**Status:** selected design. User approved creation and execution of the focused successor and the required 51-USDC aggregate successor-attempt cap on 2026-10-30. Concrete code, certificate, proposal, observer, artifact review, and exact machine approval remain mandatory before private loading or broadcast.

**Authority:** user instruction “do it, i approve it” responding to the requirement for “a fresh, focused successor with new canonical state, observer window, artifact review, and approval,” followed by “if this is required for testing, yes” for the exact increase from 31 to 51 USDC aggregate successor-attempt outflow. The user separately directed and confirmed one 20-USDC Circle Ethereum Sepolia faucet request to the existing funder. Authority covers only the same Sepolia Safe, existing identities, USDC matrix, X/Y/Z policy, unchanged aggregate gas allowance, 51-USDC gross outflow cap, and one-attempt execution rules. It grants no repair, signer replacement, native ERC-4337, mainnet, or production authority.

## Goal

Complete the ordinary-Safe USDC X/Y/Z evidence in the 2026-10-30 canonical spending period. Preserve all old journals and artifacts. Never reuse the expired 2026-10-29 approval window or the permanently stopped nonce-869 row.

## Current immutable lineage

- Original ordinary journal: 19 rows, 10 successful live entries, stopped original row unchanged.
- Native recovery: 3 of 22 rows confirmed; 19 planned rows remain superseded.
- Old USDC successor: first two rows confirmed. `usdc-successor-recycle-topup-step-up` is permanently `signed-simulated` at outer nonce 869 with no intent hash, transaction hash, receipt, or live entry. Rows 4–19 remain approved and superseded.
- Authoritative journal bytes SHA-256: `0x3d860cf927ccbdd6cfe45864aa42cd60577f8e7745db046e061613e6d3242dae`.
- Exactly 15 successful live entries exist. No recycle-continuation attachment, approval, pending hash, or repair attachment exists.
- Old deadline `1793318400` is immutable history. Old observer and probe are not refreshed or reused.
- Circle faucet transaction `0x6230026c81cc67ce4aa3cf713838875c7b1d770cbe0f9b48b7b4b3b49f1a59fa` transferred exactly 20 USDC to the existing funder in Sepolia block `12026817`, block hash `0x8bda9049010367bff921be7b89c281c6f30367af9534743463a61859aefe1d83`. Both fixed providers agreed on receipt and transfer log. Require six confirmations and canonical revalidation before certificate creation.

The two old USDC receipts consumed 20 USDC and advanced the Safe nonce from 8 to 10. They belong to period `1793232000`; they cannot establish current-period X/Y counters. The Safe starts this successor with zero USDC. After the separately authorized faucet receipt, the funder holds 40 USDC.

## Approaches

1. **Selected: closed 18-action fresh-period sibling.** Pre-fund 31 of the funder's 40 USDC once, rerun all current-period transfer semantics, remove both later recycle top-ups, and keep the rejection/queue order. This adds 31 USDC of new gross outflow, for 51 USDC aggregate across successor attempts. Ten broadcasts fit the unchanged remaining gas allowance.
2. Reissue the expired 17-action suffix. Rejected: its first operation assumes old-period `10/20` counters and cannot prove current-period base/step-up behavior.
3. Re-run the old 19-action successor plus an extra initial top-up. Rejected: twelve broadcasts require `16820876000000` wei at approved caps, exceeding the remaining `15955630044456`-wei allowance.
4. Build a generic epoch/retry engine. Rejected: it widens catalog and authority surface.

## Closed 18-action catalog

Use scope `ordinary-usdc-fresh-period-successor-v1` and literal IDs prefixed `usdc-fresh-successor-`:

1. `prefund-all`: fund the Safe with exactly 31 USDC from the existing funder.
2. `base-x`: passkey transfer 10 USDC; establish current period; counters `10/10`.
3. `step-up-contract`: contract-secondary step-up transfer 10 USDC; counters `10/20`.
4. `step-up-ecdsa`: existing ECDSA-secondary step-up transfer 10 USDC; counters `10/30`.
5. `direct-overspend-rejection`.
6. `replay-rejection`, bound to action 2’s exact confirmed envelope.
7. `unsupported-path-rejection`.
8. `queue-cancel`: queue delayed transfer of the remaining 1 USDC.
9. `queue-cancel-early-rejection`.
10. `queue-cancel-action`.
11. `queue-cancelled-execution-rejection`.
12. `queue-expiry`: queue delayed transfer of 1 USDC.
13. `queue-expiry-early-rejection`.
14. `queue-expiry-skip`, after the real 120+600-second window.
15. `queue-expired-execution-rejection`.
16. `queue-execute`: queue delayed transfer of 1 USDC.
17. `queue-execute-early-rejection`.
18. `queue-ready-execute`, after the real 120-second window.

The Safe sends 31 new USDC total. Combined with the two old receipts, aggregate successor-attempt outflow becomes 51 USDC. The funder sends 31 USDC inward once and receives 31 USDC back. Do not net them. Terminal balances are Safe USDC 0 and funder USDC 40. Terminal nonces are Safe 17 and Delay queue/transaction 7/7. Later repair must use a separately reviewed `17/7/7` predecessor and remains unauthorized here.

## Source certificate

Create a new closed source loader from the unchanged authoritative journal and exact existing public manifest files. Bind the original, recovery, old successor certificate/proposal/approval, nonce-869 invalidation receipt, old two USDC receipts, stock watcher delivery, official receiver acknowledgement, and exact faucet receipt/transfer log. Bind the absence of a recycle attachment and repair attachment at creation.

Use both fixed public Sepolia providers. Select `min(headA, headB)-5`; require identical non-null block hash, timestamp, runtime, topology, policy, balances, raw counters, Safe/Delay nonces, funder latest/pending nonce, fee inputs, and canonical historical receipts. Re-read the selected hash after all reads. Stop on mismatch, reorg, missing field, unknown hash, pending journal transaction, unresolved writer file, or controlled-state drift.

Derive effective period only from the agreed snapshot. Require it to exceed `1793232000`. Set exclusive deadline to period plus 86,400 seconds. The certificate records current raw counter tuples separately; stale prior-period USDC counters are expected before action 2 and cannot count as current-period spend.

## Fresh observer

Create one new independent temporary HTTPS receiver after the code gate. Record its endpoint hash, startup evidence hash, exact probe evidence hash, ready time, required-through time, and expiry. Never commit URL or token. Require `requiredThrough = readyAt + 11640`, deadline and expiry beyond required-through, and independent official list/raw retrieval of the probe.

Historical old observer evidence remains bound only to the old step-up receipt. Every new transfer alert requires the stock watcher, six canonical confirmations, successful delivery, and exact official list/raw acknowledgement. Monitoring never authorizes a transaction.

## Proposal, caps, and approval

Recompute every descriptor, Safe hash, queue fingerprint, dependency, state transition, and commitment from the closed catalog and the fresh checkpoint. No imported old action object grants authority.

Caps remain:

- funding gas limit `740292`;
- Safe execution gas limit `2000000`;
- public Delay gas limit `300000`;
- max fee and priority fee `1000000` wei/gas;
- one broadcast attempt per action.

Maximum new reservation is `15340292000000` wei: one funding transaction, seven Safe transactions, and two public Delay transactions. Known old-two-receipt plus nonce-869 charge is `124953955544` wei. Remaining old successor allowance is `15955630044456` wei. Unused allowance after reservation is `615338044456` wei. Maximum whole-phase outlay becomes `146501418272986` wei, below `0.05 ETH`. Recompute and fail closed; never trust these prose values alone.

The proposal uses `authorization: NONE`. After a clean exact code gate and independent review of the concrete certificate, proposal, observer, commitments, caps, and operational wrappers, create one exact machine approval citing both the focused-successor instruction and the explicit 51-USDC aggregate authorization. Do not claim the user reviewed a future hash. Approval grants `repairAuthority: NONE`.

## Execution and storage

Add one append-only sibling attachment. Freeze all predecessor bytes and headers. The decoder and atomic store reject missing, changed, reordered, mixed, detached, or second attachments; header drift; status regression; live-entry mismatch; and mutation outside the selected row plus its exact appended live entry.

Reuse the existing signer loader, state reader, adapter, one-action executor, durable intent-before-broadcast boundary, and keyless exact-hash reconciliation. Extend them only through a closed execution view for this catalog. No generic suffix, start-index, arbitrary action list, retry, EOA, signer, dependency, contract, or WalletConnect path.

The certificate binds the exact stale prior-period raw USDC tuple. Prefund prestate, prefund poststate, and fresh base prestate must retain that tuple byte-for-byte. Historical base receipts remain immutable lineage evidence but are excluded from active-window discovery. Only fresh action 2 establishes the new raw window and counters `10/10`. Every later action requires the new window. This is a literal fresh-successor transition, not a generic stale-counter exception. Validate the prefund poststate before confirming it so a stale-window assumption can never fail only after the broadcast boundary.

Before materialization, a fresh agreed outer nonce at or above the certificate checkpoint may be frozen under the existing bounded nonce-refresh authority. After materialization, any nonce, envelope, quote, block, fee, reservation, or reorg mismatch permanently stops that row. Never rematerialize, re-sign, or rebroadcast. Reconcile a known hash before any new action.

Execution groups are 1–7, 8–11, 12–15, and 16–18 with budgets 2400, 1500, 1800, and 1500 seconds. Preserve review admission 11640, initial execution admission 8040, and reconciliation margin 840 seconds. Check chain time, root UTC, deadline, and observer expiry at review, scenario, private-load, signing, and broadcast boundaries. Never shorten real waits.

## Evidence and reporting

Update the call graph and runbook before live use. A pure renderer must show original 10, native recovery 3, old USDC successor 2 plus its stopped row and superseded tail, fresh successor 0–18, and repair separately. Successful semantic USDC completion has 25 successful live entries total: existing 15 plus ten new broadcasts. Eight read-only proofs add action evidence, not live entries. The renderer must count transaction entries, action evidence, gross outflow, inward funding, gas, periods, receipts, observer evidence, and terminal `17/7/7` state without manufacturing completion of old rows.

Local tests, Slither, artifact review, or this design do not prove live success, audit status, browser/provider readiness, native ERC-4337 readiness, repair authority, mainnet safety, or production readiness.

## Delivery gates

1. Builder check this design.
2. Write focused implementation plan.
3. TDD certificate, proposal, catalog, storage, CLI, adapter/executor integration, reporter, and adversarial mutations.
4. Scoped review after each implementation task; fix Critical and Important findings.
5. Fresh whole-change review.
6. Run full security check, normal artifact restore/build, and relevant backend tests on exact clean HEAD.
7. Provision fresh observer and capture its probe.
8. Generate concrete unsigned artifacts from fresh canonical reads.
9. Independently review exact artifacts and wrappers; create exact machine approval.
10. Execute one selected action per invocation. Reconcile every broadcast receipt and six confirmations before the next action. Require observer delivery and official acknowledgement only for alert-producing action kinds. Read-only proofs have no receipt or observer evidence.
11. Stop immediately on any failed state, observer, period, cap, authority, signer, canonicality, or durable-hash check.
