# Sepolia testnet runbook

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
