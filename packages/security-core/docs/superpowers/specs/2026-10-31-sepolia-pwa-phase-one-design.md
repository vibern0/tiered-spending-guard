# Sepolia PWA Phase One Design

**Date:** 2026-10-31  
**Status:** Proposed; awaiting product approval before implementation planning  
**Baseline:** `origin/main` at `6bcc266`  
**Target:** Installable PWA proving the existing ordinary-Safe X/Y/Z policy on Sepolia

## Intent

Finish the existing React wallet as the first mobile product surface. Phase One proves the concept with a disposable, low-value Sepolia Safe and real WebAuthn credentials. It keeps the reviewed ordinary-Safe architecture: one asset-holding Safe, `TieredSpendingGuard`, Zodiac Delay, a primary passkey, a distinct secondary passkey, and the existing backend as the only browser write boundary.

The first runnable milestone is localhost. The second Phase One milestone serves the same PWA from one stable HTTPS origin and connects it to the developer-controlled backend through a temporary, access-controlled HTTPS ingress. Neither milestone uses ERC-4337, WalletConnect, a production relay, mainnet, or production claims.

## Phase boundary

### Phase One: Sepolia PWA proof

- Installable PWA using the existing `apps/app` codebase.
- Sepolia only, with Circle USDC at the reviewed address and six-decimal metadata.
- Localhost development and a separately configured stable HTTPS origin.
- Fresh disposable Safe for each WebAuthn RP ID.
- Primary-only X transfer, two-passkey Y transfer, and complete delayed Z queue/cancel/execute flow.
- Existing `apps/backend` remains the write boundary and gas/deployment payer.
- In-app, chain-derived activity plus mandatory independent read-only observer evidence; no notification delivery.
- Low-value manual funding, including the Circle Sepolia faucet when needed.

### Phase Two: deferred work

- Signer repair/recovery and proof that replaced credentials no longer work.
- Native Safe ERC-4337, sponsorship, and removal or replacement of the backend boundary.
- Independent notification delivery and user-facing alert channels. The non-authorizing read-only observer remains mandatory in Phase One.
- Hosted/mobile-grade relay operations, account recovery UX, and wider external-user readiness.
- Mainnet, production hardening, independent review, audit, app-store-native wrappers, and production claims.

In this design, **repair** means delayed primary or secondary signer replacement and recovery. It does not mean fixing broken application code. Deferring it means a lost passkey can permanently lock a disposable Phase One vault.

## Goals

1. Install the wallet from a browser and launch it in standalone PWA mode.
2. Provision a fresh, verified Sepolia Safe with two genuine WebAuthn credentials.
3. Show real USDC balance, policy, spend counters, Safe/guard/Delay topology, and queue state.
4. Execute and verify the three policy tiers:
   - up to X with the primary passkey;
   - above X and up to Y with primary plus secondary;
   - above Y only through the delayed Z path.
5. Cancel one queued item and execute a later queued item only after its canonical cooldown.
6. Recover safely from refresh, app restart, uncertain submission, and stale chain state without double submission.
7. Make all prototype limitations visible in the UI.

## Non-goals

- No mainnet or production deployment.
- No ERC-4337, bundler, paymaster, sponsor, session key, or account-abstraction module.
- No WalletConnect.
- No arbitrary calls, batches, delegatecalls, approvals, Permit/Permit2, unknown tokens, or unknown recipients.
- No signer repair, account recovery, policy expansion UI, or security-weakening maintenance.
- No independent notification delivery or user-facing alert channel in Phase One. A separate read-only observer still records live rehearsal evidence.
- No cloud database or long-running hosted relay service.
- No native iOS/Android wrapper in Phase One.

## Current state and gaps

The repository already has a responsive TanStack/React wallet, direct Sepolia reads, WebAuthn ceremony code, loopback backend, Safe transaction preparation, public wallet state, activity screens, and topology checks. It is a strong starting point, not a finished PWA.

The implementation plan must close these specific gaps:

