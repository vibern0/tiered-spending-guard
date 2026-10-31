# Sepolia testnet runbook

**Execution paused by the user on 2026-10-29.** Read the [current checkpoint](../evidence/2026-10-29-paused-checkpoint.md) before any operational command. The prior USDC deadline is 2026-10-30 00:00 UTC; do not roll dates or reuse stale authority. Task 5 re-review, Task 6 report/final gates, two coverage failures, remaining live USDC tests and separate repair approval are open. No autonomous continuation.

This runbook is for the single-owner security-core prototype on Sepolia only (`chainId 11155111`). It is security research, not a production wallet. Never use it for mainnet, production funds, or live broadcast from the planner. The examples are redacted, not deployed, and contain no secrets. The approved 2026-10-09 plan permits a separate live runner after local gates and decoded deployment review; unsigned planners remain non-broadcasting.

The active prototype has exactly one Safe owner: the configured primary passkey. Contract and ECDSA secondary signers are guard-only identities. It has no recovery owner, recovery signer adapter, fallback handler, extra module, or auxiliary custody Safe. Base transfers require the primary passkey. Step-up transfers, delayed proposals, cancellation/freeze, and delayed maintenance require the primary plus exactly one configured secondary signer over the exact Safe transaction. The loss of the primary or all configured secondary factors is an accepted testnet availability risk: funds may become unavailable until a future delayed recovery design is separately written, reviewed, implemented, and rehearsed. Direct Burner NFC/libhalo support remains a future spike and is out of scope for this runbook.

## Ordinary scenario coordinator core

The repository contains a narrow coordinator core for the currently reviewed ordinary-scenario predecessor prefix. The review JSON remains non-authorizing. Execution requires independently supplied exact package, raw artifact, proposal, and approval hashes plus an opaque approval naming the ordered action commitments and only the allowed outer nonce, fee, gas, and canonical-time derivations.

The core revalidates exact public topology/runtime/observer evidence and controlled Safe, Delay, USDC, counter, queue, dependency, fee, reserve, and period state before private callbacks. It persists materialization and signed-simulation hashes before outer signing, then uses one locked atomic journal with the existing `submitLiveIntent` hash-before-broadcast boundary. A restart can reconcile one exact pending hash; an interrupted pre-broadcast attempt or canonical revert is terminal for automatic execution. Raw signed calldata is transient and is never written to the journal.

The repository now contains the pre-repair adapter primitives and a three-mode one-action CLI boundary. The regenerated unsigned package proposes a 2,000,000 gas ceiling and is explicitly not gas-proven. No scenario approval exists. Do not treat local tests, proposal creation, or approval parsing as permission to sign, simulate with private assertions, or broadcast. Repair/rotation descendants and final freeze remain outside this slice.

For an authorized action, `submit-one` may exit with the action still `outer-pending` after canonical inclusion when independent delivery evidence is absent. Run the watcher separately with the proposer closed, retrieve a sanitized public receiver acknowledgement through the official receiver API, then use `resume-one`. Resume mode reconciles only the original journaled hash with signing and broadcast disabled. The temporary receiver expires at 2026-10-28 18:51:57 UTC; expiry, absent activity evidence, mismatched payloads, or pending outbox state stop confirmation.

## Hard stop rules

Stop immediately and do not sign, broadcast, deposit funds, or continue rehearsal if any read-only check differs from the reviewed plan. A mismatch in any of the following is a hard failure:

- chain, Safe address, or exactly one Safe owner `[primary passkey]`;
- threshold, zero fallback handler, transaction guard, or module guard;
- enabled Safe modules (Delay must be the only one);
- guard or Delay address, runtime bytecode hash, signer identity, policy hash, or dependency hash;
- X/Y asset policy, per-transaction caps, token/recipient allowlist, counter values, period anchor, or 86,400-second period;
- Delay owner, avatar, target, only enabled upstream module, cooldown Z, or expiration;
- queue transaction fingerprint, setup transaction hash, or independently observed notification;
- any unexpected approval, message-signing, batch, delegate-call, fallback, module, owner, recovery, or signer-repair path.

The verifier must fail closed on missing RPC reads, missing bytecode, malformed data, unknown addresses, unavailable counters, or an unexpected extra field that changes the reviewed call graph. Monitoring and UI classification are evidence only; neither authorizes execution.

## Inputs and outputs

`config/sepolia.example.json` is the public, redacted planner and verifier configuration. The verifier does not consume a deployment-plan output as its configuration: it consumes this config plus a separately collected observed snapshot. Replace example addresses and hashes only after a separate human review; never add private keys, passkey material, Burner PINs, seed phrases, provider tokens, private RPC credentials, or direct NFC/libhalo secrets.

The observed snapshot must include the recomputed `policyHash`, nested Safe singleton and Delay dependency address/code-hash records, Safe-to-singleton and Delay-to-dependency topology bindings, exact recipient arrays, and one unique counter record for every configured token. Counter values must be canonical decimal strings and remain within the configured per-token daily limits.

Generate an unsigned, reproducible plan:

```sh
npx ts-node scripts/plan-deployment.ts config/sepolia.example.json /tmp/sepolia-plan.json
```

Review every decoded setup call against `docs/security/call-graph.md` before any human-controlled signing workflow. The output must say `"unsigned": true` and `"broadcast": false`. This script never signs or broadcasts.

Create the public review package:

```sh
npm run package:sepolia-rehearsal -- config/sepolia.example.json /tmp/recent-tx-safe-guard-issue-5-rehearsal
```

