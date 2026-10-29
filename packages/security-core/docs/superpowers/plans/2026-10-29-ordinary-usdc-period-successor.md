# Ordinary USDC Period Successor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close untouched USDC baseline on same Safe; preserve native recovery; execute promptly under bounded standing authority.

**Architecture:** Closed 19-action sibling epoch, opaque source certificate/proposal/approval, same atomic journal and mechanical executor. Separate stale native raw tuple from canonical effective period. Repair adds only this exact third predecessor.

**Tech Stack:** Existing TypeScript/viem/Hardhat/Safe/Delay. No dependency or Solidity changes.

**Spec:** `packages/security-core/docs/superpowers/specs/2026-10-28-ordinary-usdc-epoch-successor-design.md`; user approved reviewed bytes `3dd566a468700e94aaabd906b720bd7b6f93ca0f936eb1752cd44a85168cde17` plus 2026-10-29 standing-authority amendment. GPT-5.6 medium workers/reviewers. Existing isolated `codex/native-safe-4337-implementation` worktree.

## Global Constraints

- Sepolia11155111; same Safe/identities/topology/assets/recipient/policy. No new EOA, contract, dependency, WalletConnect, generic transaction/recovery runner. Native tasks1–13 still gated.
- Original19/10 prefix `299d8cf2…1dbb83d`, stopped row19/nonce809 unchanged. Recovery proposal `3a92e6d8…f857`, certificate `43742e96…2efc`, approval `644bf0b6…ee26`: first3confirmed, remaining19untouched,13successful live entries. Freeze complete predecessor, including unexecuted planned slots.
- Source Safe8/Delay4/4/native0/USDC20000000/funderUSDC0, native raw `(1793145600,10000000000000,30000000000000)`, USDC raw `(0,0,0)`. No pending/queue/repair/unresolved writer files.
- Snapshot=`min(two canonical latest heads)-5`; both agree hash/timestamp/state; each snapshot/source receipt≥6confirmations; final hash rereads. Effective period derives actual canonical timestamp/86400/anchor, greater than1793145600. No forecasts/clock/chain/endpoint overrides.
- Bind native raw tuple unchanged separately from effective period. USDC base receipt establishes new period; counters10/10→10/20→10/30. Top-ups never reset. Receipt must belong approved period; late inclusion recorded honestly/stops, never matrix success.
- DeadlineD=period+86400 exclusive. Review budget11640s; initial execution8040s. Groups1–7/8–12/13–16/17–19:2400/1500/1800/1500s. Scenario admission=sum remaining group budgets+840; queue admission=full current group+840. Use smaller rootUTC/chain remaining and receiverTTL. AtD no private/materialize/sign/broadcast; known hashes keyless only.
- Literal19 `usdc-successor-*` IDs replace leading `usdc-` in reviewed semantic tail. Safe8→15, Delay4/4→7/7;31grossUSDC,11recycled,terminalSafe0/funder20USDC. No native principal.
- SevenSafe×2000000 +twoDelay×300000 +twoFunding×740292 gas; both fee caps1000000wei. Aggregate successor allowance16080584000000wei; gross31USDC across replacements, not per attempt. Whole phase≤0.05ETH; preserve actual prior gas/principal, never credit unrelated inflows.
- One final materialization/one broadcast attempt/action; durable hash before broadcast; frozen nonce/quote/estimate/block/reservation. No hashless retry/reset/re-sign. Pending blocks new work. Root-only live authority; workers NO private paths/RPC/live/signing/broadcast/authoritative-journal writes.
- Frozen primary observer files+manifest `96059e1e…95c6`; actual canonical notifier payload hashes, exact receipt/delivery/ack bindings, historicaltimely evidence survives expiry. Fresh observer for new alerts, unmodified watcher, full scans,6confirms,officialreceiverack.
- Root constructs exact approval from user's standing bounded instruction only after concrete public artifact+independent review. No repeated human permission for same-scope replacement. Any new exact recovery case needs code/evidence/review; no arbitrary engine. Repair financial group remains separate.
- Required research→security-core plan→signer evaluation; existing approved scope supersessions. TDD security behavior; execution path→callgraph+adversarial tests. Explicit files only; no force-add ignored workspace. Static errors/no private payload output.

## Review Focus

