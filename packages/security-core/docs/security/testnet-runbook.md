# Sepolia testnet runbook

This runbook is for the single-owner security-core prototype on Sepolia only (`chainId 11155111`). It is security research, not a production wallet. Never use it for mainnet, production funds, or live broadcast from the planner. The examples are redacted, not deployed, and contain no secrets. The approved 2026-10-09 plan permits a separate live runner after local gates and decoded deployment review; unsigned planners remain non-broadcasting.

The active prototype has exactly one Safe owner: the configured primary passkey. Contract and ECDSA secondary signers are guard-only identities. It has no recovery owner, recovery signer adapter, fallback handler, extra module, or auxiliary custody Safe. Base transfers require the primary passkey. Step-up transfers, delayed proposals, cancellation/freeze, and delayed maintenance require the primary plus exactly one configured secondary signer over the exact Safe transaction. The loss of the primary or all configured secondary factors is an accepted testnet availability risk: funds may become unavailable until a future delayed recovery design is separately written, reviewed, implemented, and rehearsed. Direct Burner NFC/libhalo support remains a future spike and is out of scope for this runbook.

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

The exact Safe submission is the factory call whose initializer is `setup([primary passkey], 1, setupHelper, setupData, 0, 0, 0, 0)`. The setup helper checks the sole-owner topology and performs the atomic setup while `address(this)` is the final Safe: configure assets, configure both secondary signer slots, set maintenance, install the same guard in both guard slots, enable Delay as the only Safe module, and enable the Safe as Delay's only upstream module. Any decoded submission with a different owner, nonzero fallback handler, extra module, unlisted delegatecall, or mismatched Delay owner/avatar/target is a hard stop.

## Delay execution, cancellation/freeze, and signer repair

Delay execution happens only after the queued fingerprint has cooled down and before expiration. The relayer may call `executeNextTx`, but it has no authority beyond executing the already queued tuple. The module guard admits only the configured Delay module and supported `CALL` transfer or delayed-maintenance tuple.

Cancellation/freeze is available to the primary passkey plus exactly one configured secondary signer through the exact Delay nonce-advance cancellation or guard `freeze()` calls. Operators must enumerate the ordered queue items invalidated by a nonce advance before review. Signer repair is delayed through `GuardReplacementMaintenance.replaceSigner`: primary repair swaps the sole Safe owner and guard identity atomically; secondary repair changes guard configuration only. Use sentinel previousOwner for primary and zero for secondary. Direct guard signer repair and role-2 repair are forbidden.

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
9. Freeze instant tiers, rehearse the lost-factor availability failure, queue delayed signer repair, and run teardown. No future recovery boundary is active in this prototype; signer repair must use the delayed maintenance path and must not immediately transfer or weaken policy.
10. Re-run the complete read-only verifier after every state transition and retain failures. Do not accept “the UI showed the right tier” as proof.

## Evidence and architecture gate

The rehearsal is incomplete unless the evidence bundle proves one Safe holds assets, both guard paths are constrained, Delay is the only module, passkey-only spending is bounded by X, combined immediate spending by Y, transfers above Y wait Z and are cancellable, signer repair remains delayed, the lost-factor availability risk is visible, and both notification classes were independently observed.

The live low-value Sepolia rehearsal remains outstanding until the public package is reviewed, the separate live runner passes its gates, and deliberately low-value test transactions produce real evidence. Do not fabricate transaction hashes and do not mark issue #5 complete from this package alone.

Any security property that depends only on UI classification, monitoring, relayer honesty, or operator discipline fails the architecture gate. Do not deploy to mainnet or describe this prototype as production-ready or audited. Independent review and a professional audit remain mandatory.
