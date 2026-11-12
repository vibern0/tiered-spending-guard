# tiered-spending-guard local wallet backend

`apps/backend` is a loopback-only Ethereum Sepolia testnet backend for the browser wallet. It is required for passkey registration, automatic Phase One vault provisioning, and Safe submissions. The local CLI composes a concrete `ConfiguredSubmissionRuntime`; HTTP sending becomes ready for the signed-in account after vault verification; the first signer approves base transfers and the second signer is requested only by actions that require it. Historical vaults remain read-only.

Fresh deployment uses the explicit recipient mode added by the accepted [setup-helper correction](../../packages/security-core/docs/superpowers/specs/2026-11-05-current-profile-atomic-setup-mode-proposal.md). The full local EVM rehearsal uses actual Safe/passkey/guard/Delay code and ephemeral P-256 approvals, covering sending, recipient maintenance, lifecycle and restart observation. It uses a local token implementation behind the pinned public USDC proxy; actual device registration and live Sepolia receipts remain separate gates.

This is security research and testnet prototype code. It is not a production service. Do not use mainnet, real funds, hosted authentication, WalletConnect, arbitrary token calls, or secrets from this repository.

## Multi-user localhost flow

First registration is followed by verification of the **same first passkey** before second-signer setup. The frontend preserves that credential's returned transport hints so synced/internal providers remain available. A failed verification preserves the registered key; use **Sign in with passkey** to resume. **Create account** exits an existing unfinished session and starts a separate account; it does not replace the earlier credential.

Use Node **24.21.0** (`.node-version`). The normal entrypoint serves independent persistent accounts, first-passkey sign-in and account-scoped cookie sessions. **Create account** registers two distinct signers and automatically provisions that account; **Sign in with passkey** opens its existing account using the first key alone. Synced discoverable credentials do not depend on saved browser IDs. No hardcoded account-count limit exists. Second approvals still sign the exact Safe transaction when required by policy.

Set the browser's public `VITE_BACKEND_ORIGIN=http://localhost:8787`. The app stays at `http://localhost:5173` and the backend still binds only `127.0.0.1`; do not use the old `127.0.0.1` browser hostname with cookies. Normal browser requests carry HttpOnly/SameSite cookies, exact credentialed CORS, CSRF and selected-account headers. Cookies never authorize transfers. Clearing browser storage signs out without deleting account data; signing in again restores the same account.

Optional external `BACKEND_ACCOUNT_DATABASE_PATH` selects SQLite storage; default is `${BACKEND_PROVISIONING_JOURNAL_PATH}.accounts.sqlite`. Account-owned journals/reviews live in its adjacent `.data` directory. Original configured journals/reviews are adopted as the preserved legacy account without relocation. Back up the database (including SQLite WAL transaction state) and evidence directories together. Do not delete journals to create another user. Accounts, credential public keys/IDs/counters and hashed session verifiers persist; private passkeys/assertions/signature payloads do not.

Authentication endpoints: `POST /v1/auth/setup`, `POST /v1/auth/login/options`, `POST /v1/auth/login/verify`, `GET /v1/auth/session`, `POST /v1/auth/logout`. Registration/vault/submission suffixes below are retained but require the appropriate setup/authenticated session and exact account context. Public health reveals no other user's account readiness. The old unauthed singleton HTTP composition exists only in the explicit test injection seam, never the normal entrypoint.

A shared payer-wide queue/lease serializes nonce planning and broadcasts across accounts. Incomplete deployment or uncertain durable hashes block new payer signatures; users can still authenticate/read while reconciliation is needed. Authenticated account projections restore recent and unresolved submission references after browser reset. Status checks use only exact stored hashes. Account/session ownership checks prevent another user or browser from continuing an active approval attempt.

Local tests represent synced credentials cryptographically. Actual cloud-provider synchronization and another physical device reaching this service remain later HTTPS/mobile gates: a phone's localhost is its own loopback address.

## Code structure