1. The app has no web manifest, service worker, install icons, or standalone/offline behavior.
2. UI, types, tests, and backend contracts still say EURC although the configured Sepolia address is Circle USDC. The metadata validator currently expects `Euro Coin`/`EURC` and must be corrected to the reviewed USDC metadata and runtime.
3. The backend hardcodes `localhost`, a single origin, and platform-only authenticators.
4. Secondary registration is not a complete user flow.
5. The backend only prepares a direct token transfer. It does not expose the complete exact Delay queue, cancel, early rejection, ready execution, and reconciliation lifecycle.
6. The provisioner is an interface loaded from `BACKEND_PROVISIONER_MODULE`; Phase One needs one reviewed concrete Sepolia adapter using the existing security-core deployment and verification boundaries.
7. The limits editor suggests mutable local configuration even though X/Y/Z are authoritative onchain. Phase One must present verified values instead of implying an unsupported edit.
8. Public state persists, but app restart and uncertain-submission recovery are not yet a complete user journey.
9. The existing automated Sepolia evidence used test harness credentials. The PWA proof needs a fresh Safe whose signer contracts are bound to the actual WebAuthn credentials registered for that environment.

## Approaches considered

### A. Existing app + ordinary Safe + backend, then PWA packaging

Use the current app and loopback backend. Finish the two-passkey and X/Y/Z flows, add installability, and prove localhost before enabling one exact HTTPS configuration.

**Decision:** selected. It reuses the reviewed architecture, minimizes new security boundaries, and reaches a mobile proof without waiting for ERC-4337.

### B. Native wrapper now

Wrap the web app with Capacitor or write a native client immediately.

**Decision:** deferred. Native WebAuthn association, secure storage, deep-linking, and two mobile code paths add work without improving the onchain policy proof. A PWA provides the fastest honest mobile surface.

### C. Client-only ERC-4337 PWA

Remove the backend and use a bundler/paymaster.

**Decision:** Phase Two. The existing ERC-4337 design has additional fallback-handler, digest, bootstrap, provider, sponsorship, and monitoring gates. None is required to prove X/Y/Z.

### D. Hosted relay first

Deploy a permanent public backend before validating the local product loop.

**Decision:** deferred. Phase One begins with localhost. The later HTTPS demonstration uses temporary developer-controlled ingress to the same backend, not a production relay service.

## Chosen architecture

```text
Local milestone
  http://localhost:5173 PWA UI
    WebAuthn prompts + direct Sepolia reads
    http://127.0.0.1:8787 backend
      exact-origin/RP validation
      WebAuthn verification
      reviewed provisioning and SafeTx construction
      gas-only relay + durable submission journal
        Safe 1.5 + TieredSpendingGuard + Zodiac Delay
          Circle USDC on Sepolia

HTTPS milestone
  https://<stable-pwa-host> installed PWA
    WebAuthn prompts + direct Sepolia reads
    https://<temporary-private-backend-host>
      access-controlled TLS ingress
        same developer-controlled backend on the developer machine
          same onchain path
```

The browser never holds a relay private key and never invents authoritative transaction bytes. The backend is not an owner, secondary authorizer, unrestricted module, or policy authority. The Safe, guard, Delay, and exact passkey signatures remain authoritative.

The temporary HTTPS ingress is transport, not a new authorization layer. It must require an explicit developer access policy or short-lived capability, accept only the exact PWA origin, expose no administrative endpoint, and be disabled after the rehearsal. Its provider is an operational choice, not an application dependency. A public unauthenticated tunnel is not acceptable.

## Environment and WebAuthn identity

Phase One supports two explicit configurations:

| Mode | PWA origin | RP ID | Backend origin | Vault |
| --- | --- | --- | --- | --- |
| Local | `http://localhost:5173` | `localhost` | `http://127.0.0.1:8787` | Fresh local-RP Sepolia Safe |
| HTTPS | exact stable `https://` host | exact registrable host | exact protected `https://` backend host | Fresh HTTPS-RP Sepolia Safe |

Configuration is validated as one closed profile. No wildcard origins, preview domains, arbitrary RP IDs, or runtime origin guessing are allowed. The backend returns the configured origin and RP ID, and the browser checks them before opening a ceremony.

`localhost` and an HTTPS hostname are different WebAuthn relying parties. Their credentials are intentionally not portable. Each environment provisions its own disposable Safe. Switching profiles never relabels an existing vault or silently creates replacement credentials.

