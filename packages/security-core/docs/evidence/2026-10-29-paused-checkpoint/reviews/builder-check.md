# USDC recycle continuation builder check

**Result: CONCRETE GAPS — correct the spec/plan before Task 1.** The closed 17-action design is implementable, but the current shared interfaces leave six choices to the implementer that affect source authority, nonce freezing, production provider behavior, or repair lineage. These are narrow document corrections; no architecture, Solidity, dependency, financial scope, live action, or old-source mutation is needed.

Reviewed HEAD `3960af94`, the repository instructions and required research/security/signer documents, the new spec and plan, the public source manifest/capture, and the existing certificate/proposal/executor/adapter/store/repair/session/CLI/report code and focused tests. No network, private material, journal mutation, signing, simulation, or broadcast was used.

## 1. Task 1 source API does not bind the authority it receives

Plan line 43 defines `UsdcRecycleContinuationSource` with `prior`, `priorCertificate`, `priorProposal`, and `priorApproval`, but declares `hashUsdcRecycleContinuationSource(journal)`. A journal-only hash cannot bind the full opaque old certificate/proposal/approval supplied to the verifier. It also cannot prove the exact frozen source bytes `3d860c...2dae`; the existing `loadHashlessSourceJournalReadOnly` accepts append-only descendants and keeps its byte snapshot in a private WeakMap. The proposed `UsdcRecycleContinuationPrimaryEvidence` also omits the source manifest even though the spec says the manifest binds the raw public texts.

Minimal correction:

- Change the hash API to `hashUsdcRecycleContinuationSource(source: UsdcRecycleContinuationSource): Hex`. Its public preimage must include the exact frozen original19/native22/old-successor19 attachment and first15 live entries plus the old certificate/proposal/approval hashes and complete old proposal descriptors. Keep `sourceJournalBytesSha256` as a separate fixed certificate fact; do not pretend canonical object hashing proves byte identity.
- Add `manifest: string` to `UsdcRecycleContinuationPrimaryEvidence`, validate the fixed manifest hash/entries, and add CLI flag `--source-manifest` (or explicitly define a fixed sibling-path loader; an implicit unspecified lookup is too easy to vary).
- Name a dedicated stable loader, for example `loadUsdcRecycleContinuationSourceJournalReadOnly(path)`. On initial certificate creation it must require exact byte SHA `3d860c...2dae`, no lock/temp/pending/repair/extra attachment, 15 exact live entries, and the exact old row3/tail. Pinned reverify may load a later file only after the recorded certificate has fixed that byte SHA and must validate the unchanged structural prefix plus the one allowed recycle sibling/live suffix.
- Change Task 1's fixture list to include the vetted source manifest as a tracked test fixture.

This keeps the existing `assertHashlessSourceJournalReadOnlySnapshot` safety checks, but does not rely on its broader append-only acceptance as proof of this exact source.

## 2. Task 2 does not carry checkpoint N into the Task 3 executor

The spec requires a certified current `snapshotNonce = latestNonce = pendingNonce = N`, `N >= 870`, permits a fresh agreed `M >= N` only before materialization, then freezes M. Task 3's execution functions receive `source`, `continuation`, `approval`, `store`, and `context`; they do not receive the certificate. Unless Task 2 copies the checkpoint into the proposal/storage, Task 3 cannot enforce `M >= N` after a fresh-process parse.

Minimal correction:

- Define a certificate field such as `currentCheckpoint: { blockNumber; blockHash; stateHash; snapshotNonce; latestNonce; pendingNonce }`, with all three nonces equal and at least 870.
- Add the exact checkpoint (or at minimum `minimumOuterNonce`, checkpoint block/hash, and certificate hash) to `UsdcRecycleContinuationProposal` and `UsdcRecycleContinuationStorage`; include it in proposal/approval/action commitments.
- Task 3 must enforce `state.outerNonce >= continuation.minimumOuterNonce` and current latest=pending at `pre-private`. The existing final materialization record can freeze actual M, quote, estimate, block, request, and reservation. At `pre-outer`, any nonce/fee/block/request/reservation drift must persist the new row as terminal `stopped`; it must not leave an ambiguous resumable/reselectable row.
- Add fresh-process parse/reopen tests where N is 870, pre-materialization M is greater than N and succeeds, and post-materialization M drift persists `stopped` with zero second sign/broadcast.