The package directory contains only `unsigned-plan.json`, `decoded-review.json`, `public-manifest.json`, and `expected-evidence-hashes.json`. It must not contain signatures, private keys, RPC URLs, passkey material, Burner PINs, broadcast instructions, or recovery fields. Treat the package as input to human review; it is not an instruction to submit any transaction.

For the concrete ordinary-Safe review, use `config/sepolia.ordinary-review.json` plus the two private external credential target paths with the approved loader:

```sh
npm run prepare:sepolia-vault-review -- config/sepolia.ordinary-review.json /absolute/private/primary-passkey.json /absolute/private/secondary-passkey.json /tmp/sepolia-vault-review
```

This command first records one block number and hash, then pins supported runtime, signer-binding, token-metadata, nonce, balance, `eth_estimateGas`, and exact-limit `eth_call` reads to that block. Before packaging it rechecks the block hash plus latest nonce and balance and fails closed on drift. Only collector-produced evidence for the exact branded plan is accepted; cloned evidence and incomplete or mismatched dependency/signer/component/asset checklists are rejected. It emits an artifact-backed package with status `AWAITING_HUMAN_REVIEW`; its fee and gas values are proposals until a human approves the decoded package. Safe creation stays `deferred-until-prerequisites`: after the four prerequisite receipts and bindings are reconciled, re-estimate the exact factory transaction and require it to fit every recorded cap before signing. A successful command is read-only evidence, not permission to sign or broadcast.

Verify using a separately collected public read-only snapshot:

```sh
npx ts-node scripts/verify-deployment.ts config/sepolia.example.json /tmp/sepolia-observed.json
```

Archive the unsigned plan, decoded review, public manifest, expected evidence hashes, observed snapshot, verification report, report hash, block number, and source revision as the evidence bundle. Redact logs before sharing.

## Bootstrap live runner

`npm run live -- <plan|preflight|submit|resume|evidence>` is a separate Sepolia-only bootstrap tool. It loads an owner-only funding key and locally generated P-256 credentials from private regular files outside the repository. `plan`, `preflight`, `resume`, and `evidence` never broadcast; `submit` additionally requires `LIVE_SUBMIT=YES`. Its durable journal records an intent before broadcast and resumes by receipt rather than rebroadcasting an uncertain transaction.

The current allowlist is intentionally narrow: a zero-value self-transfer from the funder, or the exact `SafeWebAuthnSignerFactory.createSigner` call for either local credential against the pinned Daimo verifier. It is evidence for the signer/bootstrap boundary only. It must reject Safe, guard, Delay, ERC-20, deployment, and arbitrary transaction intents until a dedicated vault deployment/scenario runner has an exact reviewed plan verifier. Do not use it to infer any vault policy result.

## Atomic setup and exact Safe submission

Prerequisite deployment is separate from Safe creation. First deploy the reviewed setup helper, guard, Delay, and maintenance instances at the deterministic nonce sequence. Then re-read their runtime hashes and constructor/configuration bindings. Only after `assertSafeCreationReady` proves the deployer nonce is exactly `startingNonce + 4` may the official Safe proxy factory transaction be prepared.

The successful prerequisite DAG remains fixed forever at CREATE nonces 673–676. Safe creation is a distinct factory CREATE2 stage, so unrelated later funder calls may advance its EOA nonce without changing the reviewed Safe address or initializer. Generate its unsigned package with `npm run safe:create` and explicit public signer-binding profile, original package/proof/journal paths, current equal latest/pending nonce, and reviewed gas/fee caps. The command pins a block, rechecks the four canonical receipts and component bindings, estimates and exact-limit simulates only `vault-safe`, and writes `safe-creation-review.json`. Its default path cannot sign. Review the package hash and decoded factory tuple separately; the four-prerequisite approval does not authorize it. Exact `LIVE_SUBMIT=YES` and `VAULT_SAFE_REVIEW_PACKAGE_HASH` are required for the one-intent path. After inclusion it requires post-setup prerequisites and the complete topology verifier, then stops before funding or scenarios.

The exact Safe submission is the factory call whose initializer is `setup([primary passkey], 1, setupHelper, setupData, 0, 0, 0, 0)`. The setup helper checks the sole-owner topology and performs the atomic setup while `address(this)` is the final Safe: configure assets, configure both secondary signer slots, set maintenance, install the same guard in both guard slots, enable Delay as the only Safe module, and enable the Safe as Delay's only upstream module. Any decoded submission with a different owner, nonzero fallback handler, extra module, unlisted delegatecall, or mismatched Delay owner/avatar/target is a hard stop.

## Delay execution, cancellation/freeze, and signer repair

Delay execution happens only after the queued fingerprint has cooled down and before expiration. The relayer may call `executeNextTx`, but it has no authority beyond executing the already queued tuple. The module guard admits only the configured Delay module and supported `CALL` transfer or delayed-maintenance tuple.

Cancellation/freeze is available to the primary passkey plus exactly one configured secondary signer through the exact Delay nonce-advance cancellation or guard `freeze()` calls. Operators must enumerate the ordered queue items invalidated by a nonce advance before review. Signer repair is delayed through `GuardReplacementMaintenance.replaceSigner`: primary repair swaps the sole Safe owner and guard identity atomically; secondary repair changes guard configuration only. Use sentinel previousOwner for primary and zero for secondary. Direct guard signer repair and role-2 repair are forbidden.

## Read-only ordinary scenario review

Use `collectOrdinaryScenarioReview` only as a library with the exact reviewed plan and a separately verified post-setup topology result. Supply the durable five-receipt proof, public signer capability descriptors, proposed caps, and an RPC adapter whose supported reads are pinned to one block. The collector rechecks that block hash and every mutable value before returning. It never signs, broadcasts, estimates a signed envelope, reads a credential or provider secret, or authorizes the output.

