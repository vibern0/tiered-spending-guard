# Paused checkpoint — 2026-10-29

**Status: HISTORICAL PAUSED CHECKPOINT; 2026-10-30 RESUME IS NOW BLOCKED.** The user resumed the work; the exact outcome is recorded in the addendum below. Stop live submissions, signing, observer sends and autonomous continuation until a separately authorized successor design exists. Saving this checkpoint to `main` is a progress snapshot, not acceptance of unfinished work. No fresh-successor transaction was broadcast.

**2026-10-30 resumption supplement:** the user explicitly resumed the work, approved the required fresh focused successor, approved raising the aggregate successor-attempt cap from 31 to 51 USDC when required for testing, directed one 20-USDC Circle Ethereum Sepolia faucet request, and confirmed it complete. The faucet receipt is transaction `0x6230026c81cc67ce4aa3cf713838875c7b1d770cbe0f9b48b7b4b3b49f1a59fa` in block `12026817`, hash `0x8bda9049010367bff921be7b89c281c6f30367af9534743463a61859aefe1d83`. The fresh successor preserves the unchanged ETH ceilings and prohibits repair. See [the 2026-10-30 fresh-successor evidence](2026-10-30-usdc-fresh-successor.md). This supplement does not rewrite any historical fact below and is not a claim that a fresh machine approval or live execution already occurred.

**2026-10-31 delayed-tier completion supplement:** the separately approved five-row delayed-tier successor is complete on Sepolia. Three transactions were confirmed with six-confirmation canonical and independent observer evidence; two rejection rows proved with zero signing or broadcast. Terminal state is Safe/Delay `14/7/7`, Safe/funder USDC `0/40,000,000`, and 22 live entries. New/aggregate gross USDC outflow is exactly `31,000,000/51,000,000` units, inward funding is zero, and actual receipt gas is `33,676,608` wei. The stopped delayed-completion row remains hashless `signed-simulated` at outer nonce `916`; its four-row tail remains untouched. Independent terminal verdict: `ACCEPT`, no Critical or Important findings. This closes the narrow X/Y/Z delayed-tier evidence only. Repair, native Safe ERC-4337, audit, mainnet and production readiness remain incomplete and unauthorized.

**Product is not finished.** The current work is ordinary-Safe testnet baseline and recovery tooling needed before native ERC-4337 implementation. The client-only Pimlico wallet is still planned; native Tasks 1–13 have not started. This is security research and a Sepolia prototype, not production software or audited custody infrastructure.

## 2026-10-30 resume outcome — stopped without a broadcast

The user resumed the checkpoint, approved the required fresh focused successor and a `51,000,000`-unit aggregate USDC outflow cap (`31,000,000` new), and supplied 20 additional Sepolia USDC through Circle faucet transaction `0x6230026c81cc67ce4aa3cf713838875c7b1d770cbe0f9b48b7b4b3b49f1a59fa`. A fresh 18-action unsigned proposal, two-provider certificate, observer epoch, exact focused approval and independent artifact review were produced. The proposal hash is `0xcef5b572ea4405539c805ce2469ac738406bea55f1a2a47e25773987dc4cb4b2`; approval hash `0xfe6ce491b7f4a62968144912101e121fc04c58e4ad0c49117fdcd0a0a6650286`. Repair authority remained `NONE`.

The first operator invocation stopped during public preflight on a rate limit with zero broadcasts. The second passed public preflight and signed simulation, then stopped before outer signing because PublicNode no longer retained several old canonical receipts. It durably left `usdc-fresh-successor-prefund-all` at `signed-simulated`, outer nonce `905`, with no intent hash, transaction hash, receipt or live entry. The journal still has exactly 15 successful live records and now hashes to `0x22c3171640cb450024ba6d4964b67ed6e761e75573ac451dffdd3342d6cee07a`.

Commit `0babbcd6819d8ba8a31c7ec86992d812b10d7bd8` fixes future historical live-receipt reconciliation by routing receipt lookup and both six-confirmation canonical block checks through the fixed Tenderly archive client. PublicNode retains live-context nonce, balance, signer/runtime and sole broadcast edges; the fresh adapter retains Thirdweb for current-state and simulation reads. The exact-head gate passed: 654 regular tests, 4 invariant tests, 652 coverage tests with 2 pending, reviewed Slither baseline and rehearsal; normal build compiled 51 Solidity files; backend passed 18 tests in 8 files. Independent verdict: `ACCEPT PATCH; CURRENT EXECUTION BLOCKED`.

