# Fastify Backend Reorganization Design

## Intent

Replace both Node HTTP server implementations with Fastify. Preserve every existing endpoint, response, security check, and background-worker lifecycle. Make route ownership visible under `apps/backend/src/routes/`. Move account/session orchestration and submission lookup behind services under `apps/backend/src/services/`.

## Goals

- Fastify creates and owns both backend servers.
- All route registration lives under `apps/backend/src/routes/`.
- Account creation/session projection lives in an account service.
- Submission preparation, submission, and transaction lookup live in a transaction service.
- Existing browser API and security behavior stay compatible.
- Fastify version stays exact in manifests and lockfiles.

## Non-goals

- No endpoint, payload, authentication, or authorization redesign.
- No new transaction search API beyond existing submission lookup by ID.
- No contract, signer, transaction-encoding, provider, or deployment change.
- No public-hosting support or relaxation of loopback restrictions.

## Constraints

- `apps/backend` remains browser write boundary.
- Preserve loopback, Host, exact Origin, CORS, cookie, CSRF, account-binding, body-size, no-store, error-sanitization, request-log, and reconciliation behavior.
- Preserve `server` and `close()` compatibility for existing callers.
- Pin `fastify@5.12.8` and update dependency review.

## Approaches

1. Wrap current monolith in Fastify. Small diff. Routes and services remain mixed. Rejected.
2. One shared Fastify kernel plus domain route modules and focused services. Selected. Clear ownership, one runtime dependency, preserved API.
3. Rewrite API with schemas and new endpoint names. Cleaner long-term contract. Rejected because compatibility and security regression risk are too high.

## Structure

- `src/http/fastify.ts`: Fastify construction, JSON bigint codec, request observation, common close/listen compatibility.
- `src/routes/account-*.ts`: multi-user health, auth, registration, vault, submission routes.
- `src/routes/legacy-*.ts`: historical single-vault routes.
- `src/services/account-service.ts`: account creation and session projection.
- `src/services/transaction-service.ts`: prepare, submit, and lookup orchestration.
- `src/account-server.ts`, `src/server.ts`: composition only.

## Acceptance

- Existing backend tests pass unchanged except tests that expose Fastify ownership.
- New tests prove `backend.fastify.server === backend.server`.
- New service tests prove account creation/session projection and account-scoped transaction lookup.
- Format, typecheck, backend suite, and repository checks report no migration regression.

