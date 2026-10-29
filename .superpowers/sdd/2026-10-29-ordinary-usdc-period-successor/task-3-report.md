# Task 3 report: same-journal USDC successor execution

## Status

DONE. The executor and mechanical adapter now consume the exact opaque Task 2 successor authority, execute only the 19 `usdc-successor-*` actions, and persist progress in the existing journal's `usdcSuccessor` sibling. The implementation did not access RPC, network, private/config/log paths, live signers, broadcasters, or the authoritative source journal. The parent plan file remained unstaged and was not edited by this task.

## Implemented boundary

- Added `createUsdcSuccessorExecutionView(source, successor, approval?)`, `selectUsdcSuccessorSubmissionAction(source, successor, approval, journal)`, and `executeUsdcSuccessorAction(source, successor, approval, store, context)`.
- The execution view carries the three confirmed native recovery records only as historical dependency/queue context. Its binding and next-action catalog contain exactly the 19 successor actions; the stopped native row and superseded old `usdc-*` tail are never executable.
- Extended the existing journal decoder and monotonic filesystem store with the exact `usdcSuccessor` field. The decoder requires the approved fixed source hash, exact 19-action original prefix, complete 22-action recovery attachment with only the first three confirmed, at least the exact first 13 live records, immutable successor headers/catalog, and an ordered live suffix derived only from successor records with durable hashes.
- Reused the existing executor state machine, materializer, signature verification, simulation, live-journal broadcast/reconciliation, receipt accounting, and store replacement mechanics. No exported arbitrary action runner, new Solidity, or dependency was added.
- Bound the raw native spend tuple to `(1793145600,10000000000000,30000000000000)` while deriving the USDC effective period independently from canonical block time. Every private boundary and the final broadcast boundary recheck the approved period, raw spend state, and Task 2 admission window.
- Known pending transaction hashes reconcile without repeating private materialization, signing, simulation, or broadcasting, including after the admission deadline. Receipt-block time is authoritative: an in-period receipt continues normal confirmation; a late receipt is durably recorded with its actual period and transitions the successor record to terminal `stopped`.
- The mechanical adapter requires and forwards the exact nonempty observer `readyAt` and `expiresAt` values bound by the successor proposal. Production construction remains on the existing genuine fixed-Sepolia capability.
- Updated the security call graph for the new execution, persistence, replay, admission, receipt-period, and observer paths.

## TDD evidence

Initial RED command from `packages/security-core`:

```text
npx hardhat test \
  test/unit/security/ordinary-usdc-successor-executor.test.ts \
  test/integration/ordinary-usdc-successor-adapter.test.ts
```

Initial RED output:

```text
0 passing
4 failing

TypeError: createUsdcSuccessorExecutionView is not a function
Error: ordinary scenario journal has unknown or missing fields
TypeError: createUsdcSuccessorExecutionView is not a function
Error: VM Exception while processing transaction: reverted with reason string 'GS000'
```

The fourth failure was an invalid integration fixture that reused one passkey for two Safe owners. It was corrected to two distinct real WebAuthn owners before implementation; the remaining RED failures were the absent Task 3 interfaces and store schema.

Focused GREEN for the same command:

```text
7 passing
```

Affected-suite command:

```text
npx hardhat test \
  test/unit/security/ordinary-scenario-executor.test.ts \
  test/unit/security/ordinary-scenario-adapter.test.ts \
  test/unit/security/ordinary-scenario-hashless-executor.test.ts \
  test/integration/ordinary-scenario-adapter.test.ts \
  test/integration/ordinary-scenario-hashless-adapter.test.ts \
  test/unit/security/ordinary-usdc-successor-executor.test.ts \
  test/integration/ordinary-usdc-successor-adapter.test.ts
```

Affected output: `73 passing (3s)`. After the final receipt/store hardening edits, the covering executor/hashless/successor subset passed `56 passing`.

Final verification:

```text
npm run check
npm test
git diff --check
```

`npm run check` completed successfully with only the two existing Solidity mutability warnings and a 536-test full pass. The final post-hardening `npm test` also passed `536 passing (22s)`. Whitespace validation passed.

## Test coverage

- Unit tests prove the closed view and selection catalog, exact authority rejection, real filesystem round-trip after attachment and updates, immutable-header/catalog mutation rejection, fixed raw native tuple enforcement, later effective-period acceptance, materialized interruption durability/no retry, expiry before persistence/private callbacks, exact known-hash replay after deadline, durable late-receipt stopping, and observer lifetime forwarding.
- The integration test deploys an actual Safe, `TieredSpendingGuard`, two real Safe WebAuthn passkey signer contracts, ERC-20 USDC mock, and Zodiac Delay on Hardhat chain 31337. It uses the shared mechanical adapter to encode and sign a base transfer and delayed queue action; the real base transfer succeeds and the real Delay queue nonce increments.
- This local integration proves the reused cryptographic and contract mechanics. It does not forge Sepolia identity or claim a production certificate. The approved fixed-Sepolia source, certificate verification, production provider, and any eventual live root execution remain separate mandatory boundaries.

## Files

