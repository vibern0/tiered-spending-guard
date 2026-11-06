# Phase One: One-Time Setup and Everyday Wallet Runtime

Status: rejected by the user on 2026-11-05. Automatic in-app setup is non-negotiable. No separate deployment/setup command may be required. This document records an unimplemented historical proposal, not current implementation authority.

The earlier allowance for outside-app setup was clarified after the command requirement was explained. Keep the existing approved automatic registration → backend provisioning → verified account flow. User actions are the actual device ceremonies and wallet approvals, not provisioning commands, file selection or manual recovery. The remaining sections are superseded proposal text.

## Intent

Finish the existing Sepolia wallet: two real passkeys, verified USDC balances, X/Y spending, cancellable Z, delayed recipient additions and reliable receipt recovery. Keep the current Safe/guard/Delay security properties. Separate deployment work from everyday backend startup.

The user accepts a one-time setup outside the app. Proposed implementation choice: a command in `apps/backend` owns setup; the browser remains necessary for real device passkey ceremonies. No native Safe/ERC-4337, sponsorship, signer recovery, new contract, new dependency, database or hosted service belongs to this change.

This implementation packet targets the current localhost milestone first. Stable HTTPS, a distinct RP-bound Safe and installed-mobile live proof remain Phase One completion gates afterward, as required by the approved PWA design. This packet neither implements temporary HTTPS ingress nor claims all of Phase One complete when localhost works.

## Approaches

1. Keep automatic deployment in ordinary web onboarding. Reuses today's entrypoint but retains the deployment/recovery/startup coupling that prompted this review.
2. One-time backend command plus a completed account record. User selected outside-app setup; this is the recommended concrete implementation. Reuse existing deployment machinery, then let normal startup verify a completed account independently.
3. Move current provisioning records into D1. Changes storage but preserves the coupling; defer until hosted persistence is needed.

This is an offchain operational change. It does not relax onchain policy or constitute Phase Two implementation.

## Setup Command

Add a separate backend setup command. Proposed command name: `pnpm --dir apps/backend setup`. It runs exclusively on the existing loopback origin/port; normal wallet service and setup service cannot bind that port simultaneously.

- Fresh setup temporarily serves only the existing origin/RP-bound WebAuthn registration flow and public setup status. The user registers both genuine devices in the browser. The command owns execution after registration; ordinary browser startup never initiates deployment.
- Resume reads the existing reviewed plan, authorization records and deployment journal. For the current attempt, preserve the confirmed primary/secondary signer deployments and continue the exact remaining plan. Do not create substitute credentials or rebase addresses automatically.
- Reuse exact artifact verification, two-provider quotes, live payer nonce checks, cost cap, shared writer lease, hash-before-broadcast and six-confirmation receipt checks.
- An uncertain transaction reconciles only its recorded hash. Partial or failed deployment cannot publish a usable account record.
- After complete topology verification, atomically publish one public account record outside the repository, then stop setup service. Start the ordinary backend separately.
- Retain deployment/review/authorization files for recovery and audit. They are setup inputs, not ordinary backend inputs.

The current `estimateGas` failure remains a setup blocker to diagnose and resolve. Moving it to a command does not itself fix that RPC failure.

## Completed Account Record

One versioned record for one current-profile account; no general account registry or CRUD API. Proposed configuration: `BACKEND_ACCOUNT_PATH`.

Record the chain/profile version; Safe, guard, Delay, maintenance and signer identities; both public P-256 key/verifier bindings; the original fixed policy and initial elevated recipients; supported artifact/code commitments; WebAuthn RP/origin; and canonical setup transaction/block evidence. Include the stable account/deployment commitment used by intent and observer evidence.

Exclude private keys, assertions, signatures, raw signed transactions, browser-controlled verification flags, gas quotes, deployment progress and the deployer's current nonce. Credential references may be public metadata; actual device assertions remain required to bind each role after restart.