The archive fix cannot restore this attempt. The coordinator intentionally rejects a restarted `signed-simulated` row and the fresh selector accepts only `approved`; there is no durable hash for keyless reconciliation. Do not reset or replace the journal, regress the row, bypass the selector, skip prefunding or re-sign under the existing approval. Those operations exceed the one-attempt and no-repair authority. Further live work requires a separately authorized successor design with new exact artifacts, review, approval and execution-head binding. No fresh-successor transaction was broadcast and no USDC left the funder under this resumed attempt.

## Intended product and selected design

One Safe holds the assets. A primary passkey authorizes base spending within X; primary plus a separate contract/passkey secondary authorizes spending up to shared daily Y. Above Y, both approve a full public onchain withdrawal proposal; the mandatory delay Z starts at the queue block. During Z it can be cancelled. Once ready, the user manually executes; public Delay execution is permissionless. A scheduled relayer is future work.

The chosen ERC-4337 design uses a restricted handler, not the stock Safe4337 module as an unrestricted spending route. Ordinary owner execution still passes through the policy guard; Delay is the only enabled module and module execution is guarded. The fallback handler binds the approved EntryPoint, profile, paymaster, context, selectors and exact outer operation. This is the selected solution to the guard/4337 compatibility conflict, but strict bundler and paymaster compatibility has not yet been proved.

A factory creates a locked Safe during validation; execution deploys the remaining bound components and activates that same Safe atomically. Sponsorship pays deployment and operation gas. Failed activation must leave the account locked and recoverable. The target requires no Coinbase wallet, user/app EOA, relay key, Safe prefunding, WalletConnect, or production backend. Pimlico or an equally strict compatible provider is the intended infrastructure. `apps/backend` remains the existing write boundary until native replacement gates pass. The disposable funded EOA used by the ordinary baseline is test infrastructure, not the final product architecture.

Authoritative design: [native Safe spec](../superpowers/specs/2026-10-17-native-safe-4337-design.md). Delivery order: [native implementation plan](../superpowers/plans/2026-10-19-native-safe-4337.md).

## Where implementation stopped

Implementation worktree: `/Users/bernardo/.codex/worktrees/native-safe-4337-implementation/recent-tx-safe-guard`.

Branch before checkpoint publication: `codex/native-safe-4337-implementation`. Last product-code commit: `d572920258ef4f18ad35c81bba65118c311deea4` (`fix: bind recycle repair header`). Documentation/evidence commits after it do not imply a new financial approval.

Current focused [recycle continuation plan](../superpowers/plans/2026-10-29-usdc-recycle-continuation.md), [spec](../superpowers/specs/2026-10-29-usdc-recycle-continuation.md):

| Task | Implemented/tested | Independent review | Remaining |
| --- | --- | --- | --- |
| 1. Closed source/certificate | Implemented; canonical historical receipts, exact source bytes, nonce-869 invalidation, genuine predecessor authority | Accepted after fix | Fresh real read-only proof before any live use |
| 2. Exact 17-action proposal/approval | Implemented; literal catalog, opaque authority, budget/time admission, immutable storage | Accepted after fix | New concrete review/approval artifacts have not been generated |
| 3. Executor/store/adapter | Implemented; atomic leases, monotonic source preservation, permanent nonce-drift stop, receipt inclusion before observer, keyless reconciliation | Accepted after fix | New Sepolia continuation not executed |
| 4. Production public-review/one-action CLI | Implemented; actual loader/state reader/context/store composition; one narrowly bounded pinned `getCode` retry | Accepted | Legitimate fixed-funder successful end-to-end run is still a live-only gate |
| 5. Fourth closed repair predecessor | Implemented through `d572920`; reported 63 passing affected tests | Initial review found two Important issues; fix round 1 committed, **re-review not performed** | Re-review immutable header binding and full adversarial matrix; accept or fix before checking task complete |
| 6. Pure report, docs, final review/gates, root live closeout | **Not implemented** | Not started | All six steps remain open; this handoff is not the required pure renderer |

Task 5 fixes compare every persisted immutable recycle header with the genuine loader proposal/approval and persist/recompute `continuationHeaderHash` on reopen. Tests cover changed checkpoint, minimum nonce, deadline, aggregate charge, reservation, source/proposal/approval, forged/mixed lineage, totals, gas, missing inclusion, and expired admission. Its real repair command composition exercises pre/post rotation state with zero financial callbacks. These are implementation claims awaiting the scoped re-review, not a review acceptance.