`src/index.ts` is the executable entrypoint. It loads external environment/configuration, configures logging and starts the import-safe application factory in `src/app.ts`. Application composition connects the account store, shared payer coordinator, account runtimes, HTTP server and receipt worker; shutdown drains work and closes owned resources.

| Folder           | Responsibility                                                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accounts/`      | SQLite public metadata, account/session projection, per-account runtime cache and shared application contracts. Counter/replay writes remain atomic in one store. |
| `auth/`          | HTTP adapters, registration/login workflows, exact transaction-approval credential handling, WebAuthn verification and signature parsing.                         |
| `vaults/`        | Current verified vault, readiness and provisioning/submission coordination.                                                                                       |
| `provisioning/`  | Immutable deployment workflow, concrete private runtime, verified restart recovery and successor lineage.                                                         |
| `submissions/`   | Closed intent preparation, approval/state lifecycle, bounded execution, canonical receipt verification, durable journals and public observations.                 |
| `chain/`         | Shared approved RPC readers, relay adapters, strict batching and one payer-wide queue/lease across all accounts.                                                  |
| `http/`          | Fastify setup, request security context, safe error mapping, health, Swagger and documentation schema helpers.                                                    |
| `jobs/`          | Receipt reconciliation scheduling and drain-on-shutdown.                                                                                                          |
| `compatibility/` | Preserved singleton test/restricted HTTPS routes, challenge stores and older submission API.                                                                      |

Feature `schemas.ts` files own their documentation models and endpoint descriptions; `http/openapi.ts` assembles them without changing runtime validation. Routes adapt HTTP inputs/context/results. Services own workflow ordering. Chain adapters own narrow external capabilities. The receipt observer receives no private signer or broadcaster. Existing exported constructor names are retained where callers rely on them.

See the [current codebase diagrams](../../docs/codebase-map.md) and [complete file guide](../../docs/file-guide.md) for responsibilities and dependency flow.

## Run

`pnpm backend:dev` loads dotenv before validating configuration. By default it resolves `apps/backend/.env` relative to the entrypoint, independently of the shell's current directory. Keep the actual file outside this repository and use a local ignored symlink, or set `DOTENV_CONFIG_PATH` to an absolute external file. Existing shell values take precedence. A missing default file is allowed when settings are exported; an explicitly selected missing file, broken symlink, unreadable file or repository-local target fails with a sanitized error. Environment contents and private paths are never printed by the loader. The read-only profiling command deliberately does not load backend secrets.

```sh
DOTENV_CONFIG_PATH=/absolute/path/outside/repository/backend.env pnpm backend:dev
```

Keep relay keys, RPC URLs, credential metadata, and journal data outside the repository. Set:

```sh
export BACKEND_RELAY_PRIVATE_KEY=0x...
export BACKEND_RPC_URL=https://...
export BACKEND_JOURNAL_PATH=/absolute/path/outside/repository/backend-journal.json
export BACKEND_PROVISIONING_JOURNAL_PATH=/absolute/path/outside/repository/provisioning-live-journal.json
export BACKEND_PROVISIONING_REVIEW_DIRECTORY=/absolute/path/outside/repository/provisioning-reviews
export BACKEND_PROFILE=local
export BACKEND_ORIGIN=http://localhost:5173
export BACKEND_RP_ID=localhost
npm run backend:dev
```

For the later HTTPS/mobile rehearsal, set `BACKEND_PROFILE=https`, `BACKEND_ORIGIN` to the one exact stable PWA origin, and `BACKEND_RP_ID` to that origin's exact hostname. HTTPS mode rejects missing, wildcard, path-bearing, credential-bearing, IP, mixed-protocol, or mismatched values. The server still binds only to `127.0.0.1`; a separately reviewed temporary TLS ingress must supply access control and must not expose a public unauthenticated route.

The server binds to `127.0.0.1:8787`. Provisioning is an internal workspace adapter; executable external modules are disabled. The supported entrypoint composes the security-core planner, committed local authorizer, durable live journal/authorization stores, recovery verifier, and final topology verifier. Canonical token/runtime/X/Y/Z values are pinned by `packages/security-core/config/sepolia.pwa-phase-one.json`; quote margins, divergence, confirmation depth, lag, and aggregate outlay are pinned by `packages/security-core/config/sepolia.pwa-provisioning-automation.json`; exact Zodiac Delay bytes are pinned by `packages/security-core/config/artifacts/zodiac-delay-v1.1.1-mastercopies.json`; Safe passkey proxy creation code is anchored to pinned `@safe-global/safe-passkey@0.2.0`. No deployment address, policy, nonce, RPC, fee, artifact, runtime hash, signer, recovery package, or authorization is accepted from browser input.

`BACKEND_JOURNAL_PATH` is only for prepared Safe submissions. `BACKEND_PROVISIONING_JOURNAL_PATH` is only for the seven-transaction deployment runner; startup rejects equal paths because their durable schemas are intentionally different. Each reviewed package gets a distinct append-only authorization sidecar next to the provisioning journal. Startup accepts an empty journal or one exact, fully verified successful prefix. A known pending hash stays unready until its exact canonical receipt can be verified; malformed, reverted, ambiguous, reorged or unsupported drifted evidence fails closed. Two committed testnet successor records exist. The older record binds original package `0xb307bb0656badfbeed91e9a4df500f31c85482563bb908010a85ef1f807d49bc`, signer prefix `959..960`, unrelated transactions `961..963`, and suffix `964..968`. The prefix-one record binds package `0x43e73064db98c9ab1baa51a2a238a4e4b04aa5d955321f3e2f869689da1a243a`, primary signer nonce `1030`, unrelated transaction `0xe146a16cd246241b86cdb0ce44dc93dd02ff3bd339102620fdff33eb0760db35` at nonce `1031`, and missing rows `secondary-signer@1032`, `setup-helper@1033`, `guard@1034`, `delay@1035`, `maintenance@1036`, and `safe-proxy@1037`. Both approved read providers reverify the committed public envelopes and receipts with six confirmations. The explicit private archive-access profile described below changes current readers only; original successor records and signed profile commitments remain immutable. Browser overrides are forbidden. After any successor row confirms, restart revalidates the original lineage plus the complete rebased journal prefix and resumes only its exact next row. A complete seven-row journal performs no authorization, signing, or submission: both read providers and the relay freshly fetch and agree on the confirmed deployer nonce, which must be at least the final deployment nonce plus one. Pending nonces must be at least their corresponding confirmed nonces; unrelated later confirmed or pending transactions are allowed. Historical reviewed nonces and addresses remain unchanged. The backend re-verifies all deployment receipts/runtimes, the Safe receipt, and final topology using the live nonce, then returns the existing vault for passkey rebind. Missing, regressed, or inconsistent reads still fail closed. Incomplete deployment recovery continues to require the exact first missing nonce; shared-account use cannot silently rebase its remaining CREATE addresses. Startup validates recovery but never broadcasts. An empty auto-provision request resumes the first missing transaction and never replays confirmed work.

`BACKEND_REVIEWED_ARTIFACTS`, `BACKEND_PROVISIONING_APPROVAL`, and `BACKEND_PROVISIONING_APPROVAL_HASH_FILE` are retired and must be absent; startup rejects each explicitly. Policy and reviewed artifacts are committed in security-core, and Phase One authorization is generated at the backend-local authorizer boundary. The fixed Safe proxy salt is `0`. Each passkey signer runtime hash is derived independently from reviewed proxy creation code, the verified factory `SINGLETON()`, that credential's coordinates, and the verified P-256 verifier through read-only EVM creation simulation.

After the second passkey verifies, the browser sends an empty `POST /v1/vaults/auto-provision`. The backend uses the two server-held credentials to create the unsigned review package, or uses a unique fully verified review package when recovering. A committed successor preserves the exact confirmed signer prefix and creates a distinct unsigned package whose missing rows start after the verified consumed nonce range; read-only preflight reports the first missing row and opens no journal writer. Before each new transaction, both approved read providers must agree on chain, one canonical quote block/hash, nonce, and prerequisite state. The higher live estimate and tip receive the committed 30% margin; estimates may diverge by at most 10%; the relay must agree on the quote block and latest/pending nonce; actual confirmed cost plus pending/new reservation must remain within `0.05 ETH`. The exact quote and transaction authorization is appended durably before signing. The relay then submits only that transaction, waits six confirmations, and re-verifies receipt/runtime before the next quote. Success is returned only after full topology verification.

After recovery, first-passkey sign-in opens the existing account without requiring the second signer. Public credential references/counters persist in SQLite. Every transaction still requires its fresh exact first signature, and elevated actions additionally verify the reviewed second key. Unknown legacy credential IDs are attached only after key proof; roles cannot substitute for each other. The older two-role rebind endpoints remain only in the singleton test harness.

This automation deliberately accepts the backend-compromise risk for local Sepolia Phase One. The local authorizer bounds consistency and cost; it is not an independent approver because it runs in the same process and trust domain as the planner, relay key, and broadcaster. A compromised backend that can alter that process can approve its own malicious plan within or by bypassing those checks. A later KMS/policy service must implement the same `ProvisioningAuthorizer` boundary in a separately administered trust domain before this design can claim independent authorization.

## HTTP contract

Open [Swagger UI](http://localhost:8787/documentation/) after starting the backend. The [OpenAPI JSON](http://localhost:8787/documentation/json) and [YAML](http://localhost:8787/documentation/yaml) document every application endpoint, request/response schema, approval sequence, authentication/header requirement and bigint wire format. The normal account API documents 13 operations; the legacy/test/HTTPS composition serves its own 10-operation specification, including singleton-only rebind routes. Documentation and bundled assets inherit existing loopback, Host (account API), Origin and no-store checks. Swagger's write console and remote validator are disabled. Schemas describe the existing contract without replacing runtime validation or serialization.

## Logging and entrypoints

`pnpm backend:dev` runs the dedicated `src/index.ts` entrypoint. `src/app.ts` exports import-safe server factories; importing it never starts a server or loads private configuration. The read-only profiler also has its own `scripts/profile-verification-cli.ts` entrypoint, separate from its importable implementation. Neither command detects execution by comparing file URLs with process arguments.

Fastify's native Pino logger records incoming requests, completion status and response time with a generated `reqId`. Handlers use `request.log`; background receipt checks use `fastify.log`. Development startup uses `pino-pretty` for readable timestamps/levels; `NODE_ENV=production` keeps standard JSON output and does not load the development formatter. Both use stdout. Tests normally use a silent logger or capture real Pino records.

Request/response serializers include only the method, closed route label and status code. Headers, cookies, bodies, assertions, submission identifiers, unknown paths and raw error payloads/stacks are excluded. A narrow Pino hook prevents implicit error messages from copying raw error text before serialization. Safe diagnostic codes/stages remain available for failures; disconnects are recorded once through the request logger. This operational logging never authorizes transactions and does not replace independent receipt alerts.

## Development checks and structure guide

Backend formatting uses **tab characters with a display width of 4** (`useTabs: true`, `tabWidth: 4`), also declared in `.editorconfig`. Prettier controls formatting; ESLint checks TypeScript correctness/style without competing indentation rules. Private environment/data files and generated output are excluded.

```sh
pnpm backend:format
pnpm backend:format:check
pnpm backend:lint
pnpm backend:lint:fix
pnpm backend:typecheck
pnpm backend:test
```

The root `check` includes backend linting. See the [current codebase diagrams and reorganization candidates](../../docs/codebase-map.md) and [file-by-file guide](../../docs/file-guide.md) before moving responsibilities.

### Submission behavior

The local default composes fixed-provider topology/snapshot verification, closed intent preparation and simulation, verified primary-first approvals, bounded exact outer-envelope signing, a synced public hash before one broadcast, and six-confirmation read-only observation. `GET /health` exposes `provisioningReady` separately from `writesReady`: empty fresh setup may register/provision while sends remain unavailable. An authenticated first key and a current verified vault are required; exact second approvals remain action-specific. The external submission journal and provisioning runner share a payer lease; any unresolved submission hash blocks a new signature even after restart. Status reconciliation reconstructs the original prepared intent at its recorded block and follows the exact stored hash without another signature or broadcast.

To create a separate account, sign out and choose **Create account**. The backend allocates new external evidence paths automatically; configured legacy evidence remains preserved. Keep archived data outside the fresh review directory. In the browser choose **Limits → Start a new test vault → Start a new test vault**; the app saves exact old account/UI metadata under an archive key containing its Safe address before resetting setup. Complete both new device registration ceremonies. The old onchain vault and its funds are unchanged; creating another vault does not transfer its balance.

All responses are JSON with `cache-control: no-store`. Request failures use `{ "error": string, "code": string, "stage": string, "requestId": string }`, and `x-request-id` matches. The backend emits one matching redacted JSON error event with method, route, status, code, and stage. It never logs request bodies, cookies, authorization headers, RPC URLs, keys, credentials, signatures, account/submission identifiers, query values or unknown path values. Requests with an `Origin` must match `BACKEND_ORIGIN`; non-loopback direct sockets are rejected. HTTPS-profile CORS responses allow credentials only for that exact origin.

### Startup and request logs

Run `npm run backend:dev` from the repository root. Wait for **`Backend ready at http://localhost:8787`** before using the browser. Startup emits `backend_starting` immediately before saved-account verification, followed by `backend_ready` only after the socket is listening. Both include the bind address, port and allowed browser origin; readiness also includes the actual listening URL. Verification can take a few seconds. If the page was opened before readiness, reload it after the ready message.

