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

## 2026-11-05 location reconciliation

Reviewed `/tmp/recent-tx-current-slither.log`, the committed twelve-entry baseline, and every reported function body. The current report contains the same twelve detector/function identities. Nine exact location keys moved: eight guard findings had stale baseline anchors, and the helper's checked-call function moved down three lines when the required recipient-mode argument was added to its closed setup tuple. The guard has no worktree changes in this implementation. No detector, severity filter, excluded path, or finding scope was broadened; no Solidity change was made to satisfy this gate.

| Finding | Current scope | Review rationale |
| --- | --- | --- |
| `divide-before-multiply` | Guard `_currentWindow`, lines 788–791 | Division followed by multiplication intentionally floors elapsed time to an anchored daily period. It is not exchange-rate or amount arithmetic. |
| `incorrect-equality` | Guard `_authorizeQueueProposal`, lines 618–638 | Exact equality selects the current period's spend counter; a stale period contributes zero to the remaining-Y calculation. |
| `reentrancy-no-eth` | Maintenance `replaceGuards`, lines 91–116 | Delay caller and Safe delegate context are required. The namespaced lock is written before external calls; both guard slots and replacement configuration are verified, and any failure reverts the complete operation before the lock is cleared. This remains an explicit review reminder. |
| `unused-return` | Maintenance `replaceSigner`, lines 127–160 | The first configuration read intentionally selects the primary for the sole-owner comparison. The subsequent configuration and dual-slot checks validate the ignored bindings before repair; no success or authorization result is discarded. |
| `unused-return` | Guard `decodePasskeySignature`, lines 358–361 | This decoding helper consumes the signer and exact payload boundary and rejects trailing bytes. Its omitted classification field does not authorize execution; the execution path separately requires the configured contract primary and Safe signature validation. |
| `unused-return` | Guard `decodeEcdsaSecondaryExtension`, lines 366–369 | The helper intentionally consumes only the primary payload boundary before parsing the exact terminal extension. Configured-signer authentication remains in the execution path. |
| `shadowing-local` | Setup interface `config().ecdsaSecondary`, line 14 | A decoded return-field name overlaps the separate getter's name. It does not shadow storage or select a different call or signer. |
| `calls-loop` | Setup helper `_checkedCall`, lines 142–145 | The reviewed initialization asset list still calls only `params.guard` with the fixed policy selector. The explicit mode is now another typed argument; it adds no target or execution path. Every low-level result is checked, and failure reverts the entire setup. |
| `timestamp` | Guard `_authorizeTransfer`, lines 557–608 | Consensus block time intentionally chooses the anchored spending period. X/Y and signer checks still govern every transfer; the period rollover resets accounting rather than granting an unrelated authorization. |
| `timestamp` | Guard `_authorizeQueueProposal`, lines 618–638 | The timestamp-derived window is used only to select current versus stale instant spend before the exact queued transfer is classified above remaining Y. Full secondary approval and Delay remain required. |
| `timestamp` | Guard `_currentWindow`, lines 788–791 | Time before the configured anchor fails closed; later time is mapped to the fixed period start. This is the intended timing input. |
| `cache-array-length` | Guard `policyHash`, line 308 | Re-reading the configured-token array length is a view-function gas optimization issue. The Phase One profile verifies exactly one configured asset; changing this loop is unnecessary for the reviewed behavior. |

These decisions retain the original research/testnet limitation. A passing baseline comparison is not an audit or a production-readiness claim. The next Slither run must still produce a readable successful report and no key outside these twelve exact locations.
