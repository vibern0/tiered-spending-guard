# Task 4 report

Status: complete for the Task 4 boundary; testnet/security-research prototype only.

Implemented:

- Exact Safe 1.5 transaction-hash reconstruction using the post-increment `nonce - 1`, including chain, Safe, target, value, calldata, operation, gas, token, refund receiver, and nonce.
- Canonical one-slot Safe contract-signature decoding for the configured passkey. Approved-hash, non-contract, malformed, wrong-owner, and ambiguous trailing forms fail closed; Safe validates the EIP-1271 payload through `checkNSignatures`.
- Burner extension format `[burnerSignature][uint256 payloadLength][bytes32 typeHash]`, with versioned type hash `keccak256("TieredSpendingGuard.BurnerSignature.v1")`, exact Safe-hash verification through OpenZeppelin `SignatureChecker`, and per-hash authorization replay tracking.
- Safe transaction-guard and Safe 1.5 module-guard interfaces, Safe-only entry checks, `safeTxGas == 0`, `gasPrice == 0`, reentrancy gate, and failure-reverting after-execution hooks.
- Unit tests and an integration test using a deployed Safe 1.5 singleton behind a SafeProxy; the legacy mock is not used.

Verification:

- `npm test`: 23 passing
- `npm run build`: passed
- `git diff --check`: passed

Concerns carried forward:

- Spending-tier classification/accounting, Delay queue policy, cancellation, and topology hardening remain Task 5/6 work.
- `Mock1271Signer.sol` is test-only and deliberately accepts any EIP-1271 payload; it is not a production signer.
- The repository now compiles for Cancun because the pinned OpenZeppelin 5.6.1 `SignatureChecker` uses `mcopy`; deployment-chain activation must be verified before testnet use.

## Follow-up review fixes

- Added real EIP-712 ECDSA Burner tests against the configured Burner owner for exact-hash acceptance, target/value mutation, wrong chain, wrong Safe, wrong nonce, malformed/empty envelope, and replay rejection.
- Added Safe 1.5 module-guard integration coverage for the configured module, rejection of an unconfigured module, failed-module after-execution rollback, and subsequent successful module execution.
- Added rejection of nonzero high bits in the Safe contract-signature owner word before address conversion.