Each request emits `request_received` immediately, then `request_completed` with its HTTP status and elapsed `durationMs`. Long provisioning requests therefore remain visible while confirmations are pending. A disconnected client emits `request_aborted` once instead. Request events use generated correlation IDs, closed route templates and timestamps; they never copy request headers, bodies or private URL components. Errors retain their separate safe code/stage event. These operational logs do not replace the independent receipt observer or authorize actions.

If a fixed-provider read returns `ResourceNotFoundRpcError`, the backend waits 500 ms and repeats that exact read once. A second failure includes the safe RPC method and cause category in the correlated log. The exact `getTransactionCount` read also retries at most three times for RPC code `-32000` with the specific historical-state-unavailable error observed on Sepolia. Generic invalid-input errors are not retried. These retries apply only to read-only calls; `sendRawTransaction` is never retried automatically.

Automatic recovery also recognizes resource-not-found errors wrapped by viem gas-estimation errors. A bounded cause chain supplies only error names and numeric codes to logs. A known pending transaction reconciles its exact durable hash before another quote; canonical absence waits for confirmation, while other RPC failures remain errors. The backend makes at most three execution attempts, reconstructing verified progress each time.

If an unrelated transaction consumes the shared gas account's next nonce before any non-signer component is deployed, the backend can discover a bounded, independently checked successor: at most 32 consumed nonces and 4,096 canonical blocks, with both providers agreeing on envelopes, canonical receipts, original signer runtimes and empty future addresses. It retains the original package and writes a new unsigned package plus an append-only `.successors.json` sidecar automatically. These sidecars are hints; every restart verifies their chain evidence again. No browser or environment successor override exists. When otherwise consistent consumed-nonce evidence still needs confirmations, startup stays available for recovery and the automatic request waits for at most 24 five-second intervals while repeating the complete verification. Unsupported drift, conflicting lineage or uncertain broadcasts never become a fresh nonce retry.