## Work already done

- Pinned ordinary Safe/passkey/Delay prerequisite review, simulation, capped deployment/submission, durable journals, canonical receipt/topology verification and Safe creation.
- One-intent submission with exact transaction binding, fee/nonce freeze, durable hash before broadcast, no ambiguous rebroadcast, atomic journal ownership, static sanitized CLI errors, and keyless receipt reconciliation.
- Ordinary native/ERC-20 scenario review and execution catalog; selected native/USDC transfers, rejection proofs, queue/cancel/expiry/ready mechanics and independent monitoring integration.
- A closed repair-to-freeze runner and local tests. This is code availability, not live repair/freeze completion.
- Native hashless recovery certificate/proposal/executor/CLI/report, preserving the stopped historical attempt. Three recovery transactions completed on Sepolia.
- A closed 19-action USDC period successor. Two actual USDC transfer rows completed; its third row stopped after simulation without a transaction hash.
- The new 17-action recycle continuation described above, through Task 5 fix round 1. No dependency version, new Solidity contract or final native AA implementation was added by this continuation.

## Last recorded live state — not fresh RPC readiness

Network: Sepolia `11155111`.

| Component | Public identity |
| --- | --- |
| Safe | `0xd751a1479f49d63DC61E0081B0b4d8c60623D9a6` |
| Guard | `0x91392B9aE9daBa21a1fba3d92fae9fE47a4B48cA` |
| Delay | `0xB8E143098CcCb9935228022173c2c987DF5FD53a` |
| Maintenance | `0x3D20c6c361bdb1970827c9450beeC0e3cD78E654` |
| USDC (6 decimals) | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |

Safe nonce `10`; Delay head/tail `4/4`, no queued item. Safe native `0`; Safe USDC `0`; controlled funder/recipient USDC `20,000,000` units (20 USDC). Raw native period/counters `(1793145600, 10000000000000, 30000000000000)`; USDC `(1793232000, 10000000, 20000000)`. These are last captured controlled facts, not a claim that the shared funder nonce or all chain state remain unchanged.

The authoritative local journal is `.superpowers/sdd/2026-10-19-native-safe-4337/first38-live-journal-2026-10-28.json`. Its frozen raw SHA-256 is `0x3d860cf927ccbdd6cfe45864aa42cd60577f8e7745db046e061613e6d3242dae`. The same vetted public bytes are committed as `test/fixtures/ordinary-usdc-recycle-continuation-source.public.json` under security-core. A fixture is not an operational journal and must never be substituted silently for it.

The [complete recorded action/status inventory](2026-10-29-paused-checkpoint/recorded-action-inventory.json) lists every original, recovery and old USDC row plus all 15 actual transaction hashes; stored `approved` rows do not confer current permission.

There are 15 successful live records: original 10, native recovery 3, old USDC successor 2. The original interruptions and old tails remain incomplete. No `usdcRecycleContinuation` attachment, machine approval, new live attempt, pending hash or repair attachment exists in the frozen journal.

| Confirmed USDC row | Hash | Effect | Actual gas cost (wei) |
| --- | --- | --- | --- |
| Base X | `0x4ea06091a345ee971fbace2f1781a424c6423e1aebe4a0f4898e4a9154092ca8` | Safe nonce 8→9; 10 USDC returned to controlled recipient; counters 10/10 | 86,200,659 |
| Contract-secondary step-up | `0x1fd9630830d96ba5fe3e1d40634f861c8149a3d9f2aa675e81f1359dbcf935b2` | Safe nonce 9→10; another 10 USDC; counters 10/20 | 82,654,885 |

Both have canonical inclusion and six-confirmation/keyless reconciliation evidence. The contract-secondary step-up also has the stock watcher ledger, delivery and official receiver acknowledgement; a base-transfer alert is not claimed.

Old USDC row 3, `recycle-topup-step-up`, is permanently preserved as `signed-simulated`, outer nonce `869`, with no intent hash, transaction hash, receipt or live record. The failure occurred in a public `getCode` verification call (`-32001`) before outer signing. Do not reset, re-sign, resume, relabel or assign another transaction to this hashless row.

