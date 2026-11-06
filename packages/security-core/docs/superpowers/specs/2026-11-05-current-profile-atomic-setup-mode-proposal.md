# Current Profile Atomic Setup Mode Proposal

Status: accepted by the user on 2026-11-05; implementation and verification gates apply.

The real seven-transaction deployment rehearsal found a mismatch: the current profile requires `baseRecipientMode: "any-valid-address"`, but `SafeAtomicSetupHelper` still calls the six-argument `setAssetPolicy` overload. That overload initializes `Allowlisted`. All seven transactions can succeed before final topology correctly rejects the deployed policy. Existing helper tests did not exercise the complete current provisioning plan.

Repository instructions require a focused proposal before changing security-critical Solidity beyond `TieredSpendingGuard`. The user explicitly approved this helper correction. Keep deployment blocked until its gates pass. Do not accept the wrong policy or change the old vault.

## Proposed Scope

- Extend the existing helper's asset initializer with explicit `uint8 baseRecipientMode`.
- Call only the canonical seven-argument guard policy initializer. Validate the mode through the existing guard. No new authority, execution path, storage, delegatecall target, or post-setup privilege.
- Extend the TypeScript atomic setup ABI/encoding with the reviewed per-asset mode. Preserve exact recipients, amounts, chain, signer identities, and immutable bindings.
- Recompile and pin the new helper artifact in newly generated unsigned deployment packages. Old deployment packages, journals, bytecode commitments, browser archive, and vault remain unchanged.
- Do not reinterpret old helper calldata using the new ABI. Historical verification keeps the original artifact; fresh setup uses the new one.

## Required Proof

- Preserve the failing full current-profile deployment regression.
- Prove real Safe atomic setup initializes the exact explicit mode and policy hash; both owner and module guards, restricted Delay, signer configuration, and zero fallback remain correct.
- Prove allowlisted mode still initializes explicitly, and invalid modes revert atomically without a usable partially configured Safe.
- Re-run adversarial setup/provisioning, core, backend, and browser gates. Independently review the helper ABI, generated package artifact hashes, and calldata.
- Complete sending/reconciliation local rehearsal before any fresh Sepolia deployment. User performs both real device credential ceremonies.

## Rollback

Before deployment, revert the helper/encoder change together. Keep historical artifact verification intact. After any fresh deployment failure, retain all evidence and reject write readiness; do not reuse or silently repair the failed lineage. No transaction is sent to the old vault.
