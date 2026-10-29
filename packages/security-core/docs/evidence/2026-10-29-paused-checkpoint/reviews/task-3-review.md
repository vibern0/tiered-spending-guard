### Spec Compliance

- ❌ Issues found: proven post-materialization nonce drift does not mark the new continuation row stopped, and the mandated adversarial store/execution test matrix is incomplete.
- ⚠️ Cannot verify from this task diff alone: root Task 4's default CLI/context composition and final exact-artifact review remain later gates.

### Strengths

- The new view projects exactly the three native bridges, two confirmed old USDC bridges, and 17 new actions while requiring opaque authorization (`packages/security-core/scripts/live/ordinary-scenario-executor.ts:444`, `packages/security-core/scripts/live/ordinary-scenario-executor.ts:1324`).
- The sibling store decoder validates the closed header/catalog, checkpoint nonce, action keys, and final-materialization hash before restoring storage, and monotonic saves freeze the complete predecessor prefix (`packages/security-core/scripts/live/ordinary-scenario-executor.ts:1547`, `packages/security-core/scripts/live/ordinary-scenario-executor.ts:1664`).
- Receipt inclusion is persisted before period validation/observer confirmation, and the adapter rechecks the frozen materialization block while allowing a newer canonical head (`packages/security-core/scripts/live/ordinary-scenario-executor.ts:1096`, `packages/security-core/scripts/live/ordinary-scenario-adapter.ts:111`).
- The chain-31337 integration uses actual Safe, guard, WebAuthn signer, and Delay mechanics without presenting local state as Sepolia evidence (`packages/security-core/test/integration/ordinary-usdc-recycle-continuation-adapter.test.ts:32`).

### Issues

#### Critical (Must Fix)

- None.

#### Important (Should Fix)

- `packages/security-core/scripts/live/ordinary-scenario-adapter.ts:152`, `packages/security-core/scripts/live/ordinary-scenario-executor.ts:1210`: after materialization, a proven selected-block/current nonce divergence throws `ordinary scenario selected-block and current funder nonce drift` inside `readState`; the executor catch only stops the new row for the exact reorg message or `controlled state drift`. The row therefore remains `signed-simulated`, contrary to the root ruling that proven nonce/envelope/reorg mismatch must mark only the new row `stopped`. Classify this verified nonce-drift error as a permanent continuation stop, persist it, and add a regression asserting old row 3 stays untouched and no second sign/broadcast occurs.
- `packages/security-core/test/unit/security/ordinary-usdc-recycle-continuation-executor.test.ts:65`: the required real atomic attachment/store matrix is not present. This test creates the store from an already attached journal and saves the same object; it never opens the stopped predecessor under lease, compares that source, attaches/saves, and reopens. It also omits detached-draft, writer-lock rejection, action reset/removal/reorder/mixed-suffix, persisted checkpoint enforcement after fresh reopen, canonical newer-head acceptance, post-freeze nonce/envelope drift, and durable-hash-before-sole-broadcast assertions required by Step 1. Add focused real-store regressions rather than relying on predecessor-suite behavior.

#### Minor (Nice to Have)

- None.

### Assessment

**Task quality:** Needs fixes

**Reasoning:** The implementation has strong closed projection, decoding, and immutable-prefix mechanics, but one explicit permanent-stop rule is missed and the task-specific adversarial tests do not establish several required guarantees. Reported tests were not rerun because the code inspection answered the concrete doubts.
