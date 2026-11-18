# Task 3 report

## Status

Implemented Task 3 only: typed deployment evidence, fail-closed read-only runtime verification, Policy Engine lessons, rejection-first unit tests, and the Sepolia verifier entrypoint.

The default registry records official Safe 1.5.0 Sepolia registry evidence and Zodiac Delay 1.1.1 provenance. Passkey and Delay runtime evidence remains intentionally incomplete in the default registry because this checkout has no committed official deployment/hash evidence for those components; resolution therefore fails closed rather than treating package source or an address-only registry entry as a deployment claim.

## Verification

- `npm run test:unit`: 17 passing.
- `npm run build`: passed; Hardhat reported `Nothing to compile`.
- `git diff --check`: passed.
- `npx tsc --noEmit`: existing repository/dependency errors remain in `legacy/test/RecentTransactionGuard.ts` and `node_modules/viem/node_modules/ox`; no errors remain in Task 3 files.
- `npm run verify:dependencies`: blocked exactly because `SEPOLIA_RPC_URL` is unset: `SEPOLIA_RPC_URL is required; refusing to verify without an explicit read-only endpoint`.

No deployment, signing, audit, or production-readiness claim is made.

## Review fix round

- Production `resolveVerifiedDeployments(client, chainId)` now uses only the deeply frozen official registry and has no registry override parameter.
- Fixture injection is isolated to the explicitly internal `resolveVerifiedDeploymentsForTest` helper and covered by tests; extra caller arguments do not replace production metadata.
- The default registry records passkey and Delay evidence as explicitly absent where official address/runtime-hash evidence is not committed, so the verifier fails closed with a specific missing-evidence error instead of making a false verification claim.
- Every deployment address is checked for well-formedness and nonzero value before the first RPC read for that dependency.

Fix-round verification:

- `npm test`: 19 passing.
- `npm run build`: passed.
- `git diff --check`: passed.
- `npx tsc --noEmit`: no errors reported for Task 3 files; unrelated legacy/dependency diagnostics remain outside this task.

The default registry remains testnet research evidence only; missing official passkey/Delay deployment evidence is a concern for later deployment work, not a production dependency claim.