## 3. Task 1's tracked fixtures cannot exercise canonical different-869 proof

The Task 1 file list contains the source journal, step-up ledger, and acknowledgement only. The ignored public capture contains the legacy nonce-869 `r/s/v`, exact input, receipt, block, and gas product required for sender reconstruction and `different_869_only`. Unit tests should not depend on `.superpowers` ignored files, and a synthetic transaction cannot prove the fixed recovered funder/envelope.

Minimal correction:

- Add a trimmed tracked fixture such as `test/fixtures/ordinary-usdc-recycle-continuation-nonce869.public.json` containing the canonical legacy envelope, receipt facts, and block facts needed by the provider fixture. Pin its SHA in the test/support loader.
- Include tests for recovered sender, exact hash/nonce/to/value/input/gas/gasPrice, `gasUsed * effectiveGasPrice`, block/hash/status, >=6 confirmations, different stopped-row tuple, matching stopped tuple routing to reconciliation, and provider receipt extras/order being ignored while required typed facts remain strict.
- Keep raw signed transaction material out of the fixture if reconstruction from canonical `r/s/v` fields is sufficient; retain the existing secret/raw-private-key scan.

## 4. Task 4's `getCode` retry boundary needs an exact callable seam

The current production provider delegates runtime checks to `verifyReconstructedPlanAtBlock(client, blockNumber)`. The plan says “two identical reads total,” but does not say whether the budget is per address, per provider, or per CLI invocation, nor how tests avoid a real 250 ms wait. An implementer could accidentally retry every runtime address or wrap all public client calls.

Minimal correction:

- Define one new-CLI-only provider helper/proxy with one retry budget per provider instance: only an explicit `getCode({address, blockNumber})` that throws JSON-RPC code `-32001` may wait exactly 250 ms and repeat the identical tuple once. A second `-32001`, a different error, a block tag, missing block number, returned `0x`, wrong runtime, or any later failing tuple is terminal. No other client method is wrapped.
- Inject only the wait function in tests; keep the production default at 250 ms. Pass the proxy into the real `verifyReconstructedPlanAtBlock`, then perform the normal canonical rereads and current state/nonce/time admission.
- Require the production-composition test to call `runUsdcRecycleContinuationCli` with `createUsdcRecycleContinuationProductionDependencies`, a real atomic store, the real state reader and real execution-context factory. A context stub that merely exposes `inspectReceiptPostState` is insufficient. Capture the adapter input and assert exact nonempty ISO `receiverReadyAt`/`receiverExpiresAt`, one materialization, one sign, and one broadcast despite the two runtime reads.

## 5. Task 5 names a nonexistent file and does not define the real loader route

There is no `ordinary-scenario-repair-runtime.ts`. Runtime dispatch and production dependency assembly live in `ordinary-scenario-repair-session.ts`; mechanical production state is in `ordinary-scenario-repair-adapter.ts`. More importantly, the recycle repair route necessarily includes all old USDC successor flags plus the new recycle flags. The current loader treats the old successor flags as a complete mutually exclusive route, so simply adding five flags will select or reject the wrong lineage.

Minimal correction:

- Replace `ordinary-scenario-repair-runtime.ts` in Task 5's file list with `ordinary-scenario-repair-adapter.ts`; keep `ordinary-scenario-repair-session.ts` as the runtime/CLI composition file.
- Add `loadUsdcRecycleContinuationLineage?` to `RepairCommandDependencies` and define one exact all-or-none flag set: existing hashless/original inputs + existing old-successor inputs + `--source-manifest`, `--source-step-up-ledger`, `--source-step-up-ack`, and the five recycle certificate/proposal/approval flags. Detect the most specific recycle route before the old-successor route and reject every partial/mixed set.
- Extend `RepairPredecessorLineage`, `RepairPredecessorBinding`, journal decode/coexistence checks, and `quoteAction` dependency with literal kind `usdc-recycle-continuation-v1`. Keep actionCount 41, but require semantic order original19 + native3 + old2 + new17, exactly 24 successful live entries, terminal 15/7/7, the 869 charge exactly once, and final dependency `usdc-recycle-continuation-queue-ready-execute`.
- The default-path test should enter through `runRepairCommand(createRepairCommandRuntime(...))`, use the real recycle public loader, real production adapter over the honest local fixture, and the real atomic store through attach/reopen. Parser-only or direct `verifyRepairPredecessor` tests do not cover this seam.

