# Read the backend from here

The backend connects the browser to the vault. It handles accounts and login, creates vaults in the background, submits exactly approved transactions, and reads confirmed history. The smart contracts enforce spending limits and delays. A browser login alone cannot approve spending.

Start with these three files:

1. [`app.ts`](app.ts) opens the stores and starts the server. It shows which pieces the application needs.
2. [`http/server.ts`](http/server.ts) connects routes and background jobs. It shows what the backend does.
3. [`auth/routes.ts`](auth/routes.ts) is a small example of a request handler. Follow its calls into [`auth/service.ts`](auth/service.ts) to see the login workflow.

Read the folder for the workflow you are changing next. You do not need to read every file in order.

## What each folder does

| Folder                           | What it owns                                                                                               | Why it exists / where to start                                                                                                                                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`accounts/`](accounts/)         | Accounts, stored public credentials, sessions, creation-job markers, and per-account runtime selection.    | Keeps one account's requests and evidence separate from another's. `service.ts` is the small public view; `store.ts` owns SQLite; `runtime.ts` connects account-specific capabilities.                                     |
| [`auth/`](auth/)                 | Passkey registration, login, logout, and proof of approval for a specific Safe transaction.                | Login and transaction approval serve different purposes. Start with `routes.ts` and `service.ts`; `webauthn.ts` verifies proofs and `signatures.ts` decodes their strict formats.                                          |
| [`vaults/`](vaults/)             | The current verified vault and the operations available for it.                                            | Coordinates credentials, provisioning, and submissions behind one account-specific interface. Start with `service.ts`. It does not replace contract policy.                                                                |
| [`provisioning/`](provisioning/) | Creating and verifying a vault, saving progress, and resuming exact recorded work.                         | Creation takes seven transactions and must survive interruption without replaying confirmed work. `service.ts` manages progress; `runtime.ts` supplies the configured implementation; `recovery.ts` checks saved evidence. |
| [`submissions/`](submissions/)   | Preparing an action, collecting its required approvals, submitting it, and checking the result.            | Owns the transaction lifecycle. Start with `service.ts`, then follow `prepare.ts` → `execute.ts` → `reconcile.ts`. `journal.ts` saves authoritative progress; `observations.ts` handles receipt observations.              |
| [`chain/`](chain/)               | RPC readers, the broadcast adapter, and shared payer coordination.                                         | Keeps provider details out of workflows and prevents accounts from racing for the same payer nonce. Start with `read-client.ts`; `payer-coordinator.ts` owns serialization and unresolved-work blockers.                   |
| [`history/`](history/)           | Confirmed USDC/vault activity, canonical-chain checks, and pagination.                                     | The browser needs readable history, including supported activity outside the app. This cache can be rebuilt; it never approves spending or replaces submission evidence. Start with `types.ts`, then `service.ts`.         |
| [`http/`](http/)                 | Request parsing, loopback/Origin/CSRF checks, safe errors, route schemas, Swagger, and server composition. | Adapts HTTP to workflows. `security.ts` checks access; `fastify.ts` sets parsing/reply rules; `schema.ts` builds reusable API descriptions; `server.ts` wires everything together.                                         |
| [`config/`](config/)             | Validated local settings and loading an external environment file.                                         | Keeps credentials and writable data outside the repository. `environment.ts` loads CLI settings; `config.ts` validates them.                                                                                               |
| [`jobs/`](jobs/)                 | A small scheduler for creation, receipt, and history sweeps.                                               | Work continues after the browser closes. `worker.ts` prevents overlapping sweeps and waits for active work during shutdown.                                                                                                |

At this level, [`index.ts`](index.ts) is the executable entry point: it loads settings, starts the app, and handles termination. [`app.ts`](app.ts) is import-safe composition, so tests can import it without starting a server. [`logging.ts`](logging.ts) restricts what reaches logs.

Outside `src`, [`../tests/`](../tests/) contains automated tests and fixtures. The backend's `package.json`, `tsconfig.json`, `eslint.config.js`, `.prettierrc`, `.prettierignore`, `.editorconfig`, and `vitest.config.ts` configure running, checking, formatting, and testing; they are not additional application layers. Dependency, build-output, and coverage folders are generated.

## How one request travels

```text
Browser → HTTP access checks → feature route → feature service → store / chain adapter
```

For a transfer, `submissions/routes.ts` gets the authenticated account and passes the request to that account's vault handlers. `vaults/service.ts` coordinates the operation. `submissions/service.ts` manages preparation and approval; `prepare.ts` builds the exact action, `execute.ts` records the signed transaction hash before broadcasting, and `reconcile.ts` checks canonical receipts. The guard and Delay contracts enforce X/Y/Z onchain.

A route should explain HTTP input/output. A service should explain the workflow. A chain adapter should explain provider communication. A store/journal should explain persistent state. These responsibilities can share a folder without requiring another abstraction.

## Is all of this needed?

The current app needs accounts/login, creation, submissions, and history to deliver its existing features. Some of the size comes from interruption handling and security checks: sessions cannot authorize spending, recorded hashes cannot be replayed, the shared payer cannot sign around unresolved work, and history must not invent successful outcomes.

Not every file is a runtime subsystem:

- `types.ts` defines data shapes; it does not run a separate service.
- `schemas.ts` describes API input/output, validates requests, and supplies Swagger documentation. Cryptographic and contract checks still run separately.
- `runtime.ts` connects a workflow to concrete providers and stores. It is useful where tests need substitutes or account-specific capabilities are created.
- Tests and fixtures support verification; they are not loaded as application features.

There is room to simplify. `submissions/core.ts` is a small package-import and intent-hash adapter. `http/errors.ts` retains a diagnostic classifier with no backend source caller. `history/service.ts` and `accounts/store.ts` are large and deserve focused reading before introducing more files. These are review candidates, not proof that their surrounding checks can be removed. This documentation change does not delete behavior.

Contracts and operating commands now live in [`packages/core`](../../../packages/core/README.md); reusable TypeScript lives in [`packages/sdk`](../../../packages/sdk/README.md). The backend imports `@tiered-spending-guard/sdk/pwa`. Build core before starting the backend so the SDK has its verified public resources. The core and SDK guides describe the ownership and security boundaries.
