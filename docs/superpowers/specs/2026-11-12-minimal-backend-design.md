# Minimal Local Backend Design

**Status:** Approved in chat; implementation authorized. The user explicitly waived a separate implementation plan.
**Date:** 2026-11-12
**Baseline:** `41fb251` (`main`).

## Intent

Reduce `apps/backend` to accounts, passkey login, automatic vault creation, ordinary-Safe submission and USDC/vault history. Keep Swagger. Delete unsupported modes and historical compatibility rather than reorganizing them again.

## Confirmed Requirements

- Independent accounts, one asset-holding Safe per account, no hard account-count limit.
- Synced first-passkey login; second approval only when the action requires it. Private passkey material stays with the user's device/provider.
- Fresh accounts only. Existing account/deployment import and compatibility are unnecessary.
- Localhost now; shared HTTPS access from other physical devices is a later milestone. Do not claim localhost credentials automatically transfer to a future public RP.
- Keep Swagger; remove verification profiling. Browser/backend API changes are permitted.
- Reliable configured RPC providers are acceptable; free-provider workarounds are not a product requirement.
- After both credentials register, vault creation should finish in the background without an open browser.
- History covers USDC deposits, withdrawals and vault actions, including activity outside the app.
- Retain the ordinary-Safe backend relay while the contracts lack a verified replacement execution path. ERC-4337 remains separate work.
- Explore and agree on cuts before implementation. Tests were excluded from exploration, not from required implementation verification.

Public credential IDs, keys, account associations and anti-replay metadata remain necessary for the existing login design. The user's database-tampering concern and suggested future ZK research are recorded in [signer provider evaluation](../../../packages/security-core/docs/security/signer-provider-evaluation.md#2026-11-12-known-risk-account-database-integrity). This approved design retains those public records; it adds no ZK mechanism or private-key storage.

## Approaches

1. **Targeted reduction around the existing security core — recommended.** Delete historical branches, make the current flows concrete, and reuse the verified planner, authorization, guard, transport and observation boundaries. Add only the background scheduling and supported history that the user requested.
2. **Rewrite the backend and its persistence.** Can make the folder look smaller, but replaces working account/session and crash-recovery behavior at the same time. No demonstrated benefit justifies that additional security work.
3. **Move execution to the browser now.** Requires a verified external execution/deployment path. The native design has open gates; deleting the relay does not supply a replacement.

The retained ordinary-Safe direction follows the latest conversation. The user approved the concrete cuts and implementation defaults below in chat.

## Security Boundaries

Preserve X/Y/Z, exact Safe transaction/signature binding, the sole primary owner, guard-only secondary, both guard slots, Delay-only module, closed intents and delayed weakening. No Solidity, signature-format, custody, WalletConnect or account-abstraction change.

Keep loopback/Host/Origin/CORS/CSRF checks, authenticated account/session ownership, challenge expiry/consumption, atomic counters/replay fingerprints and logout approval invalidation. A session never authorizes spending.

Keep two independent approved readers, canonical block/runtime/topology checks, bounded fees/outlay, durable authorization before deployment signing, hash persistence before broadcast and six-confirmation receipt verification. Preserve all required security-core evidence and unsigned reproducible reviews. History caches and database readiness flags cannot grant verified execution capabilities or release a pending payer blocker.

The relay key pays for the outer transaction; user passkeys authorize the Safe action. One payer serializes nonce-consuming work. Uncertain transactions or incomplete immutable deployments continue to block new signatures across accounts until safely reconciled; login and read routes remain available. No payer pool or distributed job system.

Independent monitoring remains mandatory and non-authorizing. Neither the history view nor the backend receipt worker substitutes for independent alerts. Existing live, native, provider, browser and audit gates remain unchanged.

### Explicit Background-Creation Amendment

Approval supersedes the earlier rule that startup never leads to provisioning broadcasts in the [dynamic recovery design](../../../packages/security-core/docs/superpowers/specs/2026-11-01-dynamic-pwa-provisioning-envelope-and-recovery-design.md) and [automatic provisioning design](../../../packages/security-core/docs/superpowers/specs/2026-11-01-phase-one-automated-pwa-provisioning-design.md). Startup verification itself stays read-only. After the server starts, only an explicitly committed current-account creation job may resume through the unchanged payer coordinator, bounded authorizer, exact recovery verifier and seven-transaction executor. Completed jobs do not broadcast. Startup discovery never creates a job from historical files or credential records alone. Receipt/history workers remain read-only. Carry this narrowly scoped amendment into those specifications and the call graph before enabling the worker.

## Concrete Cuts