Generate the concrete partial package with `npm run scenario:review`. The command defaults to public Sepolia current-state and archive endpoints, reconstructs the original reviewed plan rather than trusting parsed JSON, and creates a new output directory. `SEPOLIA_RPC_URL`, `SEPOLIA_ARCHIVE_RPC_URL`, `ORDINARY_SCENARIO_OBSERVER`, and `ORDINARY_SCENARIO_OUTPUT` may select equivalent public read inputs and output paths. Do not set `LIVE_SUBMIT`, `PRIVATE_KEY`, or `VAULT_FUNDING_KEY_PATH`; the command rejects them. A successful `BLOCKED` exit is a reviewable partial package, not execution approval.

The native and USDC inventory requirement is cumulative: base X plus the two secondary-form step-up rows consume exactly shared Y=30, then the one ready delayed transfer consumes 1, for 31 total matrix units. The delayed USDC row is a 1-USDC transaction after remaining immediate allowance is zero. With the controlled recipient equal to the funder, 20 initial USDC is sufficient: fund 20, reconcile the two 10-USDC returns, top up 10 before the ECDSA row, reconcile its return, then top up 1 before the delayed row. Gross funding remains 31. The top-ups do not reset guard counters or consume Safe/Delay nonces. Funding value, all native Safe transfer principal, prerequisite/Safe actual cost, and proposed gas reservations all count against the 0.05 Sepolia ETH phase ceiling. The outer Safe execution value of zero never removes the inner native transfer value from this accounting.

Treat any blocker in the report as unresolved input, without substituting another token, signer, observer, or repair target. The repair descriptor may expose only the canonical factory-derived replacement's public coordinates, verifier bitmap, address, and undeployed status. Factory creation is a separate capped funder intent. The WebAuthn proof remains private until later authorized signing; until it exists, repair calldata, its queue tuple, Safe hash, and Delay execution remain `BLOCKED_INPUT`. After rotation, prove the old secondary rejects the unchanged post-Y queue Safe transaction, the new secondary queues it, cancel that item, and only then review final freeze.

The repair continuation uses the same atomic ordinary journal and embedded live-intent ledger. Begin only when all 38 predecessor actions have terminal canonical evidence and the exact Safe 14 / Delay 6 / 6 state. Review signer creation separately. The proof-bound queue must run in one process: authorize proof preparation, load and sign the replacement credential once, validate ERC-1271 at the pinned block, publish only decoded fields and hashes, wait no more than 600000 ms for the exact group approval, revalidate state, then sign and simulate the exact Safe call. Never write the assertion, maintenance calldata, Safe signatures, or signed outer bytes into the public proposal/journal. A timeout or interruption before a durable transaction hash abandons that proof and approval. After canonical queue inclusion, recover the exact maintenance bytes from canonical public transaction/queue evidence without loading the replacement credential.

The replacement assertion becomes public when the exact repair queue is included onchain. The independent observer may then retain the canonical `TransactionAdded.data` as part of its existing full-action alert/archive evidence so the queue fingerprint remains reproducible. That data must come from the verified canonical receipt; never copy it back into review artifacts, the coordinator/signing journal, or browser persistence, and never place unsubmitted or privately supplied authorizer bytes in observer output. The pre-publication no-raw-assertion boundary remains strict; no secrecy is claimed after canonical publication.

Run these through `npm run scenario:repair -- <command>`. The closed command names are `creation-review`, `creation-submit`, `prepare-queue`, `tail-submit-one`, and `tail-resume-one`. Creation review accepts only the original report/artifact/package/proposal/approval identities, the terminal journal, and an optional output path. It constructs the fixed public replacement descriptor and factory quote internally, validates every terminal predecessor receipt through the archive client, and reads the pinned current state and rotation-aware topology itself; caller-supplied state, evidence, quote, endpoints, profiles, or verifier inputs are rejected. Creation submission additionally takes the saved creation identity and exact creation approval. Queue preparation takes the saved creation identity, original identities, terminal journal, prepare-only authorization, sanitized group output, and an optional approval wait no greater than 600000 ms; maintenance and one-wei recipient are fixed in code, and the later exact group approval arrives as one stdin JSON line containing only `path` and `hash`. Tail commands take the original and creation identities, journal, exact group identity, and observer ledger/receiver acknowledgement when the reviewed action has an alert. The group approval commits to its verified predecessor's exact queue nonce and fingerprint: nonce 6 for the original terminal-38 route or nonce 7 for the completed hashless route, plus `CANONICAL_RECEIPT_CREATED_AT_ONLY`, cooldown 120, and expiry 600. Concrete ready/expiry timestamps are derived only from the canonically verified repair-queue receipt and are checked before materialization and before outer signing. Each submitted tail action receives an exact-result simulation and fresh bounded gas estimate at both gates. Each invocation handles at most one reviewed action and rejects unknown or duplicate input. Review mode uses public artifacts only. Submission modes require their separate exact approval and explicit `LIVE_SUBMIT=YES`; resume mode rejects every private authority input and its signing/broadcast methods throw. These commands do not automatically advance to the next repair action. The live checklist remains incomplete until canonical Sepolia receipts, rotation-aware topology evidence, old-secondary rejection, receiver acknowledgements for alerting rows, cancellation, and frozen-state proofs have been independently reviewed.

## Interrupted FIRST38 hashless continuation

