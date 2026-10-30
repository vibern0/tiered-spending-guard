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

The first whole-change review found three further Important issues: the production wrapper had erased the fresh-view discriminator before the frozen-block reorg check; replay rejection persistence and reporting rejected the authenticated fresh-base transaction reference that the executor deliberately recovers; and the journal comparison omitted predecessor identity headers. The fixes preserve the original view through the production reader, stop on a changed materialization block before signing, permit only the exact confirmed fresh-base hash on the replay proof with no new intent/receipt/live row, and hash the complete predecessor header/row/live-prefix projection. Tests cover production reorg with zero sign/broadcast, the monotonic replay lifecycle through store reopen/selection/report, individual header mutations, and mirrored source/journal mutations. Affected fresh and legacy executor/report tests recorded 110 passing before re-review; the whole-change re-review and full gate remain required.

Whole-change re-review of `6cf6e05..57e8989` returned `ACCEPT`, with no remaining Critical or Important findings. The full gate ran against tested product HEAD `57e89898a0d8328d37df162221ab35f841783769` and exited zero: 652 regular tests passing; 4 invariants passing; coverage 650 passing and 2 pending; Slither accepted exactly 11 reviewed baseline findings with no new finding; local rehearsal 1 passing; and `git diff --check` clean. Raw security-gate log: 126823 bytes, SHA-256 `c34e1ae042605799d0a68ad18285313e0dc829a2f0858f0180c900cd41116515`. Normal artifact restoration compiled 51 Solidity files, exit zero, log SHA-256 `36ecbd61a60d0f3287bd95d143e26babdde3f633f075569aa8eb0402c000a717`. Backend: 8 files / 18 tests passing, exit zero, log SHA-256 `44f47145eba00cbc9d24a49119dc7fea15e448f10239e8685c365d9fc815e8c9`. The tracked worktree was clean immediately after these checks. Compiler mutability suggestions and the local Python LibreSSL warning remain non-failing warnings; the two coverage pendings are the existing conditional maintenance cases. Logs remain outside Git under the temporary gate directory and contain no live credentials.

## Gates still required before live execution

1. A fresh independent receiver and observer window covering the whole reviewed schedule.
2. Fresh two-provider source proof and unsigned production review artifacts bound to the clean tested HEAD.
3. Independent exact-artifact acceptance and one exact machine approval. Proposal generation alone has `authorization: NONE`.
4. One-action-at-a-time live execution, real waits, six confirmations, receipt/effect validation, required observer delivery and official acknowledgement, then a terminal public report and evidence review.

No transaction has been signed or broadcast under this fresh successor at the time of this record. Repair, browser/hardware proof, ordinary Task 0 closure and native Safe ERC-4337 Tasks 1–13 remain open.
