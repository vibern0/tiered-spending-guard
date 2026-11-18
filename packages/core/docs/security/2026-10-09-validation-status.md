# Validation Status: 2026-10-09

## Ordinary Transactions

Status: local policy implementation validated; bootstrap live evidence recorded; vault live phase incomplete.

- Sole primary passkey Safe owner, threshold one. Contract/ECDSA secondaries authorize through the guard.
- Atomic single-owner setup; primary owner/config swap; guard-only secondary rotation. Post-setup topology verification includes maintenance code and bindings.
- Real Safe passkey contracts verify generated P-256/WebAuthn assertions. Native/ERC-20 X/Y, both secondary formats, wrong secondary digest, replay, failed-execution accounting/approval rollback, queue, cancellation, expiry, local elapsed delay, freeze and rollover tested.
- `npm run security:check`: passed. Full suite 287; invariants 4; coverage 285 passed/2 intentional skips; Slither 11 reviewed findings; local rehearsal passed. Coverage does not execute the two runtime-hash-bound cases; the ordinary suite does.
- `npm run verify:dependencies`: verifies the five public pinned Safe/passkey dependencies on Sepolia. Full credential-specific verification has also been exercised against the primary signer, but needs a committed public evidence-file workflow before it is a reproducible command.
- The live runner has plan, preflight, submit, resume, and evidence stages with an exclusive durable journal and canonical receipt reconciliation. Its bootstrap allowlist permits only a zero-value self-probe and verified factory signer creation; it is not a vault deployment or scenario runner. Secret files remain private and outside the repository.
- Sepolia bootstrap receipts: [self-probe](https://sepolia.etherscan.io/tx/0x382e6cc309b7925fe462159edc35e411a10be3a9a0961194aff42d97ba2cc14a), [primary signer](https://sepolia.etherscan.io/tx/0x43d5993748d43b19308d32982caaf45bc55b805b88936c1c57328eac74392496), and [secondary signer](https://sepolia.etherscan.io/tx/0x916fb30007202b3f7ed2b250115c3e7604fdba04c8f53dbb30365778c8b48191) all succeeded. They prove isolated automated credentials and the submission boundary, not Safe/guard/Delay policy behavior.
- Remaining tests: forced `swapOwner` failure after guard mutation; complete live matrix and independent monitoring reconciliation. Local Delay uses the compatibility fixture, not an approved live artifact. No hardware-passkey or live daily-rollover claim.

## ERC-4337

Status: not implemented or tested. Blocked by the required ordinary-path live gate. Restricted fallback design review must precede any additional security-critical Solidity. No UserOperation, EntryPoint deposit, bundler acceptance, or onchain result claimed.

## Demo

Status: deliberately unchanged. Integration follows both verified live phases. No chain-backed demo or device-passkey claim.

## Tooling Limits

Standalone TypeScript checking is not clean across the repository (dependency/compiler compatibility, legacy tests, existing type errors). Codacy MCP analysis was unavailable; reconnect/reset that MCP integration to run the prescribed scan. Passing local tests is neither independent review nor an audit. This remains testnet security research, not production-ready custody.