Canonical different transaction `0xa81d6df9e9720da44c096b713fdf389fa28ae41aee2224d7f492560ee864781e` consumed nonce 869 at block 12,019,394, gas used `1,247,851`, legacy gas price `100,000` wei, cost `124,785,100,000` wei. It is a different call (`0xa0eb5570` to `0xadb8f835e565ac7e71d2df6cfbd0fc003fa22c27`), not our stopped top-up.

The user identified the shared service as SorteCerta/kettigo recurring task **Support unlimited participants**. A read-only local public-state check matched the exact nonce-869 hash to `cycle-40-close` and earlier nonce-809 hash to `cycle-2-close`. Saved service state reported 30-minute closures and stop time `2026-10-29T16:04:38.978Z`; that is historical metadata, not proof the service is stopped now. The service was not paused, edited or messaged. Confirm current coordination before future signing. Original frozen `UNKNOWN` provenance fields remain unchanged; supplement the source association rather than rewriting history. Keep the conservative nonce-869 gas charge.

## Money, time and authority preserved

No budget is reset by a successor, checkpoint, new session or `main` push.

| Bound/accounting item | Value |
| --- | --- |
| Original shared successor gas ceiling | `16,080,584,000,000` wei |
| Two confirmed old USDC rows | `168,855,544` wei |
| Conservatively charged different nonce 869 | `124,785,100,000` wei |
| Aggregate charged | `124,953,955,544` wei |
| Remaining aggregate gas | `15,955,630,044,456` wei |
| Proposed new 17-action maximum gas reservation | `12,080,584,000,000` wei |
| New gross USDC outflow cap | `11,000,000` units |
| Recycled inward USDC cap, separate from outflow | `11,000,000` units |
| New native transfer principal | `0` |
| Whole-phase cap | `0.05 ETH` (`50,000,000,000,000,000` wei) |
| Maximum phase amount including full proposed new reservation | `143,241,710,272,986` wei |

The new catalog is exactly 17 actions: 9 broadcasts (5 Safe, 2 Delay, 2 inward funding) and 8 read-only rejection proofs. It starts Safe/Delay `10/4/4`, expects terminal `15/7/7`, Safe USDC 0 and controlled recipient USDC 20. It finishes the semantic remainder; it does not make the old physical 19-action journal complete. New funding must not reset onchain counters or credit gas/outflow budgets.

**Exclusive action deadline:** `1793318400` = `2026-10-30T00:00:00Z`. Fixed USDC period: `1793232000`. Existing receiver expires `1793359577` = `2026-10-30T11:26:17Z`. No new same-period action may be admitted at/after the deadline. Review needs at least `11,640` seconds remaining; initial execution at least `8,040`; later group budgets and `840` seconds slack still apply. Chain UTC, root UTC and receiver TTL all constrain the smaller remaining interval.

If resuming too late, **do not refresh dates, roll the period, reissue the old approval, or run the prepared operator scripts unchanged**. Record expiry and design/review a focused successor for the new canonical state and period. Preserve the original authority/caps; obtain additional exact authorization if the replacement leaves the authorized scope. Exact known-hash keyless reconciliation can continue after expiry through its separate nonauthorizing path.

The user had authorized reviewed same-scope successors within original caps without a renewed human pause. That standing scope does not authorize work during this explicit pause, arbitrary retries, altered caps, old-row reuse, a new EOA, or later financial signer repair. The first later repair transaction still requires separate exact capped review and approval.

## Tests and verification

Task-level historical results, preserved in the checkpoint review records:

| Area | Recorded verification |
| --- | --- |
| Certificate | Initial affected suite 37 passing; lineage fix 24 passing; accepted re-review |
| Proposal | 31 affected passing; accepted literal-map/opaque-storage fix re-review |
| Executor/store/default adapter | 89 affected / 14 focused passing; accepted re-review; actual local-chain durable-hash-before-single-broadcast proof |
| Production CLI | 74 affected / 15 focused passing; accepted review; exact public runtime/Delay fixtures hash checked |
| Repair predecessor latest fix | 63 affected passing, reported by implementer; scoped re-review pending |
| Backend | Earlier 18 passing; fresh closeout outcome recorded in verification evidence |

Important evidence boundary: offline production CLI composition uses genuine public Sepolia identities and reaches one materialization/simulation and one controlled signing callback, then an expected fixture-key signing failure with zero broadcasts. A separate real Hardhat chain-31337 adapter/executor test proves valid signing and sole broadcast. This does not prove a successful legitimate-funder end-to-end Sepolia continuation. That remains a root-only live gate after all reviews.