- Duplicate IDs/old planned heads/replay source: new literal IDs + closed lineage; Tasks2–3 tests.
- Stale native raw tuple versus effective period, period-edge receipt: preserve raw, independently gate effective epoch; Tasks1–4 tests.
- Prefix growth/partial atomic state/lease lifetime: fixed extended source hash, detached drafts, awaited CLI; Tasks1/3/4 tests.
- Time/observer skew and scenario exhaustion: exact budgets/windows, no freshness manufactured; Tasks2/4 tests.
- Aggregate budget and mixed repair/report lineage: receipt gas products, no reservation reset or false completion; Tasks2/5/6 tests.

---

## Files / interfaces

New units under `packages/security-core/scripts/live/`: `ordinary-scenario-usdc-successor-{certificate,proposal,cli,report}.ts`. Certificate owns fixed source+historical primary proof+two-provider snapshot. Proposal owns closed catalog/opaque approval/time admission. Existing executor/store/adapter own all mechanics. CLI composes fixed production adapters/lazy signer loader. Repair/report own closed semantic evidence projection. No parallel implementers.

### Task 1: Verified source certificate

**Files:** Create `scripts/live/ordinary-scenario-usdc-successor-certificate.ts`, `test/unit/security/ordinary-usdc-successor-certificate.test.ts`, vetted `test/fixtures/ordinary-usdc-successor-source.public.json`. Modify existing hashless certificate only for narrow read-only reuse; callgraph evidence boundary.

**Interfaces:** Export `UsdcSuccessorSource={original:OrdinaryScenarioProposal,recovery:ExpiredHashlessContinuationProposal,recoveryApproval:ExpiredHashlessContinuationApproval,journal:OrdinaryScenarioJournal}`; `UsdcSuccessorPrimaryEvidence` closed five named raw public file texts+manifest. `UsdcSuccessorCanonicalState` block/chain/identity/topology/policy hashes, Safe/Delay nonces, balances, exact raw native/USDC tuples. `UsdcSuccessorEvidenceProvider` public latest/block/transaction/receipt+gas/state/nonce reads; precise exported types, no authority. Produce opaque `VerifiedUsdcSuccessorCertificate`; `verifyUsdcSuccessorCertificate(source,primary,providers:readonly[UsdcSuccessorEvidenceProvider,UsdcSuccessorEvidenceProvider]):Promise<VerifiedUsdcSuccessorCertificate>`; `reverifyUsdcSuccessorCertificate(serialized,expectedHash,source,primary,providers):Promise<VerifiedUsdcSuccessorCertificate>`; `serializeUsdcSuccessorCertificate(certificate):string`; `hashUsdcSuccessorSource(journal):Hex`; `isVerifiedUsdcSuccessorCertificate(value):value is VerifiedUsdcSuccessorCertificate`.

- [ ] **Step 1: RED tests.** `exact_19_10_plus3_source` rejects any historical/recovery header/receipt/status/cost mutation, any startedUSDC, extra/reorderedlive/pending/repair, forgedobject, lock/temp. `two_provider_period` uses unequal tips→min-5, exact6confirms, state/hash/time disagreement/reorg/missingdata/oldperiod rejection. `raw_native_not_effective` preserves1793145600 while derives1793232000 from actual snapshot. `primary_proofs` validates pinned5filebytes, uniquealert, exactpayloadrecompute/delivery/ack/receipt/windows; missing/summary-only/forgery rejects. `fixed_source_hash` survives later sibling/live growth, not predecessor mutation. `pinned_reverify` restores brand only after exact shape/hash+canonical history; no currentSnapshot regeneration. Public fixture vetted from current durable source with no private shape.
- [ ] **Step 2: Run RED:** `cd packages/security-core && npx hardhat test test/unit/security/ordinary-usdc-successor-certificate.test.ts`; expected missing API/assertion only.
- [ ] **Step 3: Implement exported interfaces.** Reuse existing opaque recovery checks/canonical envelope recovery and monitoring encoder. Verify exact three receipt effects and canonical gas products, source nonces/state, full fixed native binding. Fresh certificate owns both raw tuples and effective period. Reverify pinned snapshot/history separately from later action current-state gates. No caller boolean branding.
- [ ] **Step 4: GREEN:** same command plus existing hashless certificate tests; `git diff --check`.
- [ ] **Step 5: Commit** explicit source/tests/fixture/callgraph, `feat: verify closed USDC successor source`.

### Task 2: Closed catalog, bounded approval, time admission

