# Task 5 fix-round report

Status: complete.

Closed review findings:

- Removed the zero-value/empty-calldata owner bypass. Once the guard is installed, every owner transaction is classified and unsupported calls fail closed. No arbitrary Safe-management exception was added; policy configuration remains Safe-only setup behavior before guard installation and is deferred for delayed weakening semantics to Task 6.
- Added an atomic ERC-20 post-execution balance proof. For selected exact `transfer(address,uint256)` calls, the guard snapshots the Safe and recipient balances, then reverts in `checkAfterExecution` unless Safe balance decreases and recipient balance increases by exactly the requested amount. A false-returning or no-op token therefore rolls back the counter update and the entire Safe transaction.
- Replacing an asset policy now clears the previous recipient mapping before storing the new exact allowlist.
- Reworked the invariant into generated mixed sequences across two tokens, tiers, amounts, authorized and unauthorized recipients, rejected attempts, ordering, period boundaries, counter bounds/monotonicity, and balance conservation.

Verification:

- `npm run build` passed.
- `npm test` passed: 30 tests.
- `npm run test:unit` passed: 23 tests.
- `npm run test:integration` passed: 6 tests against Safe 1.5.
- `npm run test:invariant` passed: 1 stateful invariant.
- `npm run coverage` passed: 100% statements, lines, and functions; 56.34% branches.
- `git diff --check` passed.

Remaining concern: the balance proof intentionally supports only exact-transfer ERC-20 behavior. Fee-on-transfer, rebasing, or other non-exact token semantics are rejected by the proof and are outside the MVP selected-token scope. Delayed configuration weakening/tightening remains Task 6 scope.