The original FIRST38 package is permanently `INTERRUPTED_HASHLESS_AT_19_OF_38`: rows 1–18 have terminal evidence, row 19 remains the immutable `signed-simulated` nonce-809 record with no transaction hash or inferred failure cause, and the original USDC tail is superseded. The public certificate proves the separately observed EIP-155-protected legacy nonce-809 consumption and unchanged expired queue state. It does not authorize the 22-action continuation. `ordinary-scenario-hashless-report.ts` renders only verified persisted public evidence; it performs no RPC read and cannot close Task 0.

Run public review directly from `packages/security-core` with the exact closed flags:

```sh
npx tsx scripts/live/ordinary-scenario-hashless-continuation-cli.ts review \
  --source-journal /absolute/public/first38-journal.json \
  --original-report /absolute/public/original-report.json \
  --original-package-hash 0x... \
  --original-artifact-hash 0x... \
  --original-proposal-hash 0x... \
  --source-artifact /absolute/public/hashless-state.json \
  --source-artifact-hash 0x... \
  --observer-startup /absolute/public/fresh-observer-startup.json \
  --observer-probe /absolute/public/fresh-observer-probe.json
```

Review requires the two fixed public providers, the immutable `actions.slice(0,19)` and `liveJournal.entries.slice(0,10)`, a certificate with at least six confirmations, and a new independent observer whose remaining lifetime covers review, execution, six confirmations, delivery, acknowledgement, and keyless confirmation. The fixed schedule is `3600/960/180/60/300/300` seconds for those six stages, for an exact `5400` seconds total. The action caps are `740292/2000000/300000` gas for funding, Safe execution, and public Delay execution, with `1000000` wei maximum fee and priority-fee ceilings. The later repair ready-execution cap remains the distinct `1000000` gas documented in the repair section; it does not change the FIRST38 public Delay cap. Stop on the native window rollover at `1793145600`, any controlled-state drift, provider disagreement, or receiver lifetime shortfall. The emitted certificate and 22-action proposal are unsigned and have `authorization: "NONE"`.

After separate exact proposal and capped financial approval, one action may be submitted with:

```sh
LIVE_SUBMIT=YES npx tsx scripts/live/ordinary-scenario-hashless-continuation-cli.ts submit-one \
  --source-journal /absolute/public/first38-journal.json \
  --journal /absolute/public/first38-journal.json \
  --original-report /absolute/public/original-report.json \
  --original-package-hash 0x... \
  --original-artifact-hash 0x... \
  --original-proposal-hash 0x... \
  --certificate /absolute/public/recorded-certificate.json \
  --certificate-hash 0x... \
  --proposal /absolute/public/continuation-proposal.json \
  --approval /absolute/public/continuation-approval.json \
  --approval-hash 0x... \
  --observer-ledger /absolute/public/observer-ledger.json \
  --receiver-ack /absolute/public/receiver-ack.json
```

`--journal` must be the same path string as `--source-journal`. Each broadcast action receives one final materialization only, with nonce greater than 809 and frozen gas estimate, block, fees, and reservation before private signing. A new action requires the same fresh bound observer expiry; the shared confirmation validator receives that exact expiry rather than the historical ordinary receiver default. The original approval cannot authorize any continuation action.

If one exact hash is already durable and pending, reconcile it without private authority or rebroadcast:

```sh
npx tsx scripts/live/ordinary-scenario-hashless-continuation-cli.ts resume-one \
  --source-journal /absolute/public/first38-journal.json \
  --journal /absolute/public/first38-journal.json \
  --original-report /absolute/public/original-report.json \
  --original-package-hash 0x... \
  --original-artifact-hash 0x... \
  --original-proposal-hash 0x... \
  --certificate /absolute/public/recorded-certificate.json \
  --certificate-hash 0x... \
  --proposal /absolute/public/continuation-proposal.json \
  --approval /absolute/public/continuation-approval.json \
  --approval-hash 0x... \
  --observer-ledger /absolute/public/observer-ledger.json \
  --receiver-ack /absolute/public/receiver-ack.json
```

A timely delivery and official acknowledgement remain historical evidence after expiry, but expiry never permits a new write. `EXPIRED_SOURCE_REBASED_CONTINUATION_COMPLETE` requires all 22 exact terminal records, canonical receipts/evidence, and the ordered live catalog, ending at Safe/Delay `15/7/7`. Later repair is a separate approval lineage. Every repair command on this route additionally requires the complete flag set `--continuation-certificate`, `--continuation-certificate-hash`, `--continuation-proposal`, `--continuation-approval`, and `--continuation-approval-hash`; repair finishes at `19/9/9`. A ready delayed withdrawal is executed manually with its already reviewed exact `executeNextTx` tuple after cooldown and before expiry. There is no watcher, scheduler, or relayer authorization in this continuation.

## Ordinary USDC period successor

The old 22-action recovery stays permanently incomplete: its first three native actions are confirmed and its remaining 19 `usdc-*` records stay untouched three-field `approved` records. The same-Safe successor uses the distinct literal `usdc-successor-*` catalog for those 19 USDC semantics. Its renderer reports the original interruption, native recovery `3/22`, superseded old tail, successor progress `0..19/19`, later repair, and Task 0 separately. It preserves the original row-19 failure cause as unknown and makes no hardware, browser, native ERC-4337, audit, pull-request, mainnet, or production-readiness claim.

Generate the concrete unsigned artifact from `packages/security-core` with the exact Task-4 review flags:

