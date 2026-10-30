# Fresh-period USDC successor — implementation evidence

**Status: EXACT FOCUSED APPROVAL CREATED; FIRST LIVE ATTEMPT STOPPED BEFORE OUTER SIGNING OR BROADCAST.** This record describes source verification, proposal, execution boundary, CLI, pure reporting code and the exact stopped attempt. It is not a transaction receipt, repair approval, audit, or production-readiness claim.

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

## Exact artifacts and stopped attempt

A fresh independent observer, two-provider source proof, unsigned production review, independent artifact replay and focused machine approval were completed. The immutable artifact hashes are:

| Artifact | Hash |
| --- | --- |
| Certificate | `0x251f6f2e3a7458327eb5bf46c79e52a3476703310c109ef91d4e75cf67fbf57a` |
| Proposal | `0xcef5b572ea4405539c805ce2469ac738406bea55f1a2a47e25773987dc4cb4b2` |
| Approval | `0xfe6ce491b7f4a62968144912101e121fc04c58e4ad0c49117fdcd0a0a6650286` |
| Independent artifact review SHA-256 | `0xf11af6a22e8cfb9b47420e29c9cc8c78662dcfe421c44670415c7b176a79a6ac` |

The first operator invocation stopped on a public rate limit before private work or broadcast. The second passed public preflight and exact signed simulation, then failed before outer signing while reconciling old durable receipts through PublicNode's shorter retained history. It persisted `usdc-fresh-successor-prefund-all` as `signed-simulated`, outer nonce `905`, with no intent hash, transaction hash, receipt or live record. `broadcastAttempts` remained zero and the shared live journal still has 15 successful entries. Its post-attempt SHA-256 is `0x22c3171640cb450024ba6d4964b67ed6e761e75573ac451dffdd3342d6cee07a`.

Commit `0babbcd6819d8ba8a31c7ec86992d812b10d7bd8` routes future durable receipt and six-confirmation canonicality reads through the fixed Tenderly archive client. The exact-head security gate passed 654 regular tests, 4 invariants, 652 coverage tests with 2 pending, the reviewed Slither baseline and rehearsal; normal build compiled 51 Solidity files; backend passed 18 tests in 8 files. Independent review verdict: `ACCEPT PATCH; CURRENT EXECUTION BLOCKED`. The accepted gate hashes are `0xa6ee60f962aec6dd211a5a447a7ed64d0f4a82f534bbbbce6b6501e7a5f8b638`, `0x36ecbd61a60d0f3287bd95d143e26babdde3f633f075569aa8eb0402c000a717`, and `0xd25b362df7eabdd843ffaf4ac11a4ea77f72499a9457fcc8d0543c7d2115fb84` for security, build and backend respectively.

The patch cannot restore the interrupted row. Restart rejects `signed-simulated`, the fresh selector requires `approved`, and no durable hash exists for keyless reconciliation. Resetting/replacing the journal, regressing or skipping the row, bypassing the selector or re-signing under this approval is prohibited. Further live continuation requires a separately authorized successor design, exact review/approval and execution-head binding. Repair, browser/hardware proof, ordinary Task 0 closure and native Safe ERC-4337 Tasks 1–13 remain open.

## Authorized Z-only delayed completion

The user subsequently narrowed the remaining job to the USDC delayed tier and explicitly approved the required testing within the existing bounds. The separately authorized design and plan are `docs/superpowers/specs/2026-10-30-usdc-delayed-tier-completion-design.md` and `docs/superpowers/plans/2026-10-30-usdc-delayed-tier-completion.md`. This authority preserves the same Safe, guard, Delay, USDC, funder, recipient, signers, X/Y/Z policy, `0.05 ETH` phase ceiling, 31-USDC new gross-outflow cap and 51-USDC aggregate cap. It adds no repair, signer change, ECDSA path, X/Y replay, native principal, WalletConnect, mainnet or production authority.

The implementation freezes the stopped fresh sibling exactly and appends one distinct 13-row `usdcDelayedCompletion` sibling. The catalog contains seven possible broadcasts and six zero-broadcast rejection proofs covering direct-above-Y denial, queue/cancel, queue/expiry and queue/ready execution. All delayed tuples transfer exactly 31 USDC so they remain above shared Y despite stale counters. The intended transition is Safe/Delay `10/4/4 → 14/7/7`, with Safe/funder balances `0/40 → 0/40`, 31 USDC controlled inward funding, 31 USDC new gross outward, 51 USDC aggregate gross outward, zero native principal, at most `9340292000000` wei reserved gas and at most `140501418272986` wei cumulative outlay.

Commits `1e632fa` and `77ebd12` add the closed certificate/proposal and append-only executor/CLI/pure report respectively. Focused tests cover predecessor mutation, duplicate attachment, mixed suffix, stale-counter 31-USDC classification, one-row selection, durable-hash reconciliation, zero-broadcast proofs, receipt/state drift and terminal report requirements. This paragraph records implementation only. Fresh observer evidence, exact public artifacts, independent artifact acceptance, exact approval, seven canonical receipts, lifecycle acknowledgements and terminal report remain required before the Z-only continuation can be called complete.