A record is configuration, not proof. Reject unknown versions and extra authority-shaped fields. Expected artifacts come from the committed supported profile/resolver, never solely from hashes supplied by the record. Only fresh production verification may issue an in-memory capability; JSON and object clones cannot self-brand.

## Ordinary Backend

`dev` loads ordinary server configuration, the completed account record and the durable submission journal. It does not construct a provisioner, scan deployment reviews, replay deployment journals, acquire a deployment writer, or sign deployment transactions.

Verify the configured account using both fixed providers at one canonical block: chain/token/dependency runtimes, exact signer factory/key/verifier bindings, component artifacts and immutable links, primary-only Safe ownership/threshold, both guards, Delay-only modules, zero fallback, disabled ECDSA secondary, mandatory timing and exact fixed X/Y/mode. Verify canonical setup evidence. Only reviewed onchain recipient additions may update the projected policy; preserve original recipient-prefix and stale-repair rules.

Replace the current original-plan requirement at the submission boundary with a production capability derived from this fully verified configured account. Preserve artifact provenance, exact transaction binding and all adversarial checks; do not introduce a test-brand or arbitrary import shortcut. Original creation nonces and a historical payer nonce are not everyday spending authority. Fetch the gas payer's current latest/pending nonce for each actual outer submission as today.

Keep passkey rebind, closed intents, primary-first approvals, simulation/revalidation, durable exact hashes, shared payer serialization and six-confirmation observations. Missing account configuration starts the server as unconfigured with writes disabled and a clear setup instruction. Invalid configured evidence fails closed. Neither case silently enters deployment mode.

The shared payer lease uses a neutral path derived from the existing submission-journal location and is used by both commands. Holding it does not parse or open a deployment journal. Setup alone additionally owns its deployment journal writer. Retain the same unresolved-submission check before any new payer signature.

## Browser

Ordinary launch reads the configured account, verifies its chain projection, binds existing passkeys and opens the wallet. Registration is available only while the separate setup command is running. Remove automatic deployment/retry calls from ordinary onboarding; show the one-time setup instruction when no account is configured. Browser state never selects arbitrary contracts, artifacts or policy.

Preserve the historical account archive and its 20 test USDC. The current new credential references remain intact. Resume rebind uses the existing keys when needed, rather than requiring another registration. No funding or balance migration is automatic.

## Preservation and Rollback

Add the account record and verifier before switching runtime composition. Reuse preserved deployment inputs to finish or diagnose the current partial deployment. Publish only after verification; compare manifest identities and live state before enabling writes. Keep the old environment and all original deployment files byte-for-byte. Rollback restores the prior configuration/entrypoint with those records; it never rewinds chain transactions or deletes an account. No mixed writer can run while setup owns the exclusive lease.

## Completion Gates

- Normal startup succeeds with a valid account record when deployment directories are unavailable; no deployment, authorization or original-deployer-nonce read occurs.
- Missing/changed code, signer, owner/module/fallback, policy, token, chain or canonical block prevents writes. Untrusted/edited records and cloned capabilities reject.
- Setup resumes the confirmed signer prefix exactly; duplicate invocations and unknown outcomes cannot replay transactions; failure leaves no completed record.
- Public account and submission records survive restart without raw approval material. Both device roles rebind correctly; changing RP/origin rejects.
- Repeat the real-cryptography local base/step-up/delayed/recipient/cancel/expiry/restart suite and app/backend/core gates.
- Finish actual Sepolia deployment, verify it independently, then exercise low-value user-approved sends and queue lifecycle. Retain separate non-authorizing observer evidence; independent notification delivery remains deferred. No local test substitutes for devices or live receipts.
- After this localhost packet, keep HTTPS/mobile listed as an outstanding Phase One milestone; do not relabel it Phase Two or infer completion from local evidence.

## Builder Decisions

Choose internal module names, parser layout and existing verifier extraction boundaries. Keep one account and the existing filesystem primitives for this change. Preserve existing HTTP error/redaction and exact-origin rules. Document the setup/runtime commands and external configuration split. No Solidity or dependency changes are authorized by this design.