```sh
npx tsx scripts/live/ordinary-scenario-usdc-successor-cli.ts review \
  --source-journal /absolute/public/first38-journal.json \
  --original-report /absolute/public/original-report.json \
  --original-package-hash 0x... \
  --original-artifact-hash 0x... \
  --original-proposal-hash 0x... \
  --recovery-certificate /absolute/public/recovery-certificate.json \
  --recovery-certificate-hash 0x... \
  --recovery-proposal /absolute/public/recovery-proposal.json \
  --recovery-approval /absolute/public/recovery-approval.json \
  --recovery-approval-hash 0x... \
  --primary-bundle-manifest /absolute/public/native-recovery-primary/manifest.json \
  --observer-startup /absolute/public/successor-observer-startup.json \
  --observer-probe /absolute/public/successor-observer-probe.json
```

This command uses the two fixed public providers, selects `min(latestA, latestB)-5`, requires equal block hash/timestamp/controlled state and at least six confirmations, and re-reads the selected block hash after all reads. The effective period comes only from that agreed canonical timestamp and must be later than `1793145600`. The raw native tuple remains separately fixed at `(1793145600,10000000000000,30000000000000)`; no native operation refreshes it. The first successful USDC base receipt establishes the approved effective window, followed by counters `10/10`, `10/20`, and `10/30`. The existing 733-read, approximately 94-second root diagnostic is diagnostic evidence only; it is neither this fresh live proposal nor an approval.

The artifact receives an independent exact review before a machine approval is persisted. The approval truthfully cites the user's standing 2026-10-29 bounded successor instruction; it does not claim the user reviewed a future hash, and unchanged in-scope replacements require no repeated human pause. The same Safe, identities, topology, asset, recipient, limits, delays, and 19 test semantics remain fixed. All replacements share, rather than replenish, `16080584000000` wei of successor gas allowance, `31000000` units of Safe USDC outflow, and the distinct `11000000` units of inward recycled USDC. The whole phase remains at or below `0.05 ETH`. Later repair has separate financial authority.

Review admission requires at least 11,640 seconds until both the exclusive period deadline and receiver expiry. Initial execution requires at least 8,040 seconds. Scenario budgets are actions 1–7: 2,400 seconds; 8–12: 1,500; 13–16: 1,800; and 17–19: 1,500. Before a scenario, require its allowance plus all later allowances and the 840-second reconciliation margin; a queue proposal additionally requires its entire current-scenario allowance plus that margin. Use the smaller remaining horizon from root UTC, canonical chain time, and receiver lifetime. The 120-second ready wait and 720-second expiry wait are never shortened. The eight rejection rows are canonical read-only `eth_call` proofs, not broadcasts; an early-rejection proof is pinned to the queue-creation block even if collected later in wall-clock time. The other eleven rows are the only possible broadcasts.

After the exact reviewed machine approval exists, submit at most one action per invocation:

```sh
LIVE_SUBMIT=YES npx tsx scripts/live/ordinary-scenario-usdc-successor-cli.ts submit-one \
  --source-journal /absolute/public/first38-journal.json \
  --journal /absolute/public/first38-journal.json \
  --original-report /absolute/public/original-report.json \
  --original-package-hash 0x... \
  --original-artifact-hash 0x... \
  --original-proposal-hash 0x... \
  --recovery-certificate /absolute/public/recovery-certificate.json \
  --recovery-certificate-hash 0x... \
  --recovery-proposal /absolute/public/recovery-proposal.json \
  --recovery-approval /absolute/public/recovery-approval.json \
  --recovery-approval-hash 0x... \
  --primary-bundle-manifest /absolute/public/native-recovery-primary/manifest.json \
  --successor-certificate /absolute/public/successor-certificate.json \
  --successor-certificate-hash 0x... \
  --successor-proposal /absolute/public/successor-proposal.json \
  --successor-approval /absolute/public/successor-approval.json \
  --successor-approval-hash 0x... \
  --observer-ledger /absolute/public/successor-observer-ledger.json \
  --receiver-ack /absolute/public/successor-receiver-ack.json
```

`--journal` must be the same path string as `--source-journal`. Before fresh materialization and again before outer signing, the funder's current `latest` and `pending` transaction counts must agree and equal the selected canonical block nonce. That agreed value is the frozen outer nonce; any disagreement stops before the next private boundary. Each broadcast action has one final materialization and one broadcast attempt with a frozen quote, estimate, block, fees, and reservation. Its locally computed transaction hash is durable before broadcast. A pending hash blocks new work; reconcile only that exact hash with `resume-one` and the same execution flags, without fresh submission gates, `LIVE_SUBMIT`, private inputs, signing, or rebroadcast. There is no reset, rematerialization, re-signing, fee/nonce refresh, or hashless retry. A late receipt is recorded with its actual effect and stops the successor when inclusion falls outside the approved period; it is never relabelled as successful period evidence. Successor and repair reports label target topology as `expectedTerminalCounters`; terminal status still depends on the authenticated receipt and effect evidence.

Every new alert uses the fresh unmodified watcher, full scans, six confirmations, actual successful delivery, and exact official receiver acknowledgement. The frozen five-file native primary bundle and manifest hash `0x96059e1e945b9201e84457f74b98d147c4a6b2d9bc93a2ce8978d4a2425295c6` remain historical evidence only. Timely historical acknowledgement survives later expiry; failed official lookup permits read-only reconciliation only.

After all 19 successor actions are terminal, repair commands must provide the complete unmixed successor lineage flags: `--recovery-certificate`, `--recovery-certificate-hash`, `--recovery-proposal`, `--recovery-approval`, `--recovery-approval-hash`, `--primary-bundle-manifest`, `--successor-certificate`, `--successor-certificate-hash`, `--successor-proposal`, `--successor-approval`, and `--successor-approval-hash`. Do not combine them with the older five `--continuation-*` flags. Successor standing authority proves predecessor lineage only and grants no repair approval, signing, or spending authority.

