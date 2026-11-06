# Phase One Automatic Setup Requirement

Status: explicit user requirement, 2026-11-05.

Automatic setup is non-negotiable. The separate setup/deployment command proposed in `2026-11-05-phase-one-one-time-setup-design.md` was rejected before implementation.

With the normal app/backend running, the product flow remains:

1. The user completes the two genuine passkey device ceremonies in the app.
2. The backend automatically creates or resumes the reviewed deployment.
3. The backend manages its operational records, canonical receipts and final verification.
4. The app loads the verified account and enables the appropriate wallet actions after required factor binding.

No user deployment command, manual contract deployment, provisioning-file selection, hand-edited nonce, approval file or backend restart as an ordinary recovery step may be required by the intended product flow. Backend implementation boundaries may separate setup from runtime internally while preserving one automatic user journey.

Preserve exact authorization, code/topology/policy checks, device prompts, budget bounds and durable hash reconciliation. Automatic recovery must not silently retry uncertain broadcasts, change a reviewed deployment layout or enable an unverified vault. Nonrecoverable conditions remain explicit failures until a safe recovery is implemented.

Implemented and locally tested through actual HTTP with software WebAuthn signatures. The preserved live setup completed automatically on Sepolia at Safe `0x5C237D200dF5b7B8959054fb51c368Ca5120847f`; all seven deployment receipts and final topology were verified. Ordinary backend restart restores the completed account without signing or broadcasting. Both actual existing passkeys still require genuine assertions before spending is enabled. Original signer deployments, original records and the historical vault’s 20 test USDC remain intact. See the automatic HTTP validation plan for evidence and remaining Phase One device/mobile/alert gates. Phase Two remains outside this work.
