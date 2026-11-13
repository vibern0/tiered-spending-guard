# Local wallet backend

`apps/backend` is the required loopback write boundary for the Ethereum Sepolia wallet. It serves independent accounts, passkey login, background vault creation, ordinary-Safe submissions and confirmed USDC/vault history. This remains security research and a testnet prototype; live Sepolia, independent-alert and audit gates remain open.

Use Node **24.21.0** from `.node-version`. The browser runs at `http://localhost:5173`, uses `VITE_BACKEND_ORIGIN=http://localhost:8787`, and sends credentialed requests. The backend binds only `127.0.0.1`; use the browser hostname `localhost` consistently. Only the local profile is supported. Shared HTTPS access and physical-device/provider verification require a later reviewed identity.

## Run

Keep configuration, relay keys, RPC credentials, account data and evidence outside the repository. The CLI quietly loads an external environment file selected by `DOTENV_CONFIG_PATH`; alternatively, an ignored `apps/backend/.env` symlink may point outside the repository. Shell values take precedence. Missing explicit files, unreadable targets and repository-local targets fail with sanitized diagnostics.

```sh
DOTENV_CONFIG_PATH=/absolute/external/path/backend.env pnpm backend:dev
```

The external environment must contain:

| Setting                        | Purpose                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------- |
| `BACKEND_RELAY_PRIVATE_KEY`    | Local Sepolia payer secret; never a Safe owner or browser credential.         |
| `BACKEND_RPC_URL`              | Configured relay RPC transport.                                               |
| `BACKEND_EVIDENCE_CONFIG_PATH` | Absolute external path to the private evidence-reader configuration.          |
| `BACKEND_DATA_DIRECTORY`       | Absolute external data root; use a fresh empty root for this database format. |

`BACKEND_PROFILE=local`, `BACKEND_ORIGIN=http://localhost:5173`, `BACKEND_RP_ID=localhost` and `BACKEND_PORT=8787` are the defaults. Other profiles or WebAuthn identities are rejected.

The evidence-reader file is a bounded private JSON file with mode `0600`, exactly the keys `version`, `infuraUrl`, `alchemyUrl`, and `version: 2`. Its endpoints must be the exact HTTPS Sepolia Infura `/v3/<32-hex-key>` and Alchemy `/v2/<key>` service identities. Both independent operators are required; arbitrary providers, redirects and public/free fallback selection are rejected. Keep credential-bearing URLs out of source, logs and public evidence. Existing deployment/profile commitments remain immutable; current reader access does not rewrite them.

The data root derives `accounts.sqlite` and per-account journals/reviews. SQLite stores public credential IDs/keys, counters, replay metadata, opaque-session verifiers, creation jobs and rebuildable history. Private passkeys remain with their authenticators; assertions and approval payloads are not persisted. Back up SQLite transaction state and authoritative evidence together. A missing/incompatible database with retained evidence fails closed. There is no import, migration, legacy adoption or automatic deletion of old data; leave older roots untouched.

## Account and creation flow

1. Choose **Create account**, register a discoverable first passkey, then verify sign-in with that same key.
2. Register a distinct second signer. Its verified credential and one creation-job marker commit atomically.
3. The server worker provisions and verifies that account in the background. Browser closure, logout and session expiry do not cancel its bounded deployment job.
4. Use **Sign in with passkey** to reopen the same account after browser storage is cleared. The second signer is requested only for actions that require its exact approval.

Account setup states are `registering`, `queued`, `provisioning`, `verified` and `blocked`. The browser observes `GET /v1/auth/session`; an empty `POST /v1/vaults/auto-provision` promptly returns HTTP 202 with setup state and only rejoins/observes the existing job. `GET /v1/vaults/current` stays unavailable until verification. No long-running deployment HTTP request or browser re-registration is required.

After the server starts listening, only explicit queued/in-progress jobs in the current database may resume. Startup validation itself remains read-only. The worker holds the shared payer coordinator before nonce planning and preserves the exact seven serial deployment transactions, unsigned reproducible reviews, per-transaction bounded authorization, durable hashes, six-confirmation canonical receipts, runtime checks and final topology verification. Confirmed work is never replayed. Unknown evidence, nonce drift and exhausted transient retries block the job; there is no successor/rebase or arbitrary replacement plan.

