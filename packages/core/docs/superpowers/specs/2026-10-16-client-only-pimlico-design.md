# Client-Only EURC Wallet With Pimlico

**Date:** 2026-10-16
**Status:** Reviewed design proposal; compatibility gate unresolved. No implementation or deployment approval implied.
**Baseline:** `origin/main` at `918bf8e`; includes backend PR #10 and onboarding/settings PR #9.

## Intent

Ship the wallet as static browser assets. Remove `apps/backend`, its HTTP endpoints, relay private key, filesystem journal, external artifact files, and dynamically loaded adapter. Use Pimlico for ERC-4337 bundling and sponsored gas. Keep one asset-holding Safe, primary passkey ownership, guard-only secondaries, onchain X/Y/Z policy, and cancellable Zodiac Delay.

No application server or database is required for wallet operation. Browser storage holds public account metadata and reconciliation records. Independent read-only monitoring remains mandatory and may run outside the app; a browser that is closed cannot provide reliable independent alerts.

This document is the focused account-abstraction proposal required by `AGENTS.md` and the signer evaluation. The user approved preparing this spec, its review, and the implementation plan together. The existing backend-required instruction remains active until the migration gates pass and its replacement lands.

## Findings that constrain the design

1. `TieredSpendingGuard.checkModuleTransaction` accepts only the configured Delay. Its single `checking` flag rejects nested guard checks. Enabling Safe4337Module without changing enforcement cannot work.
2. The owner guard verifies primary/secondary approval over the exact `SafeTx` digest. Safe4337Module validates a different `SafeOp` digest, then executes through `execTransactionFromModule`; that hook does not carry the original signatures. A module allowlist entry alone would not prove the required secondary approval.
3. The reviewed upstream candidate inherits `CompatibilityFallbackHandler`. The inherited Safe-message/ERC-1271 surface must be tested against the arbitrary-message prohibition. A frontend allowlist cannot constrain a compromised passkey or browser. Standard module installation is not accepted as compatible yet.
4. The existing deployment builder depends on prerequisite deployments and deterministic addresses. A paymaster does not itself deploy arbitrary prerequisite contracts. A complete supported factory/bootstrap path must be demonstrated.
5. The research baseline requires ordinary Safe real-cryptography local and live validation before ERC-4337 implementation. The EURC evidence report still marks its live rehearsal outstanding. Reuse concrete existing evidence only when it meets that gate; otherwise record the prerequisite as blocked.
6. The current WebAuthn browser adapter expects a 64-byte P1363 response; real browser WebAuthn uses DER ECDSA signatures. Replacing server verification requires a real registration/public-key extraction and assertion verification path, including DER parsing.

These findings correct earlier conversational claims that Safe4337Module could simply be added while retaining the current guard unchanged.

## Approaches and decision

| Approach | Benefit | Cost / decision |
| --- | --- | --- |
| Direct Safe4337Module transfers | Standard SDK flow | Rejected as default: existing signature and module guard guarantees do not carry over. |
| Safe4337Module transports an exact signed `Safe.execTransaction` | Preserves existing `SafeTx` policy authorization inside the outer `SafeOp` | Preferred candidate for the compatibility investigation. Requires nested-check design, restricted fallback evidence, simulation proof, and additional primary approval. |
| Keep backend or add another custody account | Avoids some integration work | Outside requested target. Do not introduce as a silent fallback. |

The selected target is the second approach, conditional on the compatibility gate. Do not implement a custom module, fallback handler, factory, or additional security-critical Solidity to force it through. If an accepted property requires one, stop with a separate focused proposal under `AGENTS.md`. Do not delete the backend while that gate is unresolved.

## Compatibility gate

Produce `docs/security/pimlico-compatibility.md` with exact package versions, source commits, audit scope, runtime hashes, canonical Sepolia addresses, selectors, storage assumptions, and executable evidence for the complete path. The report must resolve all of these:

- Safe `1.5.0`, Safe4337Module candidate, EntryPoint version, passkey factory/verifier, Delay, and Pimlico/permissionless compatibility.
- Exact module/fallback surface; reject arbitrary Safe ERC-1271 messages, Permit/Permit2, approved hashes, direct module transfers, unlisted modules, and fallback installation bypasses onchain.
- An exact zero-value `CALL` from the pinned module to the same Safe's `execTransaction`, carrying canonical inner Safe transaction fields and primary/secondary signatures. Decode and bind the whole envelope; no arbitrary self-call exception.
- Inner owner guard runs once, consumes X/Y once, verifies the exact original `SafeTx`, and reverts failed execution. Outer module checks cannot bypass inner checks or permit cross-call reentrancy. Direct ordinary owner transactions remain constrained.
- Separate Safe nonce and EntryPoint nonce; explicit nonce key; no reuse of one as the other. Outer `SafeOp`, EntryPoint user-operation hash, inner `SafeTx`, and Delay fingerprint remain distinct.
- Sponsorship only: no vault ETH prefund, EntryPoint withdrawals, ERC-20 paymaster approvals, token charges, or gas refunds from the Safe. Failed sponsorship blocks sending. The module's missing-account-funds path must fail closed without spending vault assets.
- Local real EntryPoint/module/passkey execution plus ERC-4337 bundler validation, including storage-access/staking restrictions. A passing Hardhat transaction alone does not establish bundler acceptance.
- Sponsored fresh deployment of every prerequisite, atomic protected Safe initialization, and public evidence verification without an EOA relay key, hidden deployer key, external executable adapter, or transient unguarded asset-holding state.
- Sponsored queue creation, cancellation, freeze, delayed maintenance, expiry handling, and ready Delay execution. Permissionless execution after Z must not depend on the original primary/secondary being online; identify a reviewed non-custodial submission route accepted by Pimlico or report this requirement blocked.

Passing requires all rows evidenced. The standard upstream candidate currently has unresolved conflicts, especially the inherited fallback and permissionless Delay transport. Mark the report `blocked` with evidence when no compliant path exists. Never claim the plan has established feasibility merely because the documents are complete.

## Target browser architecture

```text
Static host
  React / TanStack Router / browser WebAuthn
    verified public deployment manifest + RPC reads
    exact inner SafeTx review + required factor approvals
    final outer SafeOp approval
    Pimlico verifying paymaster + bundler
      pinned EntryPoint / reviewed Safe4337 path
        inner Safe owner transaction + TieredSpendingGuard
          EURC transfer OR Zodiac Delay queue/control
Independent read-only observer
  confirmed guard/Delay events + separate notification channel
```

This is the conditional target, not an assertion that today's contracts implement it. Guard and Delay remain authoritative even when the browser, static host, RPC endpoint, or Pimlico is malicious. Providers may deny service but cannot create authorization or expand limits.

### Static runtime

Use Vite + React + TanStack Router directly. Keep route components, query cache, wallet provider, Tailwind, onboarding completion gate, settings, and first/second-signer language. Replace TanStack Start/Nitro/Cloudflare SSR build glue with an `index.html` browser entry and route generation. No server functions, server routes, database, proxy API, or runtime private environment variables. The landing app remains separate.

Output `apps/app/dist` contains static assets only. Deep links require the host's SPA fallback. Browser wallet code imports no Node filesystem, crypto, HTTP-server, or dynamic external-module dependencies.

### Public configuration and sponsorship

Use `VITE_SEPOLIA_RPC_URL`, `VITE_PIMLICO_BUNDLER_URL`, `VITE_PIMLICO_PAYMASTER_URL`, `VITE_PIMLICO_SPONSORSHIP_POLICY_ID`, and `VITE_WEBAUTHN_RP_ID`. Public URLs may contain a credential explicitly approved by Pimlico for browser distribution. Every `VITE_*` value and every browser request is visible. Never embed an unrestricted billing/admin key, private RPC secret, or server credential. If Pimlico cannot provide an acceptable browser-exposed credential with bounded sponsor exposure, client-only sponsorship remains blocked; do not add a secret-bearing proxy silently.

Use Pimlico's verifying paymaster. Enforce provider-side Sepolia/account/operation restrictions where supported, global/per-sender/per-operation budgets, expiry, and rate limits. Origin controls are an abuse-reduction measure, not secret protection or vault authorization. Verify the exact available controls during implementation; unsupported controls must be stated explicitly. No ERC-20 paymaster, approvals, or token gas charging in this migration.

Bundle a public reviewed manifest into the static build. Manifest binds chain, Safe/EntryPoint/module/factories/verifiers, allowed asset, creation/runtime hashes, audit/source evidence, and compatibility-report hash. Validate code and full topology through RPC before any wallet write. A JSON `verified: true` flag is never evidence.

### Passkeys and account identity

Create registration challenges with `crypto.getRandomValues`; derive RP ID/origin from reviewed deployment configuration. Support `localhost` development and a stable HTTPS production origin. RP ID changes are an identity migration; deployment previews must not create credentials expected to work on another domain.

