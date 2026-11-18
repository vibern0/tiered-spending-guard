# Security-Core Test Roadmap

**Purpose:** Make the vault security core testable by a developer without
requiring a product UI, then add a thin UI harness for human-driven scenarios.

**Status:** Planning document. The security-core implementation lives on the
PR #2 branch; the `main` checkout may still contain only the historical
prototype. Do not use the historical mock as integration evidence.

## Testing strategy

Automated headless tests are the primary security evidence. A UI is a test
operator and observability surface, not a replacement for adversarial tests.
The test layers should move from cheap deterministic checks to realistic local
chain execution:

```text
pure policy/encoding tests
        ↓
local Hardhat contract integration
        ↓
invariants and adversarial sequences
        ↓
fork/deployment rehearsal with verified evidence
        ↓
thin local operator UI
```

Every layer must use test-only keys and test assets. No layer should require a
mainnet RPC, real passkey, real Burner secret, or production webhook.

## Phase 0: establish the correct checkout

Before testing, record:

- branch and commit SHA;
- whether the security-core files exist;
- Node.js and npm versions;
- installed dependency lockfile status;
- whether the test-only chain is Hardhat local or a fork.

The expected security-core commands are:

```bash
npm ci
npm run test:headless
npm run build
npm run test:unit
npm run test:integration
npm run test:invariant
npm run security:check
```

`npm run test:headless` is the local no-UI gate. It cleans stale Hardhat
artifacts, compiles, and runs the unit, integration, and invariant suites on
the in-process Hardhat network.

On the historical `main` checkout, these scripts may not exist yet. Switch to
the security-core branch or worktree before treating a missing script as a
product failure.

## Phase 1: headless unit and policy testing

Run these tests on every change. They should not need a browser, wallet, RPC
credentials, or network access.

### Policy classification

Prove the classifier returns the expected lane for:

- zero, exact-boundary, and one-above-boundary values for X and Y;
- repeated base transfers that cumulatively reach X;
- a base transfer after a step-up transfer;
- a step-up transfer before and after the X budget is exhausted;
- a transfer that crosses X but remains within Y;
- a transfer above Y;
- both per-transaction caps;
- period reset at the exact shared anchor;
- unknown tokens, recipients, operations, and calldata;
- native transfers and selected ERC-20 `transfer` calls;
- approvals, Permit, Permit2, batches, delegate calls, arbitrary messages,
  Safe configuration, and malformed/truncated calldata.

Expected property: no ordering or transaction splitting can exceed X for
passkey-only spending or Y for combined immediate spending.

### Exact encoding and signatures

Test that every authorization digest changes when any one of these changes:

- chain ID;
- Safe address;
- destination;
- value;
- calldata;
- operation;
- gas/refund fields;
- Safe nonce;
- token or policy context where applicable.

Test canonical Safe signature ordering, rejection of extra signatures,
wrong signer identities, malformed lengths, duplicate ECDSA secondary extensions, and
signatures over a different transaction.

### Topology and deployment plans

Test deterministic output for the unsigned setup plan. Reject plans with:

- more or fewer than the configured owners;
- wrong threshold;
- missing transaction or module guard;
- an unlisted module;
- a fallback handler or unrestricted path;
- wrong Delay owner/avatar/target;
- unverified or mismatched dependency evidence;
- mismatched policy or asset hashes;
- mutable caller-supplied deployment metadata.

### Monitoring and notifier

Test confirmation depth, wrong-contract logs, fabricated indexed hashes,
reorg replacement, duplicate delivery, pending-delivery retry, sensitive
field omission, and notification payload allowlisting.

For webhooks, test HTTPS-only validation, credentials, localhost/private
addresses, private answers mixed with public DNS answers, IPv4-mapped IPv6
loopback, DNS rebinding resistance, request timeout, non-2xx handling, and
redirect rejection.

## Phase 2: local Hardhat integration

Create a local test fixture that deploys the actual Safe/guard/Delay
composition used by the security-core branch. It should expose deterministic
test addresses and reset state between cases.

### Fixture setup

1. Start one in-process Hardhat chain.
2. Deploy only pinned or reviewed test fixtures.
3. Deploy one Safe holding native currency and mock ERC-20 tokens.
4. Install the TieredSpendingGuard as both guard paths atomically.
5. Enable only the reviewed Delay module.
6. Configure distinct primary passkey, safe-contract secondary, and ECDSA secondary test identities.
7. Assert the topology before each behavioral test.

### Required scenarios

The integration suite must execute real Safe transactions and real module
transactions, not call the guard directly as a substitute:

| Scenario | Expected result |
| --- | --- |
| Passkey transfer within remaining X | Executes and updates base/instant counters |
| Primary transfer over X but within Y | Rejects without a configured secondary |
| Primary + exact configured secondary co-signature | Executes within Y and updates shared counter |
| Wrong secondary or altered transaction | Rejects |
| Transfer over Y | Cannot execute immediately; must queue |
| Queued transaction before cooldown | Rejects |
| Queued transaction after cooldown | Executes once |
| Primary + configured secondary cancellation | Prevents the queued transfer |
| Expired queue item | Cannot execute as a normal delayed transfer |
| Owner-path bypass attempt | Guard rejects |
| Delay/module-path bypass attempt | Module guard rejects |
| Approval, delegatecall, batch, or unknown calldata | Rejects |
| Monotonic tightening | Can execute immediately if the contract proves it |
| Weakening or signer repair | Requires the delayed path |
| Reorged or unconfirmed event | Does not notify as final |

Each scenario should assert both the transaction result and the resulting
state: balances, counters, queue tuple, nonce, emitted events, and ledger
records.

## Phase 3: invariant and adversarial testing

Use randomized sequences over a single asset-holding Safe. The important
invariants are:

- `0 < X < Y` remains true for every accepted policy state;
- passkey-only immediate outflow never exceeds X in a period;
- combined base-plus-step-up immediate outflow never exceeds Y;
- no delayed item executes before its cooldown;
- a cancelled or expired delayed item never executes;
- every executed delayed item matches its queued tuple and nonce;
- no unauthorized owner or module path changes balances;
- counters and period anchors cannot be reset by transaction ordering;
- policy weakening cannot happen immediately;
- monitoring never authorizes a transaction;
- a reorg cannot permanently finalize an unconfirmed or mismatched event.

Include adversarial sequences that alternate owner and module paths, split
amounts around boundaries, replay old signatures, mutate one digest field,
cancel immediately before execution, and replace a canonical block.

## Phase 4: deployment and fork rehearsal

Run the unsigned deployment planner and read-only verification scripts against
a controlled Sepolia fork only after local integration is green. The rehearsal
must:

- use redacted, reproducible inputs;
- verify chain ID, runtime bytecode, canonical addresses, and version records;
- fail closed on missing RPC data or unknown releases;
- verify Safe owner/threshold/guards/modules and Delay topology;
- recompute policy and deployment hashes;
- never broadcast automatically;
- never log private keys or credentials.

The expected output is an evidence report and unsigned plan, not a live
deployment. A live testnet deployment requires a separate human-approved
runbook step.

## Phase 5: thin UI harness

Only build the UI after Phases 1–3 are reliable. The first UI should be a
local operator console, not the end-user wallet. Its purpose is to make the
security behavior visible and repeatable.

### UI scope

Provide five views:

1. **Connection/status:** local chain, Safe address, policy hash, guard and
   Delay addresses, topology verification result.
2. **Send simulator:** asset, recipient, amount, selected signer lane, exact
   calldata, and the classifier's base/step-up/delayed/blocked result.
3. **Approval simulator:** primary passkey, safe-contract secondary, and ECDSA
   secondary test controls that display the exact transaction digest and
   whether each signature is accepted.
4. **Delay queue:** queued tuple, fingerprint, creation time, cooldown,
   expiry, cancellation state, and execute/cancel actions.
5. **Activity:** confirmed events, reorg/retry status, counter changes, and
   notifier result.

The UI must show why an action was rejected. It must not hide raw transaction
fields behind a friendly summary, and it must not include real credential
entry, production RPCs, or a mainnet network selector in the test harness.

### UI test cases

- Enter amount exactly at X, X+1, Y, and Y+1 and confirm the displayed lane.
- Change one transaction field after signing and confirm execution fails.
- Use the wrong ECDSA secondary and confirm the failure reason is visible.
- Queue, cancel, and attempt to execute the same delayed transaction.
- Refresh the page and verify queue/activity state comes from chain/ledger,
  not only browser memory.
- Reorg or replace a local block and verify the activity view retracts the
  unconfirmed event.
- Point the notifier at a test HTTPS endpoint and confirm failures are
  visible without granting the UI an authorization capability.

## Definition of ready for the next UI task

Do not start product-oriented UI work until:

- the security-core branch is the documented checkout;
- unit, integration, and invariant commands are present and green;
- the local fixture can run all required owner and module-path scenarios;
- a deterministic reset/rehearsal command exists;
- no UI code can authorize a transaction outside the same signer and guard
  boundaries;
- the UI scope above is accepted as a test harness, not a production wallet.

## Suggested work sequence

- [ ] Add or confirm the deterministic local Safe/Delay integration fixture.
- [ ] Complete owner-path and module-path integration scenarios.
- [ ] Add invariant generators for split spending, replay, cancellation, and
  period reset.
- [ ] Add a single command that runs the local test matrix from a clean state.
- [ ] Add a local-only test webhook server with HTTPS and controllable DNS
  resolution for notifier tests.
- [ ] Build the thin operator UI only after the headless gates are green.
- [ ] Add browser tests for the UI scenarios without moving security proof out
  of the contract/invariant suites.
