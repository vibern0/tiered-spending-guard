# EURC Passkey Wallet Backend Design

## Status

Implemented locally for review. This remains a local-only Sepolia testnet backend, not a production service.

## Intent

Make server boundary explicit/runnable. `apps/backend` is required wallet part for provisioning/writes. `apps/backend/README.md` defines HTTP contract.

The browser app remains the user interface and WebAuthn prompt surface. The backend owns server-side WebAuthn verification, reviewed vault provisioning, exact Safe transaction preparation, relay submission, and uncertainty reconciliation. The backend is never a Safe owner, secondary authorizer, unrestricted module, or policy authority; the deployed Safe, guard, and Delay remain authoritative.

## Scope and constraints

- Sepolia (`chainId = 11155111`) only.
- Bind the server to `127.0.0.1` and accept only the configured localhost app origin.
- Keep the funded relay account as a gas/deployment payer only.
- No WalletConnect, hosted auth, cloud database, arbitrary token calls, mainnet, or production claims.
- Keep relay keys, RPC URLs, passkey material, and provider credentials outside the repository and logs.
- Fail closed when reviewed deployment evidence, runtime bytecode, topology, Safe nonce, EURC metadata, or policy state cannot be verified.
- Browser-provided Safe, guard, EURC, nonce, spend, and policy values are advisory inputs only. The backend must bind requests to the server-held vault record and re-read authoritative chain state before preparing or submitting a transaction.

## Repository shape

```text
apps/
  app/                         # Browser UI
  backend/                     # Local Sepolia HTTP backend
    README.md                  # Canonical endpoint and runbook documentation
    package.json
    tsconfig.json
    src/
      main.ts                  # Runnable entrypoint
      server.ts                # Loopback HTTP boundary
      config.ts                # Environment validation
      session.ts               # Registration and local vault session state
      webauthn.ts               # Registration/assertion verification
      vault.ts                  # Exact request construction and submission service
      handlers.ts               # Server-authoritative handler composition
      provisioner.ts            # Reviewed security-core deployment adapter
      journal.ts                # Durable, outside-repository submission journal
    tests/
```

The move is a rename and boundary cleanup, not a second implementation. Existing tested bridge modules move with their behavior; public names change from `Bridge*`/`bridge` to `Backend*`/`backend`.

The app environment variable becomes `VITE_BACKEND_ORIGIN`. The default remains `http://127.0.0.1:8787`.

## HTTP contract

All responses are JSON and include `cache-control: no-store`. Errors use `{ "error": string }`. The server is loopback-only and requires the exact configured `Origin` when a browser sends one.

### `GET /health`

Returns process/configuration readiness without exposing secrets.

```json
{ "ok": true, "chainId": 11155111, "origin": "http://localhost:5173" }
```

This does not claim that a vault is provisioned or that the chain is healthy.

### `POST /v1/registrations/{role}/options`

`role` is `primary` or `secondary`. Creates a one-use registration session and returns browser ceremony parameters:

```json
{
  "sessionId": "opaque-local-session-id",
  "challenge": "base64url",
  "rpId": "localhost",
  "origin": "http://localhost:5173",
  "role": "primary",
  "userVerification": "required",
  "authenticatorAttachment": "platform"
}
```

The backend must reject unsupported roles, duplicate active role sessions, non-local origins, and reused sessions.

### `POST /v1/registrations/{role}/verify`

Consumes the matching one-use session and the browser registration response:

```json
{ "sessionId": "opaque-local-session-id", "registration": { "id": "...", "response": {} } }
```

Returns only non-secret credential metadata:

```json
{ "role": "primary", "credentialId": "...", "counter": 0 }
```

The backend validates challenge, RP ID, origin, user verification, credential ID, and public-key registration before storing credential metadata outside the repository.

### `POST /v1/vaults`

Consumes the two verified credential identifiers and the pinned Circle Sepolia EURC candidate:

```json
{
  "chainId": 11155111,
  "eurc": "0x...",
  "primaryCredentialId": "...",
  "secondaryCredentialId": "..."
}
```

