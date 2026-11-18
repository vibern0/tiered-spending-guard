### Finding Verdicts

- **Proven post-materialization selected-block/current nonce drift must durably stop only the new row, with no second sign/broadcast and old row 3 frozen** — ADDRESSED. The pre-outer catch now classifies the adapter's exact nonce-drift error and persists `stopped` through the continuation store (`packages/security-core/scripts/live/ordinary-scenario-executor.ts:1210`). The regression verifies zero sign/broadcast calls, the new row stopped, and predecessor row 3 unchanged (`packages/security-core/test/unit/security/ordinary-usdc-recycle-continuation-executor.test.ts:217`); the adapter regression independently proves the shipped mechanical reader emits that exact error for selected-block/current nonce divergence (`packages/security-core/test/integration/ordinary-usdc-recycle-continuation-adapter.test.ts:35`).
- **Add the required real atomic attachment/store and post-freeze adversarial test matrix** — ADDRESSED. The test now acquires the real writer lease, compares the stopped source, rejects a second writer, attaches/saves/reopens, proves detached loads, rejects deletion/prefix mutation/action removal/reorder/mixed suffix/reset, and reopens without rereading a stale loader (`packages/security-core/test/unit/security/ordinary-usdc-recycle-continuation-executor.test.ts:67`). Separate regressions cover a newer canonical head (`:123`), post-freeze envelope drift (`:135`), persisted minimum checkpoint after fresh reopen (`:148`), durable hash before the sole local broadcast and keyless resume (`packages/security-core/test/integration/ordinary-usdc-recycle-continuation-adapter.test.ts:43`), and receipt-inclusion persistence before observer evidence (`packages/security-core/test/unit/security/ordinary-usdc-recycle-continuation-executor.test.ts:177`).

### New Breakage in the Fix Diff

None.

### Out-of-Scope Observations

None.

### Verdict

**Fix round:** All findings addressed, no new Critical/Important breakage. The appended report provides the named focused and affected commands with RED `8 passing, 1 failing`, GREEN `14 passing`, and affected `89 passing`; no rerun was needed.
