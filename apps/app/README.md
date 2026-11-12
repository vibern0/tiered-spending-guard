# tiered-spending-guard wallet app

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Open your project in the [Lovable editor](https://lovable.dev) and keep building.

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: connect the project to GitHub and every change made in Lovable is committed straight to your repository.
- **Full ownership**: this code is yours. Push to your repository and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and pnpm.

```sh
git clone <this-repository-url>
cd tiered-spending-guard
pnpm install
pnpm --dir apps/app dev
```

## Local wallet backend

The wallet is a testnet-only USDC prototype. It pins Circle's Ethereum Sepolia USDC contract at `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` and reviewed runtime hash `0xcd3f29e2ea9c61dadd48bfeaf8b2884b6de9dfee7bf45329452c4c33d0868ceb`; active balances, policies, and transfers use six-decimal USDC bigint units. The canonical two-provider artifact and fixed X/Y/Z profile live in `packages/security-core/config/sepolia.pwa-phase-one.json`.

The wallet requires the loopback backend for passkey registration, automatic local Phase One vault provisioning, and Safe submissions. Set `VITE_SEPOLIA_RPC_URL` for direct Sepolia reads and select one closed identity profile. The browser reads one verified snapshot when a configured vault loads, when the Send flow opens, on explicit user refresh, and after a terminal submission; it does not poll chain state in the background. Simultaneous contract reads are grouped through Sepolia Multicall3 with a 10 ms collection window, while retaining the pinned-block and final block-hash checks. This read policy limits hosted RPC use and grants no signing or write authority.

```sh
# Fixed localhost profile (these are also its exact defaults)
export VITE_WALLET_PROFILE=local
export VITE_APP_ORIGIN=http://localhost:5173
export VITE_WEBAUTHN_RP_ID=localhost
export VITE_BACKEND_ORIGIN=http://localhost:8787

# Stable HTTPS profile; replace both hosts with reviewed exact origins
export VITE_WALLET_PROFILE=https
export VITE_APP_ORIGIN=https://vault.example
export VITE_WEBAUTHN_RP_ID=vault.example
export VITE_BACKEND_ORIGIN=https://relay.example
```

The app rejects wildcard/preview origins, paths, URL credentials, IP relying parties, mixed local/HTTPS values, and any observed browser origin that differs from the configured profile. Both browser endpoints must use `localhost`: the app rejects `127.0.0.1` as the browser backend hostname because local account cookies require the same site. Backend requests include cookies. The backend socket still binds to `127.0.0.1`; its secrets and SQLite/account evidence stay outside this repository. HTTPS remains a separate reviewed profile; this multi-user milestone enables localhost only.

Backend errors, unhealthy readiness, stale chain state, passkey cancellation, and onchain policy denial stay visible. The browser never receives relay keys or credential material.

## Phase One journeys

New first and second passkeys use the label `tiered-guard-vault-YYYY-MM-DD-HH-mm-ss`, generated once per registration from the browser's local date/time. The same label is supplied as the WebAuthn user name and display name; the stable server user handle remains the credential binding.

Use the **Account** tab in the main navigation to open your profile and **Sign out**. Logout returns to the sign-in screen; **Sign in with passkey** opens the existing account with its first passkey alone. It does not register replacement signers or create another vault.

An empty browser offers **Create account** and **Sign in with passkey**. Creation opens an isolated server setup context. The first registration uses a stable server-generated user handle, a discoverable credential and no forced authenticator attachment; after registration, a fresh assertion from that exact first credential signs the user in. Onboarding then registers the distinct second signer. Immediately after the second registration, it calls the backend's empty automatic-provisioning route and displays a provisioning/verifying state until the seven serial Sepolia deployments each have six confirmations and the final topology gate passes. A failure preserves the two public credential IDs, stores no vault configuration, and exposes an explicit retry. Public credential, vault, and submission identifiers are cached under environment-and-account keys. The server session selects the account; cached data never authenticates a browser. Clearing browser storage does not delete the account: sign in with its original first passkey, including a synced copy when available from its provider. The browser does not enable synchronization or infer independent devices from cloud credentials. The second signer is requested only by actions that require it. Session tokens remain in HttpOnly cookies; CSRF values remain in memory; assertions/signatures are not persisted. Sign out clears prepared approvals, and another account starts with separate state. Account changes are announced across tabs; focus also rechecks the authoritative session, and requests carry the expected account so stale tabs fail closed.

Run the backend and UI in separate terminals after setting their environment variables:

```sh
pnpm --dir apps/backend dev
pnpm --dir apps/app dev
```

This Phase One automation trusts the backend for planning, local authorization, relay signing, and broadcast. Its authorizer limits the exact committed Sepolia shape and maximum cost but is not independent protection against backend compromise. A future separately administered KMS/policy service is required to split that trust boundary.

The PWA exposes closed USDC transfer intents and the verified Delay queue lifecycle. X requests the primary passkey, Y and Z request primary then secondary over the same Safe digest, cancellation requires both, and ready execution or expired skipping is permissionless but tuple-bound. Limits and signer topology are read-only chain projections. Device time cannot make a queue item ready when the canonical snapshot timestamp says otherwise.

This is a Sepolia prototype with no signer recovery and no independent notification delivery. Use only test assets. Funding is manual through the Circle Sepolia faucet and the displayed verified Safe address.

The Activity screen is an in-app projection, not independent monitoring. Phase One evidence is valid only when a separate read-only security-core observer verifies the canonical receipt and post-state through two independent public sources. The verification core exists, but its executable stays disabled until a fixed in-repository RPC/topology composition replaces caller-selected code loading. It does not deliver notifications and cannot authorize a wallet action.

The HTTPS/mobile gate must use a fresh HTTPS-profile installation, fresh credentials, and a fresh Safe. Do not import or relabel localhost storage. Before funding, verify standalone launch, exact origin/RP/backend identity, a genuinely distinct secondary authenticator, verified topology, and an offline write that blocks. After the approved X/Y/Z sequence, retain only public evidence and remove the temporary backend ingress; mobile UI screenshots or Activity entries are never receipt/observer proof.

## Built with

- TanStack Start
- TypeScript
- React
- Tailwind CSS

Pending submission receipts update automatically through the loopback backend's read-only status endpoint. The app restores known submission IDs, stops recurring checks for terminal and approval-only records, ignores obsolete account/session responses, and retains manual Reconcile. Status checks never sign or resubmit; full verified vault snapshots refresh on new terminal transitions rather than on each receipt check. The backend also reconciles durable pending hashes while the browser is closed, provided the backend remains running.