Validate credential ID, `webauthn.create`, challenge, RP ID hash, origin, cross-origin flag, user presence/verification, supported COSE P-256 key, and point encoding. Extract public coordinates through reviewed browser-compatible APIs/library. Require proof of possession before account setup; validate real cryptography, not a fabricated registration boolean. Onchain verification remains the authorization boundary. Authenticator counters are advisory signals, not a replacement for onchain nonces.

Store credential ID, public coordinates, RP ID, signer role/address, chain, Safe address, deployment salt, manifest/policy hashes, and deployment/operation hashes in IndexedDB. Never store passkey private keys, raw assertions, reusable signatures, relay keys, provider secrets, or raw signed UserOperations. Public metadata export/import supports restoring a browser on the same RP domain, followed by onchain re-verification. Metadata loss never authorizes another account or silently creates a replacement vault.

Parse DER ECDSA strictly into `r`/`s`; validate the actual authenticator data and exact signed `clientDataJSON` fields. Do not reconstruct different JSON fields than were signed. Before submitting, verify the assertion against the configured passkey contract and exact digest. Support first and second signer registration without hardcoding every authenticator to platform-only; retain the approved configured secondary kinds.

### Transaction construction and approval

Build advisory classification from one consistent confirmed chain snapshot. Re-read topology, nonce, policy, recipient list, token metadata, spend window/counters, and queue state before signing and submission. Onchain guards reject any later state drift.

Build the canonical inner `SafeTx` using existing zero gas/refund conventions. Primary authorizes that digest; the required configured secondary authorizes the same digest for step-up, delayed proposal, cancellation/freeze, and maintenance. Do not append guard-only secondary envelopes to Safe4337Module's outer owner signature and assume they are checked there.

Wrap the approved inner bytes only through the compatibility-approved module path. Estimate/sponsor with documented dummy signatures, then finalize gas, paymaster data, validity window, factory/initCode, callData, nonce, chain, EntryPoint, and module. Compute the final `SafeOp` digest and EntryPoint user-operation hash independently. Primary approves the final outer SafeOp. Any subsequent field change invalidates that approval and requires a new review/signature. Explain the two primary approvals in the UI; do not promise a single prompt this design cannot supply.

No instant batch/delegatecall, unknown calldata, approvals, Permit/Permit2, arbitrary messages, extra owner, session key, or unreviewed module. Reviewed bootstrap and existing delayed maintenance exceptions remain precisely enumerated.

### Submission and reconciliation

Persist an immutable public intent record, inner digest, final user-operation hash, Safe nonce, EntryPoint nonce/key, manifest/policy hashes, and queue identity before the send request. Use IndexedDB transactions and a browser lock to serialize submissions per Safe across tabs. Another device may race; onchain nonce/policy checks remain final.

State machine: `prepared`, `submitting`, `uncertain`, `included`, `confirmed`, `reverted`, `expired`, `superseded`. A send timeout becomes `uncertain`. Reload queries the exact hash, canonical receipt, EntryPoint nonce, Safe nonce, and actual Safe/Delay execution evidence. A missing bundler result is not proof the operation was never accepted. Do not automatically sign a replacement or rebroadcast changed bytes while uncertainty remains. Browser storage loss requires chain reconciliation or an explicit unresolved state.

An outer transaction receipt is insufficient. Validate EntryPoint `UserOperationEvent` sender/hash/success, inner Safe result and guard events, token balance effects, or exact queue transition. Distinguish outer success from inner failure. Require the configured confirmation depth and roll back observations on reorg. Queued actions stay queued until Delay actually executes; elapsed time alone never means executed.

## Removal and compatibility policy

One implementation branch/PR may contain the whole migration, in gated commits. Introduce and prove the replacement first; delete `apps/backend` only after local contract, bundler, browser, deployment, and reconciliation tests pass. Remove backend-only dependencies, workspace entries/importer, `BACKEND_*`, `VITE_BACKEND_ORIGIN`, endpoint client/tests, stale ignores, and active setup instructions. Update root scripts so `npm test` and the security gate cover the replacement.

Preserve security tests by moving reusable exact digest, role ordering, uncertainty, and receipt cases into the new browser/core suites before deletion. Keep legacy research and historical evidence labeled historical. Preserve unrelated UI changes from `918bf8e`.

Existing backend-provisioned Safes remain read-only in the new app until separately reviewed migration is available. Never enable the new module/fallback on a funded existing Safe during onboarding. Fresh deployments use the new verified profile; metadata cannot convert an old profile into a new one.