**Files:** Create `scripts/live/ordinary-scenario-usdc-successor-proposal.ts`, `test/unit/security/ordinary-usdc-successor-proposal.test.ts`; narrowly reuse deterministic USDC builder in old continuation/review, preserving original bytes/behavior.

**Interfaces:** Consume Task1 source/certificate. Export opaque `UsdcSuccessorProposal`, `UsdcSuccessorApproval`, `UsdcSuccessorStorage`; `createUsdcSuccessorProposal({source,certificate,observer:ContinuationObserverBinding,caps:ContinuationActionCaps}):UsdcSuccessorProposal`; `parseUsdcSuccessorProposal(serialized,source,certificate):UsdcSuccessorProposal`; `loadUsdcSuccessorApproval(proposal,serialized,expectedApprovalHash):UsdcSuccessorApproval`; `assertUsdcSuccessorAuthorization(proposal,approval):void`; `attachUsdcSuccessor(journal,proposal,approval):OrdinaryScenarioJournal`; `assertUsdcSuccessorAdmission(proposal,actionId,chainTimestamp:bigint,now:Date,phase:"review"|"scenario"|"private"|"broadcast"):void`. Export fixed schedule/group data needed by CLI. Action fields reuse `ExpiredHashlessContinuationAction` structure with new IDs; scope literal `ordinary-usdc-period-successor-v1`,19actions,1attempt. Approval exact serialized shape identifies `STANDING_BOUNDED_SUCCESSOR_AUTHORIZATION` +authorityEvidenceHash+all concrete bindings/caps; never claims human saw newhash.

- [ ] **Step 1: RED tests.** Exact19IDs/kinds/roles/amounts/nonces/queues/dependencies, oldID/hash/catalog substitution rejects; independently recomputedSafehashes/fingerprints, sameSafehash allowed only with newopaqueapproval. Old/cloned/forged approval rejected. Reservation16080584000000, canonical previous actual cost, aggregate/cumulative/gross bounds; immutable schedule/observer. Exact11640/8040 and closed group budget boundaries, smaller UTC/chain/TTL, nonfinite/future/period rollover, queue-margin andD equality reject; no new signing authority from expiry.
- [ ] **Step 2: Run RED:** `cd packages/security-core && npx hardhat test test/unit/security/ordinary-usdc-successor-proposal.test.ts`.
- [ ] **Step 3: Implement interfaces.** Literal catalog; recompute through shared deterministic builder, not hash patching or exported arbitrary arrays. Content-bound WeakSet/WeakMap capabilities. Exact source/certificate/period/deadline/authority evidence/observer/19commitments/1attempt/caps/reservation approval. Snapshot/freeze values. Preserve old constructors/parsers.
- [ ] **Step 4: GREEN:** new +old continuation/review tests; original fixture hashes unchanged; diffcheck.
- [ ] **Step 5: Commit** explicit files, `feat: bind bounded USDC successor approval`.

### Task 3: Same-journal execution and real adapter

**Files:** Modify `scripts/live/ordinary-scenario-executor.ts`, `ordinary-scenario-adapter.ts`; create `test/unit/security/ordinary-usdc-successor-executor.test.ts`, `test/integration/ordinary-usdc-successor-adapter.test.ts`; callgraph.

**Interfaces:** Consume Tasks1–2. Add optional closed `usdcPeriodSuccessor:UsdcSuccessorStorage` journal attachment; add execution view case `usdc-period-successor-v1` carrying verified source/proposal/approval. Export `createUsdcSuccessorExecutionView(source,successor,approval?):OrdinaryScenarioExecutionView`; `selectUsdcSuccessorSubmissionAction(source,successor,approval,journal):OrdinaryScenarioActionScope`; `executeUsdcSuccessorAction(source,successor,approval,store,context):Promise<OrdinaryScenarioExecutionResult>`. Existing public ordinary/22 APIs unchanged. Reuse private mechanical executor; no exported arbitrary action runner.

