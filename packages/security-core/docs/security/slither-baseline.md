# Slither baseline

The gate runs Slither with `slither.config.json`, excludes legacy and test support, and accepts exit 255 only when the JSON report is readable and every finding is in `slither-baseline.json`. Any tool error or unlisted finding fails the gate. Informational findings are excluded by configuration; no security detector is globally disabled.

The reviewed baseline is narrow and intentional:

- `timestamp` and `divide-before-multiply`: the daily window is deliberately anchored to `block.timestamp`; integer division is the exact period-floor calculation, not a financial conversion.
- `incorrect-equality`: equality to the current window distinguishes current-period spend from stale state; stale state is treated as zero.
- `reentrancy-no-eth` in `GuardReplacementMaintenance.replaceGuards`: the lock is set before the two Safe self-calls and replacement configuration call, and is cleared only after all checks succeed. A revert rolls back both guard-slot writes and the lock. The remaining detector is retained as a review reminder, not suppressed.
- `unused-return`: signature decoder tuple fields are intentionally discarded after the decoder validates the exact signature shape; Safe performs the authoritative signature check immediately afterward.
- `unused-return` in `replaceSigner` (2026-10-09): the first `config()` read selects only the primary to compare against the sole Safe owner. Before any mutation, `_matchesGuardConfiguration` independently reads and validates the Safe, Delay, period, and secondary bindings. Ignored tuple fields are not unchecked authorization results. Other baseline changes on this date only relocate existing findings after the single-owner refactor.
- `cache-array-length`: `policyHash` is a read-only inventory loop over a bounded configuration array; this is an optimization-only finding.
- `shadowing-local`: the Safe setup interface's decoded `ecdsaSecondary` return-field name matches its separate getter name; the contract-only Phase One setup verifies both values and the naming overlap creates no storage or authorization path.
- `calls-loop` in `SafeAtomicSetupHelper.setup`: the loop is the fixed per-asset policy initialization sequence. Every target is the reviewed guard address, every call is checked, and any failed policy write reverts the whole Safe creation.

This is a reviewed baseline, not an assertion that the code is audited or production-ready.
