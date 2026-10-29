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