- [ ] **Step 1: RED tests.** Real atomic store preserves full19+old22+13live source; detached-draft mutation/partial writes/regression/header removal/oldentrypoints mutating frozen prefix reject. DistinctIDs resolve exact successor dependencies/queue receipts/replay/newheads; oldplannedUSDC neverselected. Pre-private/pre-outer raw native staysold while effective epoch current; allUSDC/postreceipt epoch checks, lateinclusion actualreceipt+non-successfulstop. Time admission before any materialization/private/sign/broadcast; one frozennonce/quote/estimate/cost and durablehash→1broadcast; hashlessno retry; exactknownhashresume keyless afterD. Actual Safe/guard crypto/USDC queue/cancel/expiry/ready path through shared adapter; honest local domain, no permissive mock or synthetic Sepolia branding.
- [ ] **Step 2: Run RED:** `cd packages/security-core && npx hardhat test test/unit/security/ordinary-usdc-successor-executor.test.ts test/integration/ordinary-usdc-successor-adapter.test.ts`.
- [ ] **Step 3: Implement interfaces.** Same atomic writer/private persisted snapshot/monotonic storage; fixed source projection and closed view. Separate required rawnative tuple/effective period internally, preserving strict old window checks. Existing pending/envelope/receipt/observer mechanics, exact successor base replay. Check actual receipt period before matrix confirmation; preserve known receipt iflate/failure. Source first3 record/certificate history excluded from new timing decisions except immutable dependencies. Confirmation forwards bound receiverready/expiry.
- [ ] **Step 4: GREEN:** new +affected original/hashless executor/adapter/store suites; record actual integration scope and limitations; diffcheck.
- [ ] **Step 5: Commit** explicit source/tests/callgraph, `feat: execute USDC successor in immutable journal`.

### Task 4: Fixed production CLI and public/live boundary

**Files:** Create `scripts/live/ordinary-scenario-usdc-successor-cli.ts`, `test/unit/security/ordinary-usdc-successor-cli.test.ts`; narrow existing production harness/adapter changes only when required; callgraph.

**Interfaces:** `USDC_SUCCESSOR_COMMANDS=["review","submit-one","resume-one"]`; `loadUsdcSuccessorPublicInputs(args,providers):Promise<{source,certificate,successor,approval?}>`; `createUsdcSuccessorProductionDependencies(repository,argv)`; `runUsdcSuccessorCli(argv,deps)`; `main(argv?,options?)`. Fixed endpoints reuse existing PUBLIC_CURRENT_RPC/PUBLIC_ARCHIVE_RPC, actual canonical/topology/proof adapters. Exact flags for sourcejournal, originalreport/hash trio, recoverycertificate/proposal/approval+hashes, primarybundlemanifest, successorcertificate/proposal/approval+hashes, samejournal, freshobserverstartup/probe and optional ledger/ack. Define closed parser once; no arbitrary endpoint/chain/time/profile flags.

- [ ] **Step 1: RED tests.** Public review no private/sign/simulation/broadcast; real production adapters reconstruct source and canonical runtime/topology/receipts, not artifactbooleans. Exact original+recovery+new bindings restore across freshprocess/progress. Before-context stale/time/cap/primary/epoch/source failures. Lazy action-required credentials after allpublicgates. `resume-one` rejects privateenv and onlyonependinghash, no broadcast. Actual CLI+atomicstore deferredread excludes secondwriter until awaited settlement; static output/error secret-canary failures; freshobserver schedule11640/8040 and precise forwarding. Observer can scan newIDs without decoder changes.
- [ ] **Step 2: Run RED:** `cd packages/security-core && npx hardhat test test/unit/security/ordinary-usdc-successor-cli.test.ts`.
- [ ] **Step 3: Implement interfaces.** Compose existing real harness/signers/metadata/readers, narrow reusable factories rather than copy submission code. Wire actual two-provider Task1 adapter+strict topology verification. `review` unsignedpublic; `submit-one` exactstandingauthority-file+freshpublicpreflight+samejournallease+awaitedexecutor; `resume-one` historicalcertificate+pendingreceipt only/lazykeylesscontext. Preserve boundobserver rawprivateURL outsidepublicfile; static errors. Production no root/private access inworker.
- [ ] **Step 4: GREEN:** new +affected CLI/adapter/public-output suites; diffcheck. Report runnable exact commands/flags to root.
- [ ] **Step 5: Commit** explicit files, `feat: expose verified USDC successor CLI`.

### Task 5: Third repair predecessor

**Files:** Modify `scripts/live/ordinary-scenario-repair.ts`, `ordinary-scenario-repair-adapter.ts`, `ordinary-scenario-repair-session.ts`; affected `test/unit/security/ordinary-scenario-repair*.test.ts`, actual repair integration where needed; callgraph.

**Interfaces:** Add closed `usdc-period-successor-v1` to existing `verifyRepairPredecessor`/creation/group/session lineage union. Source includes opaque verified recovery + successor and their approvals. Require exact19original+3native+19successor semantic evidence,24successful live entries; frozenoldplanned19 not terminal evidence. Produce verified15/7/7 predecessor and19/9/9 repairspine. Export shared publicloader fromTask4; explicit complete-set successor flags only. No arbitrary nonce/count caller arithmetic.