The primary uses a platform authenticator. Phase One completion requires a genuinely distinct secondary credential, preferably a cross-platform authenticator/security key. A second credential on the same device may unblock local development only behind an explicit warning: it demonstrates contract behavior but not device-factor separation, so it cannot satisfy the final localhost or HTTPS/mobile evidence gate.

## Provisioning

Provisioning is a closed operation, not a general deployment API:

1. Verify backend, chain, reviewed artifacts, runtime hashes, token identity, and journal readiness.
2. Register and verify the primary credential for the active RP.
3. Register and verify the secondary credential for the same RP with the configured authenticator policy.
4. Produce signer-contract inputs from verified credential public keys.
5. Use a reviewed adapter to deploy the existing fixed Sepolia topology and policy.
6. Wait for canonical receipts and re-read runtime, owner, module, guard, Delay, token, X/Y/Z, recipient, and signer state.
7. Store only public vault metadata and evidence identifiers in browser storage.
8. Refuse writes if any verification is missing or inconsistent.

The provisioner must reuse the approved atomic Safe deployment path and its reviewed security-core builders and verifiers. That path creates the Safe directly in its final guarded topology and exposes no bootstrap owner or removable bootstrap control. Phase One must not introduce staged bootstrap authority. The previously approved atomic-deployment availability decision permits deferring signer recovery for a disposable testnet vault while making lockout risk explicit.

It must not create a second deployment implementation or accept addresses, policy values, code hashes, recipients, or signers chosen by the browser.

Phase One uses this fixed reviewed USDC profile for each fresh vault:

- period: 86,400 seconds, anchored at Unix epoch boundaries;
- base per-transaction cap and base daily limit X: `1_000_000` units (1 USDC);
- step-up per-transaction cap and combined daily limit Y: `3_000_000` units (3 USDC);
- delay Z: 120 seconds;
- post-cooldown expiration: 600 seconds;
- sole transfer recipient: `0xaD4D5cd2Ec5beCdB9608baD4c36F0dBe8b2492Bc`;
- rehearsal amounts: 1 USDC base, 2 USDC step-up, and 4 USDC delayed;
- funding target: 8 USDC per vault, leaving 1 USDC after the successful delayed execution.

The cancelled and replacement delayed items both describe the same 4-USDC transfer, so cancellation does not increase principal outflow. The two Phase One vaults together need 16 USDC, within one 20-USDC faucet distribution if the funding account begins empty. Funding and gas caps still require separate unsigned review before live execution.

Phase One does not offer recipient additions or limit increases. Manual faucet funding happens only after the fresh Safe is verified.

## X/Y/Z transaction flows

### X: base instant transfer

1. User enters one allowlisted recipient and positive USDC amount.
2. App displays advisory classification from one confirmed chain snapshot.
3. Backend re-reads the authoritative vault, policy, spend, nonce, and token state.
4. Backend constructs one exact zero-value Safe `CALL` to USDC `transfer(address,uint256)`.
5. Primary passkey signs the exact Safe digest.
6. Backend verifies, journals, relays, reconciles, and confirms the onchain effect.

No secondary prompt appears when the authoritative state still permits the X tier.

### Y: step-up instant transfer

The same exact Safe transaction is approved first by the primary and then by the configured secondary. The backend preserves primary-first guard signature layout, rejects role substitution and changed bytes, and broadcasts only after both exact approvals. The app must show why the second passkey is required.

### Z: delayed transfer above Y

Above-Y value is never submitted as a direct transfer. The backend constructs an exact owner transaction to the configured Delay `execTransactionFromModule(to,value,data,operation)` for the single USDC transfer tuple. Primary and secondary approve that queue transaction. A confirmed queue receipt establishes canonical `createdAt`, `readyAt`, `expiresAt`, queue nonce, and fingerprint.

The app then supports only the exact next queued item:

- **Cancel:** primary plus secondary approve the exact Safe call to Delay `setTxNonce`, invalidating the displayed queue range.
- **Early execute proof:** before `readyAt`, a read-only simulation must reject and must not be broadcast.
- **Ready execute:** at or after `readyAt` and before expiration, the gas-only relayer calls exact `executeNextTx(to,value,data,operation)`. This requires no new owner authorization because the queue already contains the authorized tuple.
- **Expired item:** display as expired and block execution. `skipExpired` may be added only as the exact FIFO-unblocking action required for the rehearsal; it is not a generic Delay control surface.