| Existing code | Proposed change |
| --- | --- |
| `apps/backend/src/compatibility/` | Delete singleton server/routes, legacy challenge stores and unused submission implementation. |
| `apps/backend/scripts/profile-verification*.ts`, `verification-profiler.ts` | Delete profiling commands and documentation references. |
| `apps/backend/src/app.ts` | Remove singleton/test-server composition and inactive HTTPS composition. One supported local account application. |
| `accounts/runtime.ts`, `store.ts`, `auth/service.ts` | Remove legacy adoption, historical coordinate discovery and legacy-specific persistence/path branches. Keep current account/session isolation. |
| `auth/vault-credentials.ts`, `vaults/service.ts`, `vaults/types.ts` | One persistent credential source and current action-specific approval semantics. Delete explicit legacy rebind and old blanket readiness modes; collapse forwarding layers where they add no checks or workflow. |
| `provisioning/runtime.ts`, `service.ts` | Delete unused public recovery preflight and its types. Keep bounded ordinary deployment and exact restart recovery. |
| `provisioning/successors.ts` and automatic nonce-gap discovery | Remove backend-managed historical successor/rebase machinery. Unexpected payer nonce consumption fails closed; no automatic replacement plan. Preserve the core/historical research evidence. |
| Feature documentation schemas and `http/openapi.ts` | Retain Swagger; remove parallel endpoint descriptions where Fastify route schemas can describe and validate the same request. Preserve exact rejection semantics. |
| `chain/read-client.ts`, `relay-client.ts`, submission read adapters | Reuse common RPC adaptation without exposing broadcasting capabilities to observers. Remove obsolete provider-selection and free-Tenderly pacing behavior once two configured readers replace it. Keep strict batch identity validation if batching remains. |
| `config/` | Local profile only; propose one external data root with derived per-account paths. Keep secrets/config external, path validation and sanitized diagnostics. |

Fresh start means a new empty external data root and an explicitly new database format, not an automatic deletion of old databases, secrets or evidence. Do not add a migration/import layer or silently upgrade an old database. Existing nonempty incompatible roots fail closed; never silently reset them. Historical baseline fixtures, archived evidence and quarantined `legacy/` contracts remain intact.

Removing successor/rebase support deliberately reduces availability after unrelated payer nonce consumption. Dedicated payer use and serialization cover normal operation; inconsistent nonces stop work for operator investigation rather than silently redeploying. This approved simplification is not permission to weaken the immutable deployment verifier.

## Minimal Runtime

Keep Fastify, the installed WebAuthn verifier, viem and built-in SQLite. Add no framework, database driver, job broker, provider SDK or general-purpose service/repository layer. Preserve deployment/submission journal durability instead of replacing it with ordinary database flags. Use concrete calls and one owner for each workflow; do not move backend complexity into security-core merely to reduce this folder's line count.

**Accounts/login:** existing discoverable first-key registration and authentication, distinct second-key registration, public credential metadata, opaque cookie sessions and account-scoped access. A fresh login restores the same account after browser storage reset. No key replacement through registration. Load accounts lazily and use bounded queries/work batches; no fixed total-account limit or eager runtime per stored account.

**Creation:** second-registration completion durably marks the account as eligible for its one provisioning operation. An in-process worker starts on server startup and picks eligible work through the existing payer coordinator. HTTP reports account setup state promptly; the browser does not keep a deployment request alive. Repeated requests only observe/rejoin the same job.

Commit the verified second credential and its fixed creation-job eligibility atomically in SQLite, before scheduling. A crash cannot leave two committed credentials without the intended job marker. Startup resumes only explicit queued/in-progress jobs in the current database format; it never infers permission from two credential records alone. Freeze the credential pair when binding the plan. Construct nonce-dependent plans only while holding payer coordination. Reuse the seven serial transactions, per-transaction authorizer, receipt checks and final topology verification. The committed job continues after browser closure, logout or session expiry; that authority covers only its bounded deployment, never spending or later passkey approvals.

Resume the exact confirmed prefix after restart. Reconcile recorded hashes before another signature; never replay a confirmed deployment or create a replacement account. Retry bounded transient provider failures through the existing verifier. Evidence conflicts, nonce drift or an exhausted retry budget leave a visible blocked state and retain the payer blocker until an operator safely reconciles it. There is no stop/resume UI or arbitrary job input. Shutdown stops new request admission and job scheduling, drains active operations and closes stores afterward.

**Submissions:** preserve the existing transfer, add-recipient, cancel-queued, execute-ready and skip-expired intents. The browser shows review and obtains the exact required passkey assertions. The backend revalidates, derives the bounded outer transaction, persists its hash, broadcasts once and observes its receipt. Approvals remain one-use process memory scoped to the initiating account/session. Read-only reconciliation survives logout/restart and cannot sign or broadcast.

## History

Use the configured read clients to read the known USDC, Safe, guard and Delay event surfaces. No full explorer, NFT indexer or third-party history SDK is needed for the agreed first scope. Start each vault's scan at its verified creation block; process bounded block ranges and account batches.