- [ ] **Step 1: RED tests.** Reject partial/mixed/forged/orphan successor, mutated frozenoldattachment/nativeprefix/sourcecommitments, wrong41semantic/24live order/receipt product/cost/principal, no repair authority from standing successor approval. Existing two routes unchanged. Newcase rawnativeold/usdcnew/effectiveperiodseparate and all repairs maintain bindings; oldcase strict nativewindow unchanged. Receiverready/expiry and expiredknownhashkeyless forwarding; actual newcase adapter/runtime composition before/afterrotation matches15/7/7→19/9/9.
- [ ] **Step 2: Run RED:** `cd packages/security-core && npx hardhat test test/unit/security/ordinary-scenario-repair.test.ts test/unit/security/ordinary-scenario-repair-runtime.test.ts`; add precise actual integration command after inspecting existing suite name.
- [ ] **Step 3: Implement closed third case.** Share strict canonical receipt-accounting mechanics; derive existing repair catalog from verified case and exact new lastdependencyID. Preserve old cases and separate repair approvals. No repair private load/sign/live worker action.
- [ ] **Step 4: GREEN:** affected repair suites +existing actualSafe integration; diffcheck. Report real coverage, not mocked blockchain claims.
- [ ] **Step 5: Commit** explicit files, `feat: verify repair after USDC period successor`.

### Task 6: Honest report, runbook, root verification and execution

**Files:** Create `scripts/live/ordinary-scenario-usdc-successor-report.ts`, `test/unit/security/ordinary-usdc-successor-report.test.ts`; update runbook/callgraph/parentTask0 evidencepointer. Root owns livepublic artifacts/authority/journal and rootverification, not worker.

**Interfaces:** `renderUsdcSuccessorReport(source,successor,journal,repairEvidence?):Readonly<Record<string,unknown>>`; pure persisted-evidence projection reusing strict brand/receipt/catalog/repair checks, noRPC/private/live. State originalinterrupted/native3of22/old19superseded/new0..19/laterrepair/Task0open separately. Root execution policy cites2026-10-29 standingauthority, aggregatecost ledger, exact unsigned artifact+independentreview+exactmachineapproval.

- [ ] **Step 1: RED tests.** Partial/pending/stopped/reverted/wrongheaders/receiptcost/catalog/forgedrepaircontext nevercomplete; old22nevercomplete;19newterminal+24live only, eachreceiptperiod+observerbinding; repair requires valid opaque stage/context; noRPCorauthority calls.
- [ ] **Step 2: Run RED:** `cd packages/security-core && npx hardhat test test/unit/security/ordinary-usdc-successor-report.test.ts`.
- [ ] **Step 3: Implement pure report/docs.** Exact CLI flags/standingauthorityscope/deadlineadmission/manualexecution; fixedsourcehistory/publicprimaryfiles/repairseparate. Preserve originalfailurecauseUNKNOWN; no fabricated hardware/browser/native/audit/PRgreen claims.
- [ ] **Step 4: GREEN+commit:** new +affected report suites; `git diff --check`; explicitfilescommit `docs: report USDC successor evidence honestly`.
- [ ] **Step 5: Root final gates:** fresh whole-change independent review, accepted findings fixed; `npm --prefix packages/security-core run security:check`; backendtests if impacted/existingTask0gate. Restore normal artifacts aftercoverage. Record exacthead/exits/counts; no unsupported TypeScript/Codacy claim. No nativeTask1/merge until fullTask0liveevidence.
- [ ] **Step 6: Root public review+execute:** read actual currenttwo-providerstate, freshmonitorstartup/probe/TTL, unsignedcertificate/19proposal/caps, independentexactartifactreview. Persiststandingauthorityevidence+exactapprovalhash withoutanotherhumanpause. Execute oneaction atatime with6confirms/stockobserver/officialack/keylessresume, waits120/720 unshortened, aggregatebudgetunchanged. If failed/expiring, preserveattempt, reconcile/invalidate canonicalstate, generate/review exactboundedreplacement and continue as soon safe; never reset/retryambiguousoldattempt or auto-refillcaps. Close actual19lineage onlywithreceipts/effects/alerts. Laterrepair separateauthority/gates; parentgoal remainsactive.