Every lifecycle action re-reads queue head, tuple, nonce, cooldown, expiration, and canonical time. Elapsed device time alone never establishes readiness.

## Backend API direction

Keep one submission journal and evolve the existing endpoints around closed intent kinds rather than adding arbitrary calldata:

- registration options/verification for `primary` and `secondary`, with configured authenticator attachment;
- one closed vault-provisioning request;
- prepare `transfer`, `cancel-queued`, `execute-ready`, and if required `skip-expired` intents;
- collect only the roles required by the prepared intent;
- query one immutable submission by identifier and reconcile uncertain state.

The backend derives all calldata and Safe/Delay fields. The browser sends human intent: recipient, amount, or exact displayed queue identity. Endpoint changes must update `apps/backend/README.md`, endpoint tests, the app client, and the security call graph together.

## State and reconciliation

Persist only public data: active environment ID, Safe/guard/Delay/token/signer addresses, credential IDs and roles, evidence hashes, submission IDs, transaction hashes, and last verified snapshots. Never persist passkey private material, raw reusable assertions, relay keys, RPC secrets, or signed transaction envelopes in the browser.

Backend submission states are monotonic: `prepared`, `awaiting-primary`, `awaiting-secondary`, `submitting`, `uncertain`, `confirmed`, `reverted`, `superseded`. A transport timeout becomes `uncertain`. Reload queries the same journaled submission and chain evidence; it does not prepare or sign a replacement automatically. The app never reports success from local state alone.

The browser serializes one write flow per Safe. The backend remains authoritative for cross-refresh idempotency and rejects stale Safe nonce, changed policy state, changed queue head, reused ceremony, duplicate role approval, and changed transaction bytes.

## PWA behavior

- Add a standards-compliant manifest, maskable icons, theme colors, install metadata, and standalone display mode.
- Register a versioned service worker only for the immutable application shell and static assets.
- Treat RPC, backend, WebAuthn, wallet state, submission, receipt, and queue requests as network-only and `no-store`.
- Never cache signatures, assertions, policy snapshots, balances, transaction requests, or success responses.
- Offline mode may show the static shell and an explicit unavailable/read-only state. It must not show stale data as current or allow a write.
- An update must not interrupt an in-progress WebAuthn or submission flow; activation waits until a safe reload boundary.
- Deep links and standalone navigation must work after installation.
- The UI remains mobile-first and accessible for safe-area insets, touch targets, reduced motion, focus, and passkey cancellation.

## Product language and UX

Rename the active prototype from EURC to **USDC on Ethereum Sepolia** throughout the app, backend contract, tests, and current documentation. Preserve historical evidence names only where changing them would falsify history.

The home screen must show:

- `Sepolia prototype` and the active origin/profile;
- verified Safe address and USDC balance;
- X, Y, Z and current spend window from chain;
- signer readiness and whether the secondary is truly cross-device;
- queue state and exact remaining cooldown/expiry derived from chain;
- a persistent warning that there is no recovery or independent alert channel in Phase One.

Replace editable-looking limits with verified read-only policy. Never describe the app as secure for meaningful assets, audited, production-ready, or recoverable.

## Testing strategy

### Deterministic tests

- Manifest/installability, service-worker cache exclusions, offline blocking, update behavior, deep links, and standalone layout.
- Exact local and HTTPS origin/RP profiles; reject wildcard, preview, mixed, or mismatched values.
- Primary platform and secondary cross-platform registration; reject role reuse, credential reuse, wrong RP/origin, missing user verification, and unsupported algorithms.
- USDC address, runtime hash, name, symbol, decimals, and guard token configuration.
- Exact X/Y/Z boundary classification around per-transaction and period limits using bigint.
- Exact primary-first signature requirements and role ordering.
- Queue/cancel/early/ready/expired lifecycle, FIFO identity, canonical timing, and stale-state rejection.
- No delegatecall, batch, approval, Permit/Permit2, unknown recipient/token/call, arbitrary Delay call, or browser-supplied calldata.
- Refresh, restart, timeout, uncertain submission, reconciliation, duplicate click, stale nonce, reorg observation, and no double submit.
- Backend origin/access rejection, no-store responses, redacted errors, and startup failure on incomplete reviewed configuration.