- `packages/security-core/scripts/live/ordinary-scenario-executor.ts`
- `packages/security-core/scripts/live/ordinary-scenario-adapter.ts`
- `packages/security-core/test/unit/security/ordinary-usdc-successor-executor.test.ts`
- `packages/security-core/test/integration/ordinary-usdc-successor-adapter.test.ts`
- `packages/security-core/docs/security/call-graph.md`
- `.superpowers/sdd/2026-10-29-ordinary-usdc-period-successor/task-3-report.md`

## Interfaces and concerns

- Task 4 may call the three exported Task 3 APIs directly with Task 1/2 opaque capabilities and the existing store/adapter context. No CLI or provider-map work is part of Task 3.
- The source hash is intentionally fixed to the accepted public checkpoint. Pinned history permits a validated later suffix, while current-store validation accepts only the exact ordered successor suffix and rejects mixed, orphaned, or reordered entries.
- The actual receipt can arrive after the approved period even when broadcast occurred before deadline. The executor preserves that chain fact and stops; it does not reinterpret the receipt as approved successor progress.
- No material implementation concern remains after self-review and the final full suite.

## Fix round 1

Status: DONE. All three Important findings in `task-3-independent.md` were accepted and addressed.

### Receipt-period ordering

The execution context now exposes the narrow optional `inspectReceiptPostState` callback. The production mechanical adapter implements it by re-reading the exact canonical successful receipt and exact outer transaction envelope, then reading controlled poststate at that receipt's block. For a successor receipt, the executor requires this boundary, validates the receipt-poststate evidence basis, and derives the actual period before calling full effect/matrix/observer confirmation.

A late receipt is written to the action, the live entry remains canonical success, and the action is durably transitioned from `outer-pending` to `stopped` with receipt-period evidence. This happens even when the alert observer acknowledgement is absent or throws. The executor never calls full confirmation in that late branch. An in-period receipt continues through the unchanged full confirmation checks.

RED command:

```text
npx hardhat test test/unit/security/ordinary-usdc-successor-executor.test.ts --grep "late alert"
```

RED output:

```text
0 passing
1 failing
expected rejection matching the late-period stop, got "observer acknowledgement is absent"
```

GREEN output for the same command: `1 passing`. The regression uses the real filesystem store, an alert-producing later queue action, a canonical receipt-block poststate, a throwing observer confirmation, and a close/reopen assertion for the terminal stopped receipt.

### Real Delay lifecycle integration

The honest Hardhat 31337 integration now runs the actual base transfer, three actual guarded queue proposals, actual Safe-authorized cancellation, actual post-expiry `skipExpired`, and actual post-cooldown `executeNextTx`. It uses the shared mechanical adapter for every calldata/signature materialization, two real Safe WebAuthn contracts for the delayed queue path, the frozen EIP-1193 ECDSA extension for cancellation, the real Safe and `TieredSpendingGuard`, ERC-20 USDC, and Zodiac Delay. Assertions bind the successful receipts, queue/transaction nonce progression `0 -> 1 -> 2 -> 3`, and final recipient USDC balance.

The first integration RED exposed an invalid below-Y delayed fixture through `InvalidDelayedAction()`. After correcting the delayed amount, the second RED exposed the cancellation's missing reviewed ECDSA extension through `MissingEcdsaSecondaryExtension()`. The final honest fixture uses 31 units and the actual ECDSA secondary boundary.

GREEN command and output:

```text
npx hardhat test test/integration/ordinary-usdc-successor-adapter.test.ts
1 passing
```

### Later exact-ID evidence

The successor executor test now advances exact attached progress to action indexes 3, 5, 8, 10, and 18 and checks the next head each time. It drives a later cancellation head through exact successor dependency and queue-receipt lookup, drives the replay rejection to its exact successor source record, and rejects a forged confirmed `usdc-*` record in the superseded recovery tail. The closed production mappings already handled these cases; this finding required direct adversarial evidence rather than a production mapping change.

Final affected command:

```text
npx hardhat test \
  test/unit/security/ordinary-usdc-successor-executor.test.ts \
  test/integration/ordinary-usdc-successor-adapter.test.ts \
  test/unit/security/ordinary-scenario-executor.test.ts \
  test/unit/security/ordinary-scenario-adapter.test.ts \
  test/unit/security/ordinary-scenario-hashless-executor.test.ts \
  test/integration/ordinary-scenario-adapter.test.ts \
  test/integration/ordinary-scenario-hashless-adapter.test.ts
```

Final affected output: `74 passing (3s)`. `git diff --check` passed. Per the fix-round instruction, the unchanged 536-test full suite was not repeated; the focused set covers the modified executor, adapter, filesystem store, successor paths, predecessor/hashless compatibility, and actual cryptographic/contract mechanics.

### Fix-round interfaces and concerns

- Task 4 contexts for successor execution must compose `inspectReceiptPostState`; the shared production adapter already supplies the exact canonical implementation.
- The narrow inspection result grants no success authority. It only binds the mined receipt, outer envelope, receipt block, and actual period. Effect, matrix, queue, accounting, and observer evidence remain in full confirmation for in-period receipts.
- No new Solidity, dependency, arbitrary action surface, RPC use, live signer, broadcaster, operational approval, or authoritative journal write was added.