## 6. Task 5 must separate historical observer validity from current submission readiness

The plan's review focus requires a completed recycle suffix to remain valid after the bound receiver expires while every new alert still requires current proof. Current repair code uses the lineage observer for both historical identity and current `observerReadiness`; fresh commands call `assertContinuationObserverFresh`, while `historical` adapter mode returns ready without checking the receiver. The plan needs to state exactly where each mode is legal so an implementer neither rejects valid historical lineage nor uses historical readiness for new work.

Minimal correction:

- Keep the byte-exact recycle observer binding from the approved proposal as historical lineage evidence. Do not add a new probe, endpoint, flag, or observer authority in this continuation.
- Historical parsing, pure reports, store reopen, and reconciliation of exactly one already-durable known hash may proceed after D/receiver expiry without asserting current readiness. They must preserve the original endpoint/ready/expiry and recorded alert/ack bytes.
- Every new repair materialization, private load, signature, submission, and every new alert acknowledgement must use the existing bound observer and pass fresh runtime admission. Use the smaller of chain/UTC time to D and chain/UTC time to receiver expiry: review requires at least 11640 seconds, initial execution at least 8040 seconds, later groups require remaining-groups + 840, and queue private/broadcast requires strictly more than current-group + 840. If the receiver is expired or insufficient, fail before private loading; a later repair needs its separately reviewed authority/design.
- Add tests for expired historical observer still rendering/verifying lineage, expired observer rejecting new work before private loading, and one known-hash keyless resume after D/expiry without enabling a second action or accepting a new alert.

## Task dependency after correction

With these changes the sequence remains Task 1 → 2 → 3 → 4 → 5 → 6. Task 1 supplies an exact byte-branded source, manifest, invalidation evidence, and checkpoint. Task 2 copies the checkpoint into durable authority. Task 3 can then enforce dynamic-before/frozen-after nonce behavior without accepting a certificate parameter. Task 4 proves the real default CLI/provider/store path. Task 5 consumes that exact public loader and separates immutable historical observer evidence from fresh admission for any new work. Task 6 remains a pure renderer.

No further implementation blocker was found in the closed action mapping, the native3 + old2 dependency projection, the 17-row journal sibling, receipt-inclusion persistence, aggregate cap arithmetic, or terminal 15/7/7 repair baseline once the six interfaces above are made explicit.

## Focused amendment recheck

**READY — all six builder gaps are closed in the amended spec/plan.** Focused recheck confirmed:

1. The source API now hashes the complete `UsdcRecycleContinuationSource`, records byte SHA separately, uses a dedicated initial/pinned stable loader, validates a fixed three-file primary manifest, requires `--source-manifest`, and includes tracked prior authority fixtures.
2. `currentCheckpoint` and `minimumOuterNonce` now flow through proposal, approval, storage, and every action commitment; fresh-process execution covers M>N before freeze and permanently unselectable stopped/inert outcomes after proven mismatch or provider exhaustion without touching old row3.
3. The trimmed canonical legacy869 fixture is present with pinned SHA `344220...8b2d`, public r/s/v, receipt, and block facts; Task 1 names it and the prior authority fixtures explicitly.
4. `withOnePinnedGetCodeRetry` now has one consumed retry budget per provider instance/CLI invocation, identical explicit-block parameters, only `-32001`, injectable wait only, and a real default CLI/state/context/atomic-store ISO/sign/broadcast test seam.
5. Task 5 now names the real repair session/adapter files, selects the most-specific all-or-none recycle loader before the old-successor route, and specifies the new predecessor types, coexistence decoder, final dependency, exact 41/24 lineage, and actual runtime→adapter→store test.
6. Historical observer bytes remain immutable and usable only for parsing/report/store reopen/exact known-hash reconciliation; all new operations use fresh min(D/expiry across chain/UTC) admission with the exact review/initial/later/queue thresholds and no new observer probe or flags.

The root public fixture set contains the three-file primary manifest SHA `e1978a...ec7b`, the 11-file source manifest, the exact old prior certificate/proposal/approval texts, and the trimmed nonce869 fixture. No remaining implementability or shared-interface gap was found in these six points. This is a documentation/fixture readiness verdict; Task 1 still owns its RED/GREEN implementation evidence.
