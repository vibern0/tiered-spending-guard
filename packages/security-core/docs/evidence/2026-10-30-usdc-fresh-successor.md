# Fresh-period USDC successor — implementation evidence

**Status: IMPLEMENTED THROUGH PURE REPORT; NOT YET LIVE-APPROVED OR EXECUTED.** This record describes source verification, proposal, execution boundary, CLI and pure reporting code. It is not a transaction receipt, observer delivery, exact artifact acceptance, repair approval, audit, or production-readiness claim.

## Authority and fixed scope

On 2026-10-30 the user explicitly approved the fresh focused successor and, if required for testing, the increase from 31 to 51 USDC aggregate successor-attempt gross outflow. The user directed a 20-USDC Circle faucet request for Ethereum Sepolia to the existing funder and confirmed completion.

The authority is limited to the existing Sepolia Safe, identities, USDC X/Y/Z matrix, 31 USDC new gross outflow, 51 USDC aggregate old-plus-new outflow, 31 USDC controlled inward funding, unchanged aggregate gas allowance and `0.05 ETH` phase ceiling. Native principal is zero. Repair, signer replacement, a new EOA, WalletConnect, native ERC-4337, mainnet and production remain unauthorized.

## Faucet source evidence

| Field | Value |
| --- | --- |
| Transaction | `0x6230026c81cc67ce4aa3cf713838875c7b1d770cbe0f9b48b7b4b3b49f1a59fa` |
| Block | `12026817` |
| Block hash | `0x8bda9049010367bff921be7b89c281c6f30367af9534743463a61859aefe1d83` |
| Token/network | Circle USDC / Ethereum Sepolia |
| Recipient | existing controlled funder `0xaD4D5cd2Ec5beCdB9608baD4c36F0dBe8b2492Bc` |
| Amount | `20000000` units = 20 USDC |
| Expected post-faucet funder balance | `40000000` units = 40 USDC |

The source verifier requires both fixed providers to agree on the successful receipt, exact transfer, canonical block and post-faucet balance with at least six confirmations. This transfer supplies liquidity only. It is not a successor action and never credits, resets or nets gas, outflow, inward funding or onchain spend counters.

## Closed implementation

The focused design and plan are `docs/superpowers/specs/2026-10-30-usdc-fresh-period-successor-design.md` and `docs/superpowers/plans/2026-10-30-usdc-fresh-period-successor.md`.

| Boundary | Commit | Result |
| --- | --- | --- |
| Design and fixed authority | `6cf6e05` | Fresh-period sibling selected; old lineage and expired recycle route frozen |
| Source and canonical certificate | `7c5b8d1` | Two-provider topology/state/faucet/predecessor verification; opaque certificate |
| Proposal and exact approval type | `b774adf` | Literal 18 actions, fixed caps, fresh-window transition and `repairAuthority: NONE` |
| Journal, executor and adapter | `daeb748` | Append-only sibling, one-attempt durable-hash boundary, keyless known-hash reconciliation |
| Production CLI | `d745397` | Closed `review`, `submit-one`, `resume-one` commands with fixed providers and atomic writer lease |
| Pure report | current Task 6 change | Read-only validation/projection; no filesystem, RPC, signer, simulator, approval construction or broadcaster |

The action catalog has 18 rows: ten broadcasts and eight rejection proofs. It starts from Safe/Delay `10/4/4`, stale prior-period USDC counters, Safe USDC zero and funder USDC 40. Controlled prefunding and the base prestate preserve the stale tuple; the fresh base receipt alone establishes the new window. The intended terminal state is Safe/Delay `17/7/7`, Safe USDC zero, funder USDC 40.

Each financial row permits one final materialization, signing and broadcast attempt. Nonce, envelope, quote, selected block, fee, reservation, state, signer or time drift permanently stops that row. A locally computed hash is persisted before broadcast. Only that exact pending hash may later be reconciled without keys; it is never re-signed or rebroadcast.

## Accounting and report boundary

| Item | Bound |
| --- | ---: |
| Prior confirmed gross USDC outflow | `20000000` units |
| New gross USDC outflow | `31000000` units |
| Aggregate gross USDC outflow | `51000000` units |
| Controlled inward USDC funding | `31000000` units |
| New native principal | `0` wei |
| New gas reservation | `15340292000000` wei |
| Maximum cumulative outlay | `146501418272986` wei |
| Whole-phase ceiling | `50000000000000000` wei |

No inward amount nets or replenishes gross outflow. The pure report can mark the fresh sibling complete only with all 18 exact terminal rows, ten canonical successful fresh receipts, 25 total successful live entries, receipt inclusion inside the new period, exact gas products, zero native principal, kind-specific observer evidence, 31 new and 51 aggregate gross outflow, 31 inward funding, and terminal `17/7/7` with the expected balances.

The report separately preserves: original 10 successful entries and its hashless interruption; native recovery 3; old USDC successor 2; immutable stopped outer nonce 869 row; superseded old/recycle tails; fresh progress; later repair; and Task 0. It never promotes an old row or treats a partial sibling as complete. Later repair is reported as `NOT_AUTHORIZED`.

Adversarial report tests reject late or missing receipt inclusion, mutated gas accounting, native principal, netted accounting, faucet drift, immutable-header drift, altered predecessor rows, noncontiguous progress, live-suffix mismatch and wrong/missing observer evidence.

The scoped Task 6 review initially found two Important report-validation gaps and then one Important purity edge. The implementation now reuses the durable journal lineage checks, requires complete materialization/envelope/proof persistence, authenticates the in-memory source hash against the opaque authority, and uses no stable-file fallback from the renderer. The final scoped re-review result was `ACCEPT`, with no remaining Critical or Important findings. The final focused fresh and legacy report family run recorded 42 passing tests; this focused result is not the full security gate.

## Gates still required before live execution

1. Scoped Task 6 review and focused test rerun.
2. Fresh whole-change independent review with all Critical and Important findings resolved.
3. Full `security:check`, normal artifact restoration/build, backend tests, whitespace check and clean tracked state, with exact HEAD and log hashes recorded.
4. A fresh independent receiver and observer window covering the whole reviewed schedule.
5. Fresh two-provider source proof and unsigned production review artifacts bound to the clean tested HEAD.
6. Independent exact-artifact acceptance and one exact machine approval. Proposal generation alone has `authorization: NONE`.
7. One-action-at-a-time live execution, real waits, six confirmations, receipt/effect validation, required observer delivery and official acknowledgement, then a terminal public report and evidence review.

No transaction has been signed or broadcast under this fresh successor at the time of this record. Repair, browser/hardware proof, ordinary Task 0 closure and native Safe ERC-4337 Tasks 1–13 remain open.
