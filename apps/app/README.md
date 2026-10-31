# Welcome to your Lovable project

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Open your project in the [Lovable editor](https://lovable.dev) and keep building.

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: connect the project to GitHub and every change made in Lovable is committed straight to your repository.
- **Full ownership**: this code is yours. Push to your repository and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```

## Local wallet backend

The wallet is a testnet-only USDC prototype. It pins Circle's Ethereum Sepolia USDC contract at `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` and reviewed runtime hash `0xcd3f29e2ea9c61dadd48bfeaf8b2884b6de9dfee7bf45329452c4c33d0868ceb`; active balances, policies, and transfers use six-decimal USDC bigint units. The canonical two-provider artifact and fixed X/Y/Z profile live in `packages/security-core/config/sepolia.pwa-phase-one.json`.

The wallet requires the loopback backend for passkey registration, reviewed vault provisioning, and Safe submissions. Set `VITE_SEPOLIA_RPC_URL` for direct Sepolia reads and select one closed identity profile:

```sh
# Fixed localhost profile (these are also its exact defaults)
export VITE_WALLET_PROFILE=local
export VITE_APP_ORIGIN=http://localhost:5173
export VITE_WEBAUTHN_RP_ID=localhost
export VITE_BACKEND_ORIGIN=http://127.0.0.1:8787

# Stable HTTPS profile; replace both hosts with reviewed exact origins
export VITE_WALLET_PROFILE=https
export VITE_APP_ORIGIN=https://vault.example
export VITE_WEBAUTHN_RP_ID=vault.example
export VITE_BACKEND_ORIGIN=https://relay.example
```

The app rejects wildcard/preview origins, paths, URL credentials, IP relying parties, mixed local/HTTPS values, and any observed browser origin that differs from the configured profile. HTTPS backend requests include ingress credentials; the temporary ingress must independently enforce its developer access policy.

Backend errors, unhealthy readiness, stale chain state, passkey cancellation, and onchain policy denial stay visible. The browser never receives relay keys or credential material.

## Phase One journeys

Onboarding registers the primary and secondary passkeys separately, creates an unsigned deployment package, waits for independent operator approval, and displays the canonical provisioning receipt. Public credential, vault, package, and submission identifiers are stored in environment-scoped versioned browser storage; assertions and signatures are process-local only.

The PWA exposes closed USDC transfer intents and the verified Delay queue lifecycle. X requests the primary passkey, Y and Z request primary then secondary over the same Safe digest, cancellation requires both, and ready execution or expired skipping is permissionless but tuple-bound. Limits and signer topology are read-only chain projections. Device time cannot make a queue item ready when the canonical snapshot timestamp says otherwise.

This is a Sepolia prototype with no signer recovery and no independent notification delivery. Use only test assets. Funding is manual through the Circle Sepolia faucet and the displayed verified Safe address.

The Activity screen is an in-app projection, not independent monitoring. Phase One evidence is valid only when the separate read-only security-core observer verifies the canonical receipt and post-state through two independent public sources. That observer does not deliver notifications and cannot authorize a wallet action.

## Built with

- TanStack Start
- TypeScript
- React
- Tailwind CSS
