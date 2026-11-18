# Task 2 implementation report

**Task:** Define the X/Y/Z policy and advisory classifier
**Repository:** `/Users/bernardo/.codex/worktrees/308c/recent-tx-safe-guard`
**Security posture:** Testnet security research only. No deployment or production-readiness claim is made.

## Scope completed

- Added readonly `AssetPolicy`, `VaultPolicy`, and `AssetSpendState` models with validation for aligned 86,400-second periods, `0 < X < Y`, positive and bounded caps, distinct signers/assets/recipients, and valid addresses.
- Added fail-closed `classifyAction` support for native transfers and exact ERC-20 `transfer` calldata.
- Enforced recipient/token allowlists, passkey signer requirement, Burner requirement for step-up, cumulative remaining X/Y accounting, aligned reset windows, per-transaction caps, delayed recognized transfers above Y, and enumerated Safe/Delay/recovery actions.
- Added table-driven adversarial tests covering the Task 2 brief’s boundary, decoding, configuration, recovery, malformed-call, and fail-closed cases.

## Verification

```text
npx hardhat test test/unit/policy/classify.test.ts       # passed; 7 passing
git diff --check                                        # passed
```

The brief’s exact wrapper command was also attempted:

```text
npm run test:unit -- --grep "classifyAction"
```

It failed before running tests because the existing shell `if` wrapper appends `--grep` after `fi` (`syntax error near unexpected token '--grep'`). The equivalent direct Hardhat command was used for the red and green TDD checks. `npx tsc --noEmit` remains blocked by two pre-existing errors in `legacy/test/RecentTransactionGuard.ts` (lines 115 and 159); no Task 2 files are implicated.

## Concerns

- The classifier is advisory only; onchain enforcement remains a later guard task.
- The existing `test:unit` script should be repaired in a separate scoped task if argument forwarding is required.

## Follow-up review fix

The review findings were addressed without expanding beyond Task 2:

- Delay and recovery targets now require explicit allowlisted selectors; arbitrary calldata is blocked.
- Unsupported operation values are rejected; only `call` and `0` are accepted.
- Corrupt spend state with `baseSpent > instantSpent` is rejected.
- Unit, integration, and invariant test lanes now forward npm arguments safely and skip cleanly when their directories have no tests.
- Regression coverage now asserts arbitrary Delay/recovery rejection and the state/operation invariants.

Follow-up verification:

```text
npx hardhat test test/unit/policy/classify.test.ts --grep "classifyAction|inconsistent"  # passed; 8 passing
npm run test:unit -- --grep "classifyAction"                                     # passed; 8 passing
npm test                                                                       # passed; 8 passing
npm run build                                                                  # passed; Nothing to compile
npm run coverage                                                               # passed; 8 passing
npm run test:integration                                                       # passed; clean skip (directory absent)
npm run test:invariant                                                         # passed; clean skip (directory absent)
git diff --check                                                               # passed
```

## Final delayed-calldata fix

The final review finding was addressed by decoding every enumerated delayed action against its ABI and requiring canonical re-encoding to match the complete calldata byte-for-byte. Typed argument checks additionally reject invalid Delay execution operations and malformed payloads. Regression tests cover truncated, extra, selector-only, and invalid-argument calls.

Final verification:

```text
npx hardhat test test/unit/policy/classify.test.ts --grep "classifyAction|delayed|inconsistent"  # passed; 9 passing
npm test                                                                                   # passed; 9 passing
npm run build                                                                              # passed; Nothing to compile
npm run coverage                                                                           # passed; 9 passing
git diff --check                                                                          # passed
```

## Final selector/value fix

The remaining review findings were addressed. `disableModule` now uses the exact Safe ABI signature `disableModule(address,address)` in both selector enumeration and ABI dispatch. All delayed Safe, Delay, and recovery control actions now require `action.value === 0n`; nonzero ETH is blocked before delayed classification.

Final verification:

```text
npx hardhat test test/unit/policy/classify.test.ts --grep "classifyAction|delayed|control"  # passed; 10 passing
npm test                                                                              # passed; 10 passing
npm run build                                                                         # passed; Nothing to compile
npm run coverage                                                                      # passed; 10 passing
git diff --check                                                                      # passed
```
