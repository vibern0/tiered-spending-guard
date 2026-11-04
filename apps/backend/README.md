# Local USDC wallet backend

`apps/backend` is a loopback-only Ethereum Sepolia testnet backend for the browser wallet. It is required for passkey registration and reviewed vault provisioning. The durable submission API is implemented behind an explicit `ConfiguredSubmissionRuntime`; the default CLI entrypoint deliberately leaves those write routes unavailable until the reviewed live transport/observer adapter in Tasks 10–12 is supplied.

This is security research and testnet prototype code. It is not a production service. Do not use mainnet, real funds, hosted authentication, WalletConnect, arbitrary token calls, or secrets from this repository.

## Run

Keep relay keys, RPC URLs, credential metadata, and journal data outside the repository. Set:

```sh
export BACKEND_RELAY_PRIVATE_KEY=0x...
export BACKEND_RPC_URL=https://...
export BACKEND_JOURNAL_PATH=/absolute/path/outside/repository/backend-journal.json
export BACKEND_PROVISIONING_JOURNAL_PATH=/absolute/path/outside/repository/provisioning-live-journal.json
export BACKEND_PROVISIONING_APPROVAL=/absolute/path/outside/repository/provisioning-approval.json
export BACKEND_PROVISIONING_APPROVAL_HASH_FILE=/absolute/path/outside/repository/provisioning-approval.sha256
export BACKEND_PROVISIONING_REVIEW_DIRECTORY=/absolute/path/outside/repository/provisioning-reviews
export BACKEND_PROFILE=local
export BACKEND_ORIGIN=http://localhost:5173
export BACKEND_RP_ID=localhost
pnpm --dir apps/backend dev
```

For the later HTTPS/mobile rehearsal, set `BACKEND_PROFILE=https`, `BACKEND_ORIGIN` to the one exact stable PWA origin, and `BACKEND_RP_ID` to that origin's exact hostname. HTTPS mode rejects missing, wildcard, path-bearing, credential-bearing, IP, mixed-protocol, or mismatched values. The server still binds only to `127.0.0.1`; a separately reviewed temporary TLS ingress must supply access control and must not expose a public unauthenticated route.

The server binds to `127.0.0.1:8787`. Provisioning is an internal workspace adapter; executable external modules are disabled. The supported entrypoint composes `createReviewedPwaProvisioner` with the reviewed security-core planner, durable live journal context, and final topology verifier. Per-wallet review and approval files remain outside the repository. Canonical token/runtime/X/Y/Z values are pinned by `packages/security-core/config/sepolia.pwa-phase-one.json`; exact Zodiac Delay bytes are pinned by `packages/security-core/config/artifacts/zodiac-delay-v1.1.1-mastercopies.json`; Safe passkey proxy creation code is anchored to pinned `@safe-global/safe-passkey@0.2.0`. No deployment address, policy, nonce, fee, artifact, runtime hash, signer, or approval is accepted from browser input.

`BACKEND_JOURNAL_PATH` is only for prepared Safe submissions. `BACKEND_PROVISIONING_JOURNAL_PATH` is only for the seven-transaction deployment runner; startup rejects equal paths because their durable schemas are intentionally different.

`BACKEND_REVIEWED_ARTIFACTS` is retired and must be removed from the environment; startup rejects it explicitly. The fixed Safe proxy salt is `0`. Each passkey signer runtime hash is derived independently from reviewed proxy creation code, the verified factory `SINGLETON()`, that credential's coordinates, and the verified P-256 verifier through read-only EVM creation simulation.

After `POST /v1/vaults/plan`, independently review the generated package, write the complete approval JSON to `BACKEND_PROVISIONING_APPROVAL`, compute its security-core approval digest (which binds the package, plan, transaction order, nonces, gas limits, and EIP-1559 fees), and write only that bytes32 digest to `BACKEND_PROVISIONING_APPROVAL_HASH_FILE`. Execution fails closed if either file changes or the two no longer agree; the approval and hash files may be created after startup. The backend retains the opaque verified provisioning result in memory and serializes only its public projection. The old `reviewed-artifacts.json` is not read and may be removed after preserving any historical copy you want to keep.