Update `AGENTS.md`, research supersession notes, the core implementation plan, signer evaluation, call graph, dependency review, testnet runbook, and app README in the same migration. Change only the specifically approved backend/topology/transport clauses; preserve the remaining security properties. Keep the existing independent monitoring tool; require observer readiness before claiming delayed-tier readiness.

## Acceptance and boundaries

- No app-owned backend process, filesystem configuration, database, relay private key, or privileged browser credential.
- One statically hosted app can register factors, restore public metadata, provision a guarded Safe, send X, step up within Y, queue above Y, cancel/freeze, expire and execute after Z, and verify all outcomes through Pimlico/RPC.
- Real Safe `1.5.0`, pinned EntryPoint/module/passkey contracts, real Zodiac Delay, genuine WebAuthn cryptography, and a local standards-enforcing bundler prove every execution path. No permissive legacy mock.
- Adversarial mutations include every inner/outer digest field, paymaster/factory substitution, role/credential/domain changes, malformed signatures, concurrent tabs/devices, stale counters/nonces, unknown modules, arbitrary ERC-1271 messages, reorgs, closed/reloaded browsers, dropped receipts, and uncertain submissions.
- Independent observer tests cover step-up and the complete delayed lifecycle with no signing capability.
- Static build/deep links, browser tests, security-core tests/invariants/coverage/Slither, and root gates pass. A capped live Sepolia rehearsal remains separately authorized and recorded.
- Sepolia (`chainId = 11155111`) only. No WalletConnect, mainnet, arbitrary DeFi, or production/audit claim.

## Source checks and candidate pins

Checked 2026-10-16. Registry observations are candidate inputs, not audit or deployment approval: `permissionless@0.5.0` (peer `viem ^2.44.4`), existing `viem@2.56.7`, `@safe-global/safe-4337@0.3.0-1`, `@safe-global/safe-modules-deployments@3.0.11`. The Safe4337 package reports source commit `75e56fd52b0ddbe01dc237eaae7edb9a102ffc5c` and a dependency on `@safe-global/safe-contracts ^1.4.1-build.0`; inspect that exact resolved fallback, not only the newer singleton's source. The reviewed module candidate targets EntryPoint `0.7`; exact canonical addresses, source/package correspondence, audit coverage, bytecode, and Safe `1.5.0` interoperability are Task 1 deliverables. Never choose SDK defaults that deploy Safe `1.4.1` and lose module guards.

Primary sources:

- [Safe ERC-4337 architecture](https://docs.safe.global/advanced/erc-4337/4337-safe): module/fallback validation and execution path.
- [Safe4337Module v0.3.0 source](https://github.com/safe-fndn/safe-modules/blob/4337/v0.3.0/modules/4337/contracts/Safe4337Module.sol): inherited fallback, SafeOp domain, prefund, and module execution.
- [Safe 1.5.0 CompatibilityFallbackHandler source](https://github.com/safe-global/safe-smart-account/blob/v1.5.0/contracts/handler/CompatibilityFallbackHandler.sol): Safe-message surface; inspect the module package's actual inherited version separately.
- [Safe 1.4.1 CompatibilityFallbackHandler source](https://github.com/safe-global/safe-smart-account/blob/v1.4.1/contracts/handler/CompatibilityFallbackHandler.sol): both legacy and current ERC-1271 message-validation entry points in the older dependency family.
- [Pimlico permissionless.js](https://docs.pimlico.io/references/permissionless): Safe integration and ERC-4337 clients.
- [Pimlico infrastructure](https://docs.pimlico.io/guides/getting-started): bundler and verifying-paymaster roles.
- [Pimlico sponsorship controls](https://docs.pimlico.io/guides/why-pimlico/enterprise): published budget controls; verify account availability and browser key policy.
- [TanStack Router installation](https://tanstack.com/router/latest/docs/how-to/install): browser router integration.
- [WebAuthn Level 3](https://www.w3.org/TR/webauthn-3/): credential creation, authenticator data, and ECDSA signature encoding.

## Spec self-review

Reviewed against research, the core plan, signer evaluation, current guard, browser adapter, and upstream module source. Resolved false assumptions about digest reuse, unchanged module guard compatibility, secret browser API keys, native deployment sponsorship, browser-closed monitoring, and browser signature encoding. Kept the outstanding fallback, permissionless Delay transport, bootstrap, and bundler-validation questions as explicit fail-closed gates. No active code or security rule changed by this document.
