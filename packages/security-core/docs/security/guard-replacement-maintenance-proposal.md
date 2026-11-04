# Guard replacement maintenance proposal

## Gate

Task 6 was blocked because Safe 1.5 exposes `setGuard(address)` and `setModuleGuard(address)` as separate authorized calls and has no combined guard-replacement entry point. Executing them independently creates an intermediate state with only one guard slot protected, violating the single-Safe invariant.

The plan also rejects fast-path batches and delegate calls. No implementation should queue or execute guard replacement until an atomic, fail-closed maintenance mechanism is explicitly reviewed.

## Candidate resolutions and tradeoffs

### 1. Narrow maintenance contract — selected

Pros:

- Preserves the one-Safe and dual-guard invariant.
- Can make both Safe setter calls atomic with rollback.
- Keeps the allowed maintenance surface explicit and auditable.

Cons:

- Adds custom security-critical Solidity.
- Expands audit, deployment, and verification scope.
- A defect could brick or weaken both guard slots at once.

### 2. Existing Safe/Zodiac primitive — investigated and rejected

Pros:

- Reuses established infrastructure and potentially audited code.
- Avoids introducing another custom contract.
- Could reduce long-term maintenance burden.

Cons:

- Safe 1.5 exposes `setGuard(address)` and `setModuleGuard(address)` separately; no combined setter exists.
- Safe MultiSend is a general batch mechanism implemented through delegatecall, conflicting with the narrow no-batch/delegatecall maintenance requirement.
- Zodiac Delay queues and executes one target/value/calldata/operation tuple; it does not atomically update both Safe guard slots.

Evidence: [Safe setGuard](https://docs.safe.global/reference-smart-account/guards/setGuard), [Safe setModuleGuard](https://docs.safe.global/reference-smart-account/guards/setModuleGuard), [Safe GuardManager](https://github.com/safe-fndn/safe-smart-account/blob/main/contracts/base/GuardManager.sol), [Safe MultiSend](https://github.com/safe-fndn/safe-smart-account/blob/main/contracts/libraries/MultiSend.sol), and [Zodiac Delay reference](https://docs.zodiac.eco/developers/delay/reference). The Safe Research Policy Engine demonstrates MultiSend as prior art for atomic removal and now records scoped component audits, but it is not a deployment dependency and those audits do not cover this maintenance composition.

Ruling: no existing primitive meets the required boundary; do not adopt MultiSend or the Policy Engine as a substitute for a reviewed maintenance design.

### 3. Revise the topology invariant

Pros:

- Avoids a separate replacement mechanism.
- Reduces maintenance-contract complexity.
- Could simplify recovery if a new invariant is independently designed.

Cons:

- Changes a documented security property rather than implementing it.
- Risks leaving one Safe execution path unprotected during maintenance.
- Requires revising the research, plan, threat model, topology, and adversarial tests.

## Selected design gate

The user selected Resolution 1 after the Resolution 2 investigation. The selected contract must be narrowly scoped to atomic dual-guard maintenance, callable only through the verified delayed path, and covered by explicit reentrancy, rollback, no-intermediate-state, and no-arbitrary-batch tests.

The repository remains a testnet security prototype and makes no production-readiness claim.