Task 0 remains open after continuation completion. Closure still requires the complete native and USDC X/Y, cancellation, expiry, ready execution, independent delivery/acknowledgement, repair/rotation, freeze, balances, topology, regression, and independent-review matrix. It also requires the root-owned full security gate and public artifact review. Do not start native Task 1 or describe the ordinary baseline as complete from this renderer or its focused tests.

## USDC delayed-tier completion CLI

The fresh-period attempt is permanently stopped before outer signing or broadcast: `usdc-fresh-successor-prefund-all` stays `signed-simulated` at outer nonce 905 with no durable transaction hash, and its remaining 17 rows stay approved. Do not reset, remove, retry, promote or reinterpret that row. The only permitted successor is the append-only `usdc-delayed-completion-v1` sibling, which tests Z only; it does not repeat X/Y and carries no repair authority.

Run `ordinary-scenario-usdc-delayed-completion-cli.ts review` with the complete original, recovery, old-successor, recycle-source and stopped-fresh public lineage flags required by the CLI, the same physical source journal, and a fresh `--observer-startup` / `--observer-probe` pair. Review performs no private callback or broadcast. It requires both fixed providers to agree on Safe/Delay `10/4/4`, empty queue, Safe/funder USDC `0/40`, stale USDC counters, and a consumed outer nonce beyond 905. The observer must have at least 3,600 seconds from readiness and at least 3,600 seconds remaining at review. The exclusive USDC period deadline must cover the same schedule.

After independent replay accepts the exact certificate and unsigned proposal, create an exact opaque approval bound to their hashes. Then use `submit-one` with the same lineage flags plus `--delayed-{certificate,certificate-hash,proposal,approval,approval-hash}`, exact `LIVE_SUBMIT=YES`, one `--journal` path equal to `--source-journal`, and the observer ledger/receiver acknowledgement. Each invocation selects at most one row. If it persists an `outer-pending` hash, invoke `resume-one` with the same public flags, no `LIVE_SUBMIT`, and no private authority; it can reconcile only that hash and cannot sign or rebroadcast.

The fixed catalog is: 31-USDC prefund; direct-above-Y rejection; queue/cancel with early and cancelled rejection proofs; queue/expiry with early and expired rejection proofs; and queue/ready execution with an early rejection proof. Exactly seven rows may broadcast. The other six are canonical read-only proofs and must record zero materialization, signing and broadcast. Preserve the real 120-second cooldown and 720-second expiry; never shorten or simulate wall-clock timing. Confirm each broadcast to six blocks and obtain the required independent delivery and official acknowledgement before advancing. Completion requires 13 terminal rows, seven new canonical receipts, 22 total live entries, Safe/Delay `14/7/7`, Safe/funder USDC `0/40`, 31 USDC inward, 31 new and 51 aggregate gross outward, and accepted lifecycle alerts. Repair, native AA and production claims remain open.

### Delayed-tier five-row successor

The delayed-completion run stopped at row 9 before outer signing: `usdc-delayed-completion-queue-expiry-skip` remains `signed-simulated` at outer nonce 916 with no intent hash, transaction hash, receipt, or live entry. Rows 10–13 remain approved. Do not reset, retry, promote, or reinterpret any of those rows. The approved `ordinary-usdc-delayed-tier-successor-v1` sibling starts from the exact public state Safe/Delay `13/6/5`, active expired queue nonce 5, and Safe/funder USDC `31/9`.

Run `ordinary-scenario-usdc-delayed-successor-cli.ts review` with every public predecessor flag accepted by the delayed-completion CLI, the same physical `--source-journal` / `--journal` path, and a new `--observer-startup` / `--observer-probe` pair. Review performs no private callback, signing, approval, or broadcast. Both fixed providers must agree on the pinned predecessor, expired queue, balances, topology, policy, and one clean current funder nonce. Independently replay the emitted certificate and five-row unsigned proposal before creating the exact opaque approval.

After approval, use `submit-one` with the same predecessor flags plus `--delayed-successor-certificate`, `--delayed-successor-certificate-hash`, `--delayed-successor-proposal`, `--delayed-successor-approval`, `--delayed-successor-approval-hash`, observer ledger, receiver acknowledgement, and exact `LIVE_SUBMIT=YES`. Each invocation advances at most one row. Use `resume-one` only for one persisted `outer-pending` successor envelope, without `LIVE_SUBMIT` or credentials; it reconciles the exact journal-bound nonce/hash and cannot sign or rebroadcast.

The five literal rows are: skip expired queue 5; prove its execution rejects; queue the same 31-USDC primary-plus-contract-secondary delayed transfer; prove early execution rejects; execute after the real 120-second cooldown. Only rows 1, 3, and 5 broadcast. Confirm each receipt to six blocks and require the proposal-bound independent delivery and official acknowledgement before advancing. Completion is exactly 22 live entries and Safe/Delay `14/7/7`, with Safe/funder USDC `0/40`, no new funding, 31 USDC successor gross outflow, unchanged 51-USDC aggregate cap, at most `2600000000000` wei reservation, and no repair authority.

## USDC recycle continuation CLI

The stopped successor row 3 and its 16-row tail remain immutable. The recycle CLI restores the old successor lineage with the same `--source-journal`, original/recovery flags, `--primary-bundle-manifest`, and `--successor-{certificate,certificate-hash,proposal,approval,approval-hash}` flags described above. It additionally requires `--source-manifest`, `--source-step-up-ledger`, and `--source-step-up-ack` for the fixed three-file historical watcher evidence. `review` reuses the receiver already bound in the old proposal; it accepts no startup/probe, RPC, chain, clock, profile, cap, or action override and emits no authority, key load, signing, financial write, or broadcast.

