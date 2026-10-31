# Local USDC wallet backend

`apps/backend` is a loopback-only Ethereum Sepolia testnet backend for the browser wallet. It is required for passkey registration, reviewed vault provisioning, exact Safe transaction preparation, relay submission, and uncertain-broadcast reconciliation.

This is security research and testnet prototype code. It is not a production service. Do not use mainnet, real funds, hosted authentication, WalletConnect, arbitrary token calls, or secrets from this repository.

## Run

Keep relay keys, RPC URLs, credential metadata, and journal data outside the repository. Set:

```sh
export BACKEND_RELAY_PRIVATE_KEY=0x...
export BACKEND_RPC_URL=https://...
export BACKEND_JOURNAL_PATH=/absolute/path/outside/repository/backend-journal.json
export BACKEND_REVIEWED_ARTIFACTS=/absolute/path/outside/repository/reviewed-artifacts.json
export BACKEND_PROVISIONER_MODULE=/absolute/path/outside/repository/reviewed-backend-adapter.mjs
export BACKEND_PROFILE=local
export BACKEND_ORIGIN=http://localhost:5173
export BACKEND_RP_ID=localhost
npm --prefix apps/backend run dev
```

For the later HTTPS/mobile rehearsal, set `BACKEND_PROFILE=https`, `BACKEND_ORIGIN` to the one exact stable PWA origin, and `BACKEND_RP_ID` to that origin's exact hostname. HTTPS mode rejects missing, wildcard, path-bearing, credential-bearing, IP, mixed-protocol, or mismatched values. The server still binds only to `127.0.0.1`; a separately reviewed temporary TLS ingress must supply access control and must not expose a public unauthenticated route.

The server binds to `127.0.0.1:8787`. `BACKEND_PROVISIONER_MODULE` must export the pinned Sepolia USDC address, a reviewed provisioner, and exact preparation, submission, and receipt-reconciliation adapters. Startup must fail when any required configuration, reviewed deployment evidence, or adapter is missing. The browser's USDC field is advisory and is never selected for deployment. The canonical token/runtime/X/Y/Z values are pinned by `packages/security-core/config/sepolia.pwa-phase-one.json`; runtime identity is not accepted from browser input.

## HTTP contract

All responses are JSON with `cache-control: no-store`. Errors use `{ "error": string }`. Requests with an `Origin` must match `BACKEND_ORIGIN`; non-loopback direct sockets are rejected. HTTPS-profile CORS responses allow credentials only for that exact origin.

- `GET /health` returns process readiness, `{ ok, chainId, profileId, origin, rpId }`. The browser rejects any identity mismatch before opening a WebAuthn ceremony. It does not claim that a vault is provisioned or that chain state is healthy.
- `POST /v1/registrations/{primary|secondary}/options` creates a one-use platform, user-verified WebAuthn registration session.
- `POST /v1/registrations/{primary|secondary}/verify` verifies the matching registration ceremony and stores only credential metadata.
- `POST /v1/vaults` provisions a fresh reviewed Safe topology from the two verified credential IDs and the pinned Sepolia USDC candidate. Browser deployment addresses and hashes are ignored.
- `POST /v1/submissions/prepare` re-reads the server-held vault and chain state, then journals one exact allowlisted USDC `transfer(address,uint256)` Safe `CALL`.
- `POST /v1/submissions/{id}/submit` verifies the role signature over the journaled Safe digest, requires primary before secondary, and relays only the unchanged prepared request.
- `GET /v1/submissions/{id}` returns journal state. It never authorizes a retry.

The backend relay account pays gas only. Safe owners, the spending guard, Delay, USDC metadata, topology, nonce, limits, recipient policy, receipts, and cancellation remain authoritative onchain or in reviewed security-core adapters. Preparation passes only recipient, amount, and idempotency intent from the browser; the adapter must derive the exact Safe transaction from the server-held vault and fresh chain reads.

## Verify

```sh
npm --prefix apps/backend test
```

Live Sepolia rehearsal remains separately authorized, capped, and recorded. No backend test proves hardware/WebAuthn UX or production readiness.