The handler must ignore browser-supplied deployment addresses and hashes. It selects reviewed deployment artifacts, provisions a fresh Safe topology through the security-core deployment boundary, waits for receipts, verifies runtime code and topology, stores the resulting vault record, and returns:

```json
{
  "chainId": 11155111,
  "safe": "0x...",
  "guard": "0x...",
  "delay": "0x...",
  "primaryPasskey": "0x...",
  "secondaryPasskey": "0x...",
  "eurc": "0x...",
  "evidence": {
    "setupTransactionHash": "0x...",
    "verificationReportHash": "0x..."
  }
}
```

### `POST /v1/submissions/prepare`

Consumes a request for one allowlisted EURC `transfer(address,uint256)` on the server-held Safe. The server re-reads the chain snapshot and constructs the exact zero-value Safe `CALL`, nonce, Safe EIP-712 digest, and required approval tier. The request is journaled before returning:

```json
{ "id": "0x...", "request": { "version": 1, "kind": "safe-execution", "safeTxHash": "0x...", "transaction": {} } }
```

No arbitrary calldata, delegate call, batch, approval, Permit/Permit2, unknown asset, unknown recipient, stale nonce, or stale spend state is accepted.

### `POST /v1/submissions/{id}/submit`

Consumes a role and the browser-produced Safe signature:

```json
{ "role": "primary", "signature": "0x..." }
```

The backend verifies the signature against the exact journaled digest and configured credential, enforces primary-before-secondary ordering, broadcasts only the exact prepared request, marks uncertainty on transport failure, and reconciles before retry. It returns:

```json
{
  "id": "0x...",
  "state": "awaiting_secondary|queued|confirmed|reverted",
  "requiredApprovals": "primary|secondary|delayed",
  "safeTxHash": "0x...",
  "transactionHash": "0x..."
}
```

### `GET /v1/submissions/{id}`

Returns the journaled state and reconciliation result for one submission. It never authorizes a retry or substitutes for onchain verification.

## Data flow

1. The app checks backend health and asks for a primary registration challenge.
2. The browser performs platform WebAuthn registration and returns the ceremony response.
3. The backend verifies and stores credential metadata, then repeats the flow for the secondary credential.
4. The app requests vault provisioning. The backend runs the reviewed deployment adapter and verifies the fresh Safe topology before returning addresses/evidence.
5. The app reads balances and policy directly from Sepolia RPC.
6. For a send, the app requests preparation. The backend derives the exact Safe digest from authoritative state.
7. The browser signs that digest with the configured passkey. The backend verifies and relays the unchanged request, then reconciles receipt state.

## Error and readiness behavior

- The app must distinguish backend unavailable, backend unhealthy, passkey cancellation, rejected ceremony, stale chain state, and onchain policy denial.
- `GET /health` is a liveness/readiness signal only; the app must still display chain-derived blocking health failures.
- A backend process without valid RPC, relay, reviewed artifacts, or journal configuration must refuse to start rather than expose a partially working write API.
- Provisioning and submission failures must be visible in the UI and must not be represented as local simulated success.

## Documentation maintenance rule

`apps/backend/README.md` is the canonical endpoint contract. Any endpoint addition, removal, path/method change, request/response change, status-code change, authentication/origin change, or error-shape change must update that README, the browser client, endpoint tests, `AGENTS.md` when the security boundary changes, and `packages/security-core/docs/security/call-graph.md` for new execution paths.

## Acceptance gates

- `npm --prefix apps/backend run dev` starts a loopback server with validated configuration.
- `GET /health` is documented and tested.
- Browser registration and provisioning use the real backend endpoints; no silent no-op or simulated vault state remains.
- Backend tests cover origin/loopback rejection, malformed bodies, unknown routes, registration binding, server-authoritative vault binding, exact digest binding, role ordering, duplicate requests, uncertain broadcast reconciliation, and receipt confirmation.
- App tests cover backend-unavailable and backend-error UI states.
- App build, backend tests, security-core checks, and relevant adversarial tests pass before claiming the local demo is runnable.
- Live Sepolia execution remains a separately recorded, capped rehearsal; no mainnet or production claim is made.
