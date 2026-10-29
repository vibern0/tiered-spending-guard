### Finding Verdicts

- **Generated ID mapping instead of the required private literal 17-row mapping** — **ADDRESSED**. `CATALOG` now lists all 17 `oldId`, `newId`, and dependency tuples explicitly, and `rebuildActions` validates and consumes those literal entries (`packages/security-core/scripts/live/ordinary-scenario-usdc-recycle-continuation-proposal.ts:42`, `packages/security-core/scripts/live/ordinary-scenario-usdc-recycle-continuation-proposal.ts:202`). The test now contains literal expected IDs and dependencies rather than deriving them from suffixes (`packages/security-core/test/unit/security/ordinary-usdc-recycle-continuation-proposal.test.ts:27`).
- **Storage type was structural and exposed a mutable action array** — **ADDRESSED**. `UsdcRecycleContinuationStorage` now has a private unique-symbol brand and exposes a readonly action collection of readonly records (`packages/security-core/scripts/live/ordinary-scenario-usdc-recycle-continuation-proposal.ts:118`, `packages/security-core/scripts/live/ordinary-scenario-usdc-recycle-continuation-proposal.ts:134`). The serialized journal boundary remains structurally validated, while newly attached storage and each initial action record remain recursively frozen; focused tests cover collection and record mutation rejection (`packages/security-core/test/unit/security/ordinary-usdc-recycle-continuation-proposal.test.ts:220`). Focused check: `OrdinaryScenarioActionRecord`'s nested materialization, receipt, and receipt-inclusion members are already readonly types, so the amended union does not leave mutable nested storage fields.

### New Breakage in the Fix Diff

- None. The withdrawn D/expiry finding remains correctly withdrawn: the fix leaves strict new-operation admission unchanged.
- Reported covering evidence is present: focused proposal suite 8 passing, affected four-suite run 31 passing, and `git diff --check` clean. Tests were not rerun per the re-review instructions.

### Out-of-Scope Observations

- None.

### Verdict

**Fix round:** All findings addressed, no new Critical/Important breakage.