Completed current accounts are restored before the server listens, using only the already verified seven-receipt recovery path; this signs and broadcasts nothing. `GET /v1/vaults/current` immediately reports the existing account and required passkey binding state. The browser refreshes that status only after matching every saved account identity field. An unfinished browser setup resumes automatically after reload using its existing credential references; no setup command or fresh passkey registration is required.

The normal backend entrypoint composes `ConfiguredSubmissionRuntime`. The three `/v1/submissions` routes below become usable only after current-vault verification and both genuine factor bindings succeed.

- `GET /health` returns process readiness, `{ ok, chainId, profileId, origin, rpId }`. The browser rejects any identity mismatch before opening a WebAuthn ceremony. It does not claim that a vault is provisioned or that chain state is healthy.
- `POST /v1/registrations/{primary|secondary}/options` creates an account/session-bound, one-use user-verified registration challenge. First credentials use stable user handles, required discoverability and no forced attachment.
- `POST /v1/registrations/{primary|secondary}/verify` verifies the matching registration ceremony and stores only credential metadata.
- `POST /v1/vaults/auto-provision` accepts only `{}`. Fresh mode requires both registrations; recovery mode uses the uniquely reconstructed plan and requires no browser deployment metadata. It persists every new authorization before signing, resumes only the first missing transaction, and returns only the verified public vault projection. Duplicate clicks/tabs share one in-process operation. The retired `/v1/vaults/plan` and `/v1/vaults` routes return 404.
- `POST /v1/credentials/{primary|secondary}/rebind/options` accepts only `{}` for a recovered vault and creates a short-lived, one-use local-profile assertion challenge.
- `POST /v1/credentials/{primary|secondary}/rebind/verify` accepts only the matching session and standard assertion response; it verifies the assertion against the reviewed role key and unlocks spending only after both roles succeed.
- `POST /v1/submissions/prepare` accepts one exact human intent: `transfer`, `cancel-queued`, `execute-ready`, or `skip-expired`. It re-reads server-held state, delegates exact X/Y/Z construction to security-core, and journals the immutable public request. Browser-supplied calldata and Safe/Delay fields are rejected.
- `POST /v1/submissions/{id}/submit` accepts `{role,assertion}` for primary/secondary or `{role:"none"}` only for ready execution/expired skip. It revalidates before the WebAuthn prompt and again before broadcast, persists the locally derived outer transaction hash before sending, requires primary before secondary, and single-flights duplicate tabs/clicks.
- `GET /v1/submissions/{id}` reconciles only the exact durable outer hash before returning. It never signs, broadcasts, or authorizes a replacement.