After independent review and the root-owned exact machine approval, `submit-one` additionally requires `--recycle-certificate`, `--recycle-certificate-hash`, `--recycle-proposal`, `--recycle-approval`, `--recycle-approval-hash`, `--journal`, `--observer-ledger`, and `--receiver-ack`, with `--journal` exactly equal to `--source-journal` and exact `LIVE_SUBMIT=YES`. Each invocation selects only the next approved new row. It freezes one current nonce, quote, estimate, block, fee pair, and reservation, persists a locally computed hash before its sole broadcast, and stops permanently on pre-outer drift. There is no retry of signing, simulation, submission, broadcast, a returned runtime mismatch, or old row 3.

The nonce-869 materialization remains stopped and immutable. A recycle proposal starts at the two-provider agreed checkpoint nonce, which must be at least 870; each fresh action requires `latest = pending = pinned` at its selected block and a nonce no lower than that checkpoint. The literal per-action ceilings are 740292 gas for funding, 2000000 for Safe execution, 300000 for public Delay calls, and 1000000 wei for both maximum and priority gas price. The shared gas allowance is not reset: prior actual gas `168855544` plus nonce-869 invalidation gas `124785100000` is the known charge `124953955544`, leaving `15955630044456`; the entire continuation may reserve at most `12080584000000`, leaving `3875046044456` unused. Continuation native principal is zero. Gross USDC outflow and inward recycling are each `11000000`; neither may net away the other or replenish the 31-USDC phase accounting.

Use `resume-one` with the same public execution flags and without `LIVE_SUBMIT` or any credential path. It accepts exactly one durable pending hash in the new 17-row sibling and performs keyless reconciliation only. Historical parsing and known-hash reconciliation may run after the exclusive period or receiver deadline; new admission, rejection evidence, private loading, signing, alerts, and broadcast may not. The CLI's sole public exception is one 250-millisecond retry for the first explicit-block JSON-RPC `getCode` `-32001` on each fixed provider, with identical parameters. Any second failure or later failing tuple stops without retry.

`renderUsdcRecycleContinuationReport` is a pure persisted-evidence projection. It performs no filesystem or RPC reads and creates no signer, approval, or transaction authority. It keeps the original unknown nonce-809 interruption, native `3/22`, old successor `2/19` plus stopped row 3, recycle `0..17/17`, later repair, and Task 0 separate. Only all 17 exact terminal recycle rows, including nine canonical successful receipts, can yield the combined 24-live-entry state at Safe/Delay `15/7/7`; old successor `19/19` is never inferred. Repair remains a separate exact approval lineage and ends at `19/9/9` only when its own evidence is supplied and validated.

## Fresh-period USDC successor CLI and report

The expired recycle authority is historical only. The focused successor uses the new `ordinary-usdc-fresh-period-successor-v1` certificate, proposal, approval, sibling and CLI. It preserves the original 19 rows, native-recovery attachment, old 19-row USDC successor, stopped outer nonce 869 row, and first 15 live entries exactly. It never attaches or completes the expired recycle sibling and carries `repairAuthority: NONE`.

The source proof must authenticate the Circle Sepolia faucet transaction `0x6230026c81cc67ce4aa3cf713838875c7b1d770cbe0f9b48b7b4b3b49f1a59fa`, block `12026817`, block hash `0x8bda9049010367bff921be7b89c281c6f30367af9534743463a61859aefe1d83`, exact 20-USDC transfer to the existing funder, and post-faucet funder balance of 40 USDC with both fixed providers. Treat it as source liquidity only: it is not a successor action and does not replenish any outflow or gas allowance.

Run `review` first with the complete old public lineage, fresh source journal/manifest/watcher evidence, and fresh observer startup/probe inputs. The command accepts no endpoint, chain, clock, profile, action or cap override and emits only unsigned public evidence with `authorization: NONE`. Review requires a canonical later period, at least 11,640 seconds of observer and deadline capacity, equal latest/pending funder nonce at or above 870, Safe/Delay `10/4/4`, Safe USDC zero, funder USDC 40, and the unchanged runtime/topology/signers/policy.

After independent exact-artifact review and the exact machine approval, invoke `submit-one` once per next row with the same complete public inputs, exact artifact hashes, same journal path, fresh observer ledger/acknowledgement, exact `LIVE_SUBMIT=YES`, and the existing controlled credential paths. It admits only the literal next action in the 18-row catalog. Ten rows broadcast; eight are read-only rejection proofs. Every broadcast freezes nonce, quote, estimate, selected block, fees, envelope, reservation and signer before one signing/broadcast attempt. Persist the computed hash first. Any pre-hash interruption or drift stops the row permanently; do not reset, refresh, re-sign, or assign a later transaction to it.

Use `resume-one` only for one exact durable fresh-sibling pending hash. It rejects credentials and `LIVE_SUBMIT`, performs no new admission, signing, proof, alert or rebroadcast, and may only reconcile that known hash. A receipt outside the approved fresh period remains a late/stopped receipt, never completion evidence. Alert-producing rows additionally require the fresh watcher delivery plus exact official acknowledgement before confirmation; non-alert rows must carry no observer evidence. Respect the real 120-second ready wait and 720-second expiry wait.