Fresh closeout security/build/backend results, exact tested product HEAD, log hashes, warnings and any skips are recorded in [`2026-10-29-paused-checkpoint/verification.json`](2026-10-29-paused-checkpoint/verification.json). Do not infer full TypeScript compilation success from filtered task diagnostics; repository-wide pre-existing TypeScript errors were reported and no whole-repository `tsc` green claim is made. Local tests and Slither baseline acceptance are not an independent audit or live evidence.

Fresh closeout gate at `d572920`: regular tests **610 passing**, invariants **4 passing**, coverage **606 passing / 2 pending / 2 failing**, overall security command **exit 1**. Both failures are in `ordinary-usdc-recycle-continuation-cli.test.ts`: the default-reader/signing-boundary case and actual-loader/repair-adapter/store composition case fail under coverage with `reviewed package decoded review does not match plan`. Their ordinary runs pass. Root cause is not diagnosed; instrumentation/artifact mismatch is only a hypothesis. Do not weaken production artifact identity checks or silently skip these tests. The command did not reach Slither or rehearsal. Normal artifact restore compiled **51 Solidity files**, exit 0; backend **18 tests / 8 files passing**, exit 0. Full logs and hashes are archived.

## Exact next steps when the user resumes

1. Read `AGENTS.md`, research, security-core plan, signer evaluation, this handoff, current native plan, recycle spec/plan, and archived reviews. Reuse the preserved managed worktree when suitable. Inspect working trees and Git first; fetch `main`. Preserve unrelated local Codacy edits in the primary checkout. Use GPT-5.6 medium subagents if the user's model request remains applicable.
2. Re-review only Task 5 fix diff `bc4db9e27f325e615d6119657b0fb174d9772526..d572920258ef4f18ad35c81bba65118c311deea4` against the two findings in `reviews/task-5-review.md`. Check complete immutable-header binding plus decoder reopen checks and the missing mutation/expiry matrix. Accept or fix, rerun affected tests, then update task checkboxes. No live work for this step.
3. Diagnose the two newly observed coverage failures using the archived log; reproduce, fix at the responsible test/artifact boundary without weakening production checks, and obtain review. Then implement recycle Task 6 Steps 1–4 with TDD: pure `ordinary-scenario-usdc-recycle-continuation-report.ts`, report tests and exact runbook/call-graph/parent evidence pointers. Proposed API: `renderUsdcRecycleContinuationReport(source, {certificate, proposal: continuation, approval}, journal, repairEvidence?)`. No filesystem/RPC/signing or authority generation. Keep original interruption, native 3/22, old USDC 2/19, old stopped row, new 0..17 and repair separate. Expected successful combined evidence is 24 live records and terminal `15/7/7`; never manufacture completion of the old 19 rows.
4. Obtain fresh whole-change independent code review; fix findings. Run `npm --prefix packages/security-core run security:check`, then always `npm --prefix packages/security-core run build` to restore normal artifacts after coverage; run relevant backend checks. Freeze exact tested code HEAD, raw log hashes and clean tracked state. This closeout gate does not satisfy the still-unwritten Task 6 implementation's future gate.
5. Root only: read-only canonical reconciliation from two fixed providers, frozen journal/hash and predecessor authority, old receipt/poststate proofs, exact different nonce-869 proof, pinned runtime/topology/signers/policy, current Safe/Delay/balances/counters, equal latest/pending current funder nonce and canonical block rereads. Resolve shared-service scheduling without messaging or pausing another task unless the user authorizes it. All known hashes must be reconciled before replacement.
6. Reassess period/deadline/receiver readiness. If expired or too little time remains, stop the old action route and create the focused reviewed successor described above. Never weaken admission or shorten real waits. Current old certificate/observer/probe timestamps remain immutable history.
7. Review the unreviewed root operator drafts and their real current inputs independently before use. For a still-valid closed scope, produce actual production unsigned public review/certificate/proposal and raw public proof; independently review the exact artifacts/caps/code binding. Only then persist an exact machine approval under valid standing authority (or obtain new exact user approval where needed). No such new review/proposal/approval exists at this checkpoint.
8. Execute only the reviewed catalog, one action at a time. Before materialization, agreed fresh nonce M≥approved checkpoint N is allowed; after nonce/envelope/quote/block/reservation freeze, drift permanently stops that row. Never financial-retry a frozen/hashless attempt. Persist a known hash before one broadcast. Reconcile canonical receipt, six confirmations and receipt-period inclusion before observer work; retain actual stock watcher delivery and official list/raw acknowledgement; then keylessly confirm. Respect real 120-second ready wait and 120+600=720-second expiry wait. Maintain gross gas/outflow/inward accounting without netting.
9. Publish terminal public report and hash-bound receipt/alert primary evidence; record late/reverted/pending/stopped cases honestly. Full old2+new17 USDC evidence is currently absent. Update actual completed checkboxes only.
10. Prepare and separately review/approve the exact first signer-repair financial transaction. Complete actual replacement deployment/binding/proof, delayed rotation, post-rotation old-reject/new-works/cancel and final freeze evidence/alerts. The repair spine expects terminal `19/9/9`; code/tests alone are insufficient. Validate browser/hardware credential requirements where required; automated WebAuthn is not hardware evidence.
11. Close ordinary Phase One and native Task 0 only with complete canonical X/Y/Z, cancellation, expiry, repair, freeze, independent alert, dependency/runtime and cost evidence plus local and independent gates. Do not start native implementation while this prerequisite is open.
12. Execute the native plan in order, task by task (table below). For every new path update call graph and adversarial tests; for each security dependency change update review and exact lockfile. Public unsigned reproducible plans precede review/signing. No mainnet or production claim.