Submission states are monotonic: `prepared`, `awaiting-primary`, `awaiting-secondary`, `submitting`, `uncertain`, then `confirmed`, `reverted`, or `superseded`. The journal contains the public intent, hashes, approval-presence booleans, and public receipt identity. Raw WebAuthn assertions and reusable signature payloads remain process-local and are never persisted.

The backend relay account pays gas only. Safe owners, the spending guard, Delay, USDC metadata, topology, nonce, limits, recipient policy, receipts, and cancellation remain authoritative onchain or in reviewed security-core adapters. Preparation passes only recipient, amount, and idempotency intent from the browser; the adapter must derive the exact Safe transaction from the server-held vault and fresh chain reads.

## Verify

```sh
pnpm --dir apps/backend test
pnpm --dir apps/backend typecheck
```

Live Sepolia rehearsal remains separately authorized, capped, and recorded. No backend test proves hardware/WebAuthn UX or production readiness.

The backend is not the independent receipt observer. The security-core verification library must eventually run in a separate clean process with fixed public read-only RPC access and no backend, relay, signer, credential, or deployment secret. Its executable is currently fail-closed until that in-repository composition is reviewed. Observer records explicitly make no notification-delivery claim and never authorize a submission.

For the HTTPS/mobile gate, keep this server bound to `127.0.0.1`. The temporary TLS ingress must enforce an authenticated developer access policy before forwarding, preserve the one exact configured Origin/CORS identity, expose no admin/debug route or URL secret, and have a reviewed shutdown deadline. Record only redacted configuration hashes. At closeout, disable/delete the ingress and verify its public backend origin is unavailable from an external network; a still-working public URL means Phase One closeout fails.