## HTTP contract

All responses are JSON with `cache-control: no-store`. Errors use `{ "error": string }`. Requests with an `Origin` must match `BACKEND_ORIGIN`; non-loopback direct sockets are rejected. HTTPS-profile CORS responses allow credentials only for that exact origin.

The three `/v1/submissions` routes below exist only when the process is composed with a `ConfiguredSubmissionRuntime`. `pnpm --dir apps/backend dev` does not install a placeholder signer, relay, or hidden sponsor; it fails closed with those routes unavailable.

- `GET /health` returns process readiness, `{ ok, chainId, profileId, origin, rpId }`. The browser rejects any identity mismatch before opening a WebAuthn ceremony. It does not claim that a vault is provisioned or that chain state is healthy.
- `POST /v1/registrations/{primary|secondary}/options` creates a one-use platform, user-verified WebAuthn registration session.
- `POST /v1/registrations/{primary|secondary}/verify` verifies the matching registration ceremony and stores only credential metadata.
- `POST /v1/vaults/plan` creates one unsigned seven-transaction review package from the two verified credential IDs. It never broadcasts.
- `POST /v1/vaults` accepts only the pending `packageHash`; execution loads the exact approval and independently reviewed approval digest, rechecks nonce/code/prerequisite state before each new transaction, uses the durable-before-broadcast journal, and returns only after final topology verification.
- `POST /v1/submissions/prepare` accepts one exact human intent: `transfer`, `cancel-queued`, `execute-ready`, or `skip-expired`. It re-reads server-held state, delegates exact X/Y/Z construction to security-core, and journals the immutable public request. Browser-supplied calldata and Safe/Delay fields are rejected.
- `POST /v1/submissions/{id}/submit` accepts `{role,assertion}` for primary/secondary or `{role:"none"}` only for ready execution/expired skip. It revalidates before the WebAuthn prompt and again before broadcast, persists the locally derived outer transaction hash before sending, requires primary before secondary, and single-flights duplicate tabs/clicks.
- `GET /v1/submissions/{id}` reconciles only the exact durable outer hash before returning. It never signs, broadcasts, or authorizes a replacement.

Submission states are monotonic: `prepared`, `awaiting-primary`, `awaiting-secondary`, `submitting`, `uncertain`, then `confirmed`, `reverted`, or `superseded`. The journal contains the public intent, hashes, approval-presence booleans, and public receipt identity. Raw WebAuthn assertions and reusable signature payloads remain process-local and are never persisted.

The backend relay account pays gas only. Safe owners, the spending guard, Delay, USDC metadata, topology, nonce, limits, recipient policy, receipts, and cancellation remain authoritative onchain or in reviewed security-core adapters. Preparation passes only recipient, amount, and idempotency intent from the browser; the adapter must derive the exact Safe transaction from the server-held vault and fresh chain reads.

## Verify

```sh
pnpm --dir apps/backend test
pnpm --dir apps/backend run typecheck
```

Live Sepolia rehearsal remains separately authorized, capped, and recorded. No backend test proves hardware/WebAuthn UX or production readiness.

The backend is not the independent receipt observer. The security-core verification library must eventually run in a separate clean process with fixed public read-only RPC access and no backend, relay, signer, credential, or deployment secret. Its executable is currently fail-closed until that in-repository composition is reviewed. Observer records explicitly make no notification-delivery claim and never authorize a submission.

For the HTTPS/mobile gate, keep this server bound to `127.0.0.1`. The temporary TLS ingress must enforce an authenticated developer access policy before forwarding, preserve the one exact configured Origin/CORS identity, expose no admin/debug route or URL secret, and have a reviewed shutdown deadline. Record only redacted configuration hashes. At closeout, disable/delete the ingress and verify its public backend origin is unavailable from an external network; a still-working public URL means Phase One closeout fails.