Gross accounting is non-netted: 31 USDC new outflow, 31 USDC controlled inward funding, and 51 USDC aggregate old-plus-new outflow. New gas reservation is capped at `15340292000000` wei; cumulative outlay is capped at `146501418272986` wei and remains below the unchanged `0.05 ETH` phase ceiling. Terminal evidence is exactly 18 fresh terminal rows, ten new successful receipts, 25 successful live entries total, Safe/Delay `17/7/7`, Safe USDC zero and funder USDC 40.

`renderUsdcFreshSuccessorReport` consumes only supplied public persisted evidence. It performs no filesystem/RPC read and has no signing, simulation, approval-construction or broadcast path. It rejects missing/late receipt inclusion, gas mutation, netted accounting, faucet drift, immutable-header drift, old-row mutation, live-suffix mismatch, or wrong/missing kind-specific observer evidence. It reports repair as `NOT_AUTHORIZED` and leaves Task 0 plus native Tasks 1–13 open.

The reviewed period ended at Unix `1793318400` (2026-10-30 00:00 UTC). It now permits only historical inspection or exact durable-hash reconciliation. Do not run a new `submit-one`, rejection proof, alert, or private callback under this expired proposal. Any live continuation needs a focused successor with fresh canonical state, observer window, exact artifact review, and new approval; do not roll the old dates or silently reuse this authority.

The temporary test receiver's public hash and successful metadata probe establish configuration only. Keep every action's alert row conditional until that exact live event is independently delivered and reconciled. Never package its private URL.

For the ordinary observer run, configure `MONITOR_WEBHOOK_URL` only in the external live environment. The watcher must reject a missing, non-HTTPS, credential-bearing, private-address, or DNS-ambiguous endpoint before scanning. Delay setup logs such as `EnabledModule(address)` are well-formed unrelated topics and must produce neither a ledger alert nor a queue/state read; exact `TransactionAdded` and `TxNonceSet` topics remain subject to full decode and queue binding, and malformed expected activity must stop the scan. Retain the canonical outer transaction/receipt and block identity, pre-block Safe nonce, ordered earlier same-block Safe execution events, derived target nonce, decoded `execTransaction` fields, recomputed `getTransactionHash`, matching `ExecutionSuccess.txHash`, guard event, event-block spend tuple, persisted alert, and durable delivery receipt. Reconcile the receiver's independently recorded body hash with the ledger payload hash. Do not retain the URL, headers, or provider credentials. The receiver descriptor/probe remains configuration evidence; actual activity delivery and closed-browser proof are `NOT_RUN` until the separately approved live matrix is performed.

## Forbidden paths

Direct owner transfers that do not satisfy the guard tier, unlisted modules, fallback handlers, delegatecalls outside the fixed maintenance path, batches, approvals, Permit/Permit2, arbitrary messages, approved-hash authorization, unknown calldata, unknown recipients, broad recovery fields, signer-only shortcuts, relayer discretion, and UI-only authorization are forbidden. Monitoring is mandatory evidence, not an authorizer.

## Rehearsal sequence

Use deliberately low-value test assets and clean test accounts. Refuse chain ID 1 at every step.

1. Read and record chain ID, bytecode, owners, threshold, fallback, both guard slots, the single Safe module, Delay topology, policy, counters, and notification destinations.
2. Verify the atomic setup plan is unsigned and byte-stable across two generations. The planner cannot broadcast; only the separately gated live runner may submit after review.
3. Exercise a native/ERC-20 base transfer within per-transaction and X limits. Confirm it consumes both X and shared Y.
4. Exercise step-up transfers requiring the configured primary passkey plus the safe-contract secondary and the primary passkey plus the ECDSA secondary. Confirm each consumes shared Y, emits the step-up alert, and cannot be authorized by either secondary alone or by both secondaries without the primary.
5. Attempt unsupported calldata, approvals, Permit/Permit2, batches, delegate calls, arbitrary messages, unknown recipients, and direct owner/module bypasses. Each must fail closed.
6. Attempt a transfer above Y directly. Confirm it cannot execute; queue the exact fingerprint through Delay with the primary passkey plus one configured secondary approval.
7. Confirm the delayed lifecycle alert, cancel the queue item, and prove the cancelled fingerprint cannot execute. Repeat with expiry and prove stale execution fails.
8. Queue a fresh low-value delayed transfer, advance Z, execute it, and reconcile the exact fingerprint and alert.
9. Rehearse the lost-factor availability failure, deploy and bind the separately reviewed replacement signer, queue and execute delayed contract-secondary repair, prove the old secondary rejects and the new secondary can queue/cancel the same post-Y proof item, then freeze as the final action. No future recovery boundary is active in this prototype; signer repair must use the delayed maintenance path and must not immediately transfer or weaken policy.
10. Re-run the complete read-only verifier after every state transition and retain failures. Do not accept “the UI showed the right tier” as proof.

## Evidence and architecture gate

The rehearsal is incomplete unless the evidence bundle proves one Safe holds assets, both guard paths are constrained, Delay is the only module, passkey-only spending is bounded by X, combined immediate spending by Y, transfers above Y wait Z and are cancellable, signer repair remains delayed, the lost-factor availability risk is visible, and both notification classes were independently observed.

The live low-value Sepolia rehearsal remains outstanding until the public package is reviewed, the separate live runner passes its gates, and deliberately low-value test transactions produce real evidence. Do not fabricate transaction hashes and do not mark issue #5 complete from this package alone.

Any security property that depends only on UI classification, monitoring, relayer honesty, or operator discipline fails the architecture gate. Do not deploy to mainnet or describe this prototype as production-ready or audited. Independent review and a professional audit remain mandatory.