## Historical vault compatibility

The completed pre-recipient-mode Sepolia vault is recognized through the exact original/completed package pair pinned in `packages/security-core/config/sepolia.pwa-historical-vault.json`. Its reviewed all-lanes allowlist policy remains unchanged. Startup independently verifies all seven historical transactions, canonical six-confirmation receipts, costs, runtimes, the committed consumed-nonce lineage, official dependencies, signer-factory bindings, and old Safe/guard/Delay topology through both fixed providers. Topology reads use one common canonical block and recheck its hash afterward. Historical verification failures stop startup; no error is caught into a permissive fallback.

For this vault, `/health` returns `ok: true`, `writesReady: false`, and `vaultCompatibility.mode: "read-only"`. `GET /v1/vaults/current` returns the verified public addresses, historical recipient policy, package identities, and snapshot evidence. Every POST returns HTTP 409 with code `vault_read_only`; direct provisioning, credential, approval, submission, and reconciliation handlers also reject. No current-profile provisioning capability is created, and startup does not open a provisioning writer, register/rebind credentials, sign, or broadcast. The external journals/reviews are preserved. New-profile provisioning remains separate; restoring compatibility does not upgrade or redeploy this vault.

### Automatic receipt reconciliation and verification reads

While the local backend is running, a read-only worker scans durable submission journals on startup and 12 seconds after each sweep completes. It reconciles only retained `submitting`/`uncertain` hashes, including accounts not open in a browser. Failures leave evidence unresolved and keep the shared payer blocked; subsequent sweeps retry. Shutdown drains the current sweep. Manual GETs and the worker share one per-submission proof. Receipt confirmation still requires both fixed providers, six canonical confirmations and the existing observation proof for successful executions. The worker never signs or rebroadcasts.