Implementation discovery uses a minimal public chain/Safe/guard/Delay/USDC/setup-block projection written by `AccountStore.completeCreation` only after verified provisioning. `historyVault`/`historyAccounts` supply display data, never branded execution authority. The worker rotates through 20-account batches without loading stored accounts' private gateway handlers; failures remain isolated. General account enumeration materializes 100-row keyset pages before awaiting and releases SQLite WAL cursors.

Index USDC `Transfer` events with the Safe as sender or recipient, plus the currently supported vault actions: base/step-up sends, delayed proposals, recipient additions, cancellation, ready execution and expired-item skipping. Correlate related logs by transaction hash and preserve log identity so a withdrawal and its guard authorization do not appear as two transfers. Self-transfers count once with an explicit self-transfer direction. Expiry is a derived queue status, not an invented blockchain transaction.

Compare relevant logs and canonical block identities across both readers before marking history confirmed at the existing six-confirmation depth. Keep block hashes and a durable scan cursor; reconcile/rescan a changed checkpoint rather than retaining conflicting history. A history disagreement never downgrades the authoritative submission evidence or bypasses its checks. Cursors bind the account, vault identity and retained row/block hash; removed or changed anchors reject. The browser refreshes its loaded page range through fresh cursors and discards invalidated cached ranges.

Store rebuildable history/cache rows in SQLite and serve an authenticated, account-scoped, cursor-paginated read endpoint. Index discovery continues without a browser. Rebuilding the cache never deletes deployment or submission evidence. Derive queue status from verified events/state; reuse current decoders where they fit. Unknown vault events remain labeled unsupported rather than being decoded as an authorized action. Unexplained queue-head advances and eventless internal observation gaps retain an `unresolved` outcome; they never invent execution/skip success or expose history-only execution controls.

Merge pending/failed application submissions into the view by their exact recorded outer hashes. Persist public `preparedKind` and `preparedAt` for restored lane/time metadata, and parse canonical decimal amounts directly to bigint without floating-point conversion. Failed external calls that emit no relevant event, unrelated tokens, NFTs and explorer-wide internal-call tracing are outside this history scope. No private assertions, signatures, secrets or raw signed envelopes enter history storage. A deleted cache must be reconstructible from chain plus the separate authoritative submission journal.

## API, Swagger and Browser

Use existing route schemas as the common request contract and generate Swagger from them where possible. Reject unknown fields; do not silently strip, coerce or default security-sensitive inputs. Retain domain validation and signature verification in security-core/WebAuthn. Keep the current bigint wire format initially; changing it is not needed to remove duplicate documentation.

Adapt the browser to queued setup/status and the history endpoint, remove legacy rebind/import paths and use backend history for Activity. Keep stale-session/account-response rejection and all exact transaction review checks. Pagination introduces only explicitly validated history query parameters; do not relax other routes' closed URL/query rules. A separately reviewed stable HTTPS identity is still required for physical-device access.

## Delivery Order and Proof

1. Delete obsolete modes/tooling and simplify composition while preserving current behavior.
2. Replace duplicated request/documentation definitions and streamline configured readers.
3. Make account provisioning a durable background operation.
4. Add supported onchain history and update the browser Activity flow.

Keep these changes reviewable separately. Report actual source/dependency reduction and new functionality separately; no line-count target justifies deleting a security check.

The user waived a separate implementation plan. Reconcile the affected approved specifications/call graph with this scope before enabling the background worker. Use test-driven checks for new account, worker, encoding, history and monitoring behavior. Preserve meaningful current account isolation/replay, crash-point, payer, receipt, real-Safe X/Y/Z/cancel/expiry/recipient-maintenance and observer regressions. Add background close/restart/duplicate-job and outside-app USDC history/reorg/pagination checks. Test isolation is not a reason to preserve the obsolete production server.

Run the appropriate backend/app/core gates and source-path evidence checks after affected edits. Update dependency review and the exact lockfile for any dependency change. No live deployment, funding, external data erasure, new onchain contract, ZK or production-readiness claim is part of this cleanup.

## Approved Implementation Defaults

- Keep one payer and its deliberate cross-account blocking on unresolved work.
- Keep public WebAuthn metadata and authoritative filesystem evidence; avoid a simultaneous storage rewrite.
- Remove automatic historical nonce-gap successor recovery; fail closed on unexpected payer nonce use.
- Use a fresh external data root and leave old evidence untouched.
- Build only the agreed event-based USDC/vault history; retain failed app attempts separately.
- Keep API bigint encoding and installed infrastructure; avoid new dependencies.

These defaults were approved in chat. Implementation does not complete the outstanding independent-alert, live Sepolia, native or audit gates.