| Native task | Work and proof still required |
| --- | --- |
| 1 | Contract-only secondary profile; ECDSA absence cannot become an enabled fallback; rotation preserves canonical passkey signer class |
| 2 | Canonical native protocol/UserOperation hashes, pinned EntryPoint/dependencies, bounded full-size encoding and validity |
| 3 | Locked sender deployment and strict validation; reject forbidden validation state access and malformed context |
| 4 | Atomic execution-phase activation; rollback/retry/locked-state proof; actual activation ≤8,000,000 call gas |
| 5 | Guarded everyday/control owner route; exact SafeTx/signers/shared X/Y; deny bypass, arbitrary calls and refunds |
| 6 | Public onchain proposal and manual ready execution; real Z, cancellation and expiry; permissionless Delay compatibility |
| 7 | Delayed AA maintenance/rotation; handler/profile/security weakening cannot bypass delay |
| 8 | Strict provider/bundler/paymaster gate and no-EOA runner; sponsorship/inclusion evidence, no alternate-mempool fallback |
| 9 | Browser passkeys for inner SafeTx and outer operation; exact JSON/DER/size handling, no persisted raw assertions |
| 10 | Public metadata and durable immutable submission state; reload/two-tab/reorg/ambiguous submission recovery |
| 11 | UI wired to real native state, balances, sponsorship and public queue; no demo-only transaction state |
| 12 | Independent monitoring through AA envelopes, canonical event linkage and actual delivery |
| 13 | Static client runtime and backend removal only after end-to-end gates; independent review, PR/CI and merge gates |

## Evidence preservation and local/private boundaries

[`2026-10-29-paused-checkpoint/manifest.json`](2026-10-29-paused-checkpoint/manifest.json) indexes copied public task reports/reviews/briefs, source manifests, budget facts, provenance supplement, verification logs and non-executable operator draft snapshots. Each entry binds original local path, byte length and SHA-256. Archived records are historical, may describe pre-pause next actions, and never override this pause or mint authority.

Large raw public RPC/diagnostic captures and the authoritative journal remain in the preserved local `.superpowers/sdd/` workspaces; the manifest separately pins retained-local evidence. The committed source fixtures and prior public inputs preserve vetted source material. Do not blindly force-add the ignored workspace, restore a test fixture over an operational journal, or treat archived scripts as reviewed runnable tooling. Draft wrappers contain old paths, deadlines and hashes and must be reviewed/rebound before reuse.

Credentials, EOA keys, passkey private material, WebAuthn signing state, receiver URL/token, backend secrets and private observer logs remain outside Git under `/Users/bernardo/.local/share/recent-tx-safe-guard/sepolia/`. No private values are needed in this handoff. The temporary receiver is mandatory independent, nonauthorizing monitoring for live tests; email is not required.

The primary checkout `/Users/bernardo/Documents/github/personal/recent-tx-safe-guard` has unrelated user Codacy work (`.github/instructions/codacy.instructions.md`, `.codacy/`). Preserve it; it is not part of this checkpoint. No automation was created to resume this work. No other service was paused by this task.