Submission readers batch concurrent JSON-RPC requests. Identical explicitly pinned reads are deduplicated within one provider-local collection; independent topology reads run concurrently and retain deterministic report ordering. Chain/head/block anchors remain uncached by the scope. Every approval/signing/broadcast boundary still revalidates; an adjacent consumer reuses the snapshot just returned by that validation. There is no cross-boundary, cross-account, cross-provider or timed verification cache. Provisioning remains unchanged.

### Local verification profiling

Run the existing verification core in an isolated read-only process. No relay key, browser session or passkey prompt is needed:

```sh
npm run backend:profile:verification -- --account-directory /absolute/external/account --samples 3
```

For older receipts outside Publicnode's retention window, explicitly select the approved Infura/Tenderly evidence pair using a private external configuration file:

```sh
npm run backend:profile:verification -- --account-directory /absolute/external/account --evidence-config /absolute/private/read-evidence.json --samples 3
```

The account directory must contain its completed seven-receipt `provisioning.json` and original `reviews/` evidence. `--samples` accepts 1–5. Optional `--output-directory /new/external/directory` selects a new directory outside the repository and source evidence; existing directories are refused. Default output is a new private temporary directory. Capture failures also print that location once output exists.

Outputs are `summary.json` (stage wall/process CPU times, HTTP/RPC counts, batch sizes and consumed decoded response-body bytes), `verification.trace.json` (Perfetto-compatible trace), and `verification.cpuprofile` (V8 CPU profile). Recovery/restoration are separate from repeated verification samples. This measures **verification core only**; browser rendering, passkeys, snapshot collection, simulation, broadcast, inclusion and confirmation wait are excluded. A failed capture has `completed: false` and partial timings; it is not a successful sample.

The default remains Publicnode/Tenderly and fails closed when either lacks evidence. The explicit archive profile replaces the complete reader pair with Infura/Tenderly; it never substitutes a lone receipt or accepts one-provider confirmation. It does not change the relay write boundary or historical reviewed plans. Redirects and write/sign RPC methods are rejected; journals/reviews are never written or locked. Summary/trace labels disclose the selected profile and operators without URLs, keys or raw RPC contents. CPU profiles expose function/source locations; review all files before sharing. The command uploads nothing. See [verification profiling](../../packages/security-core/docs/security/verification-profiling.md) for private configuration, trace viewing and troubleshooting.
