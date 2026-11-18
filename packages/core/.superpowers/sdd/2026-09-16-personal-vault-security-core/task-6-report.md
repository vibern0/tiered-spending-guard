# Task 6 report

Status: implemented and verified; testnet research prototype only.

Implemented:

- `GuardReplacementMaintenance`: Delay-only, Safe-context-only atomic dual-guard replacement; exact two self-calls, interface checks, expected-slot checks, rollback, reentrancy lock, and no arbitrary batch surface.
- `TieredSpendingGuard`: verified Delay-only module path, delayed queue proposal validation, delayed transfer execution validation, recovery nonce-advance cancellation recognition, immediate freeze, and maintenance-only delegatecall admission.
- Exact `repairSigner` and `repairPolicy` APIs with Delay-only module execution, recovery-only queue repair authorization, signer distinctness, exact calldata, and fail-closed arbitrary-selector rejection.
- Immediate policy changes are limited to initialization or monotonic numeric tightening with recipient deletion-only updates.
- `src/queue/delay.ts`: exact Zodiac `keccak256(abi.encodePacked(to,value,data,operation))` queue fingerprint, separate Safe/Delay/queue-nonce monitoring fingerprint, queue/cancellation/execution builders, and paired hash/creation-time queue reads.
- Pinned Zodiac Delay v1.1.1 integration coverage for cooldown, FIFO, cancellation/setTxNonce, expiry/skipExpired, requeue, topology, malformed/trailing/mutated/duplicate queue cases, and arbitrary delegatecall/batch rejection.
- Atomic delayed signer repair now rotates the corresponding Safe owner and preserves maintenance authorization; a second replacement is tested.
- Passkey-plus-Burner emergency freeze/cancel authorization is tested alongside recovery-only authorization.
- `docs/security/call-graph.md` updated for owner, Delay, cancellation, emergency, and maintenance paths.

Verification:

- `npx hardhat test test/integration/delayed-tier.test.ts`: 5 passing.
- `npm test`: 38 passing.
- `npm run build`: passed.
- `git diff --check`: passed.

Concerns:

- The maintenance path necessarily uses one narrowly whitelisted `DELEGATECALL` because Safe 1.5 guard setters require Safe self-calls; arbitrary delegatecall and batching remain denied.
- Zodiac Delay deployment bytecode/topology and queue lifecycle must still be independently verified on the target test network before funds are deposited.
- The test fixture contains the pinned Delay v1.1.1 logic and a compiler-compatible Zodiac core surface; deployed Zodiac Delay bytecode/topology still requires independent target-network verification.
- No production-readiness or audit claim is made.