One payer serializes account writes. An uncertain submission or incomplete immutable deployment blocks new signatures across accounts until safely reconciled; login and reads remain available. Database readiness and history cannot release that blocker. Deployment authorization remains local consistency/cost bounding, not independent approval; the separately administered authorization and production gates remain unchanged.

## Submissions and history

Supported intents are USDC transfer, delayed recipient addition, cancellation, ready execution and expired-item skipping. The browser reviews the exact request and obtains the required fresh first/second passkey assertions. The backend revalidates it, signs only the bounded outer envelope, persists its hash before one broadcast and verifies its receipt. Cookie sessions authenticate access and never authorize spending. Logout invalidates retained unsubmitted approvals; read-only reconciliation can continue for already recorded hashes.

`GET /v1/vaults/current/history?limit=50&cursor=...` returns account-scoped confirmed history. `limit` accepts 1–100; `nextCursor` requests older rows. Amounts and other bigint fields retain the `"123n"` JSON codec; timestamps are seconds. The index starts at verified creation and compares canonical blocks and relevant events across both readers at six confirmations. It includes USDC deposits/withdrawals, self-transfers, delayed proposals and supported vault actions outside the app. Direct eventless Delay execution/skip calls are inspected from canonical block transactions; eventless internal calls and explorer-wide traces are outside scope. Unknown vault events stay unsupported. Unexplained queue-head advances or eventless internal observation gaps produce `unresolved` / “Outcome unavailable”, never an invented successful execution. Expiry is derived, not invented as a blockchain transaction.

After verified provisioning, `AccountStore.completeCreation` retains only chain, Safe, guard, Delay, USDC and setup-block identity for display discovery. `historyAccounts`/`historyVault` expose that public projection, never a verified execution capability. History rotates through 20-account batches without loading stored accounts' private gateway runtimes; failures are isolated. General account enumeration materializes 100-row keyset pages before awaiting, so SQLite WAL cursors do not remain pinned.

History and receipt workers keep running without a browser and cannot sign or broadcast. The creation worker has only the separately committed bounded deployment authority. History is rebuildable and never replaces deployment/submission journals or independent alerts. Activity merges confirmed records with current verified queue controls and pending/failed app submissions by exact hash/fingerprint, preserving account isolation and rejecting late responses from an earlier session. Public submission metadata retains `preparedKind` and `preparedAt`; canonical decimal amounts parse directly to bigint. Polling refreshes the loaded page range through fresh cursors and discards invalidated cached ranges. The view refreshes a bounded window; new records can move the oldest displayed item onto an older page.

## API and operations

Open [Swagger UI](http://localhost:8787/documentation/), [OpenAPI JSON](http://localhost:8787/documentation/json) or [YAML](http://localhost:8787/documentation/yaml). Fastify route schemas supply request validation and documentation. Closed schemas reject unknown fields without coercion; domain and cryptographic checks remain in their existing boundaries. Swagger is read-only and inherits loopback/Host/Origin/no-store checks. Authenticated writes also require the exact cookie, CSRF and selected-account context.

`src/index.ts` loads configuration and starts the import-safe `src/app.ts` composition. Feature routes adapt HTTP; account/auth, provisioning, submissions and history own their workflows. `chain/` owns strict RPC adapters and the payer coordinator; `jobs/worker.ts` schedules non-overlapping sweeps. Shutdown stops new request admission and job scheduling, drains active operations, then closes stores. Native Pino logs only allowlisted public diagnostics; production uses JSON and development may use the installed formatter. Verification profiling, singleton/HTTPS compatibility, legacy rebind and historical successor management are removed.

```sh
pnpm backend:format:check
pnpm backend:lint
pnpm backend:typecheck
pnpm backend:test
```

Backend source formatting uses tabs with width 4. See the [codebase map](../../docs/codebase-map.md) and [file guide](../../docs/file-guide.md) for current ownership. No mainnet deployment, funding or external data erasure is part of this workflow.