### Real integration tests

- Real Safe 1.5, guard, Zodiac Delay, signer contracts, and WebAuthn cryptography; never the historical permissive mock.
- Provision one fresh disposable localhost-RP vault.
- Complete X, Y, Z queue, cancel, early rejection, re-queue, and ready execution with low-value USDC.
- Install/reload the PWA and recover its public state.
- On the stable HTTPS RP, use a separate fresh vault and distinct secondary credential; install on mobile, execute X and Y, queue the 4-USDC above-Y transfer, prove the UI blocks early execution from canonical time, and execute it after Z. The full cancellation proof need not be repeated because it is already required on localhost.
- For every live transaction, run the separate read-only observer with no signing or submission capability and bind its canonical event/post-state record into the evidence bundle. Notification delivery is not required.

In-app activity remains a product view and must not be described as independent monitoring. Phase One claims observer evidence only when the separate read-only process records and verifies it; it does not claim notification delivery.

## Delivery sequence

1. **Foundation:** correct USDC identity, define closed environment profiles, make policy display read-only, and add PWA shell/installability.
2. **Local onboarding:** finish two-role WebAuthn registration and concrete reviewed provisioning adapter on localhost.
3. **Local tiers:** finish X and Y transfers, Z queue/cancel/early/ready flow, durable reconciliation, and adversarial tests.
4. **Local live rehearsal:** provision a fresh low-value Safe and record the complete localhost proof.
5. **HTTPS/mobile:** configure the stable PWA origin and protected temporary backend ingress, provision a separate Safe, install on mobile, and repeat provisioning, X, Y, queue/early-block, and ready execution. Cancellation remains a localhost-only live proof.
6. **Closeout:** publish reproducible evidence, list Phase Two deferrals, and keep all production/mainnet gates closed.

The implementation plan may split these into small test-driven tasks, but it must not reorder the security dependency: exact identity/configuration first, provisioning before funding, deterministic verification before live transactions, and localhost proof before HTTPS/mobile exposure.

## Completion criteria

Phase One is complete only when:

- the app is installable and usable in standalone mode;
- local and HTTPS profiles fail closed and never share credentials or vault metadata;
- a fresh real-passkey Sepolia Safe passes complete runtime/topology/policy verification;
- the UI and backend consistently use reviewed Sepolia USDC identity;
- X succeeds with primary only;
- Y requires and succeeds with primary plus secondary;
- above-Y direct execution is denied and the exact transfer is queued through Delay;
- one queued item is cancelled and cannot execute;
- one early execution is rejected without broadcast;
- one queued item executes after Z and before expiration;
- refresh/uncertainty cannot cause a duplicate transaction or false success;
- the HTTPS PWA is installed on a mobile device and completes the essential proof with its own fresh vault;
- every live receipt has independently derived read-only observer evidence, while notification delivery is explicitly deferred;
- security-core, backend, app, integration, build, lint/type, and relevant adversarial gates pass;
- the evidence and UI explicitly state the Phase Two deferrals and Sepolia-only risk.

## Security stop conditions

Stop and write a focused amendment instead of improvising if Phase One would require:

- new security-critical Solidity beyond the approved guard/internal digest helpers;
- a generic transaction or Delay endpoint;
- a browser-held relay/deployment key;
- an unprotected public backend ingress;
- relaxing exact RP/origin, signer, topology, token, recipient, nonce, or calldata checks;
- enabling ERC-4337, WalletConnect, arbitrary messages, approvals, or another module;
- treating local activity as independent monitoring;
- reusing a credential or Safe across different RP IDs;
- funding before topology and policy verification.

## Documentation impact

Implementation must update the current app/backend README files, root and app environment examples, security call graph for every new execution path, dependency review for every dependency change, testnet runbook, and the security-core plan checkboxes. Historical EURC or predecessor evidence remains historical and is not rewritten to imply it used a different asset.

This design supersedes the client-only Pimlico proposal for Phase One only. That proposal remains a possible Phase Two input and grants no current implementation authority.
