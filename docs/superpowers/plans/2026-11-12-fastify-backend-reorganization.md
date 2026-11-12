# Fastify Backend Reorganization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fastify owns both backend servers; routes and services gain focused folders without API behavior change.

**Architecture:** Shared Fastify kernel handles HTTP mechanics. Domain route modules call account and transaction services. Composition files retain old public server shape.

**Tech Stack:** TypeScript, Node.js 24, Fastify 5.12.8, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-12-fastify-backend-reorganization-design.md`

## Global Constraints

- Preserve all HTTP paths, payloads, status codes, headers, session checks, and fail-closed behavior.
- Keep loopback, exact Origin, Host, CSRF, account, and body-size enforcement.
- No signer, contract, encoding, provider, or deployment change.
- Pin exact dependency. Update lockfiles and dependency review.

## Review Focus

- Malformed JSON and oversized bodies retain 400/413 behavior.
- Unknown paths and query-bearing paths retain 404 behavior.
- Missing session, CSRF, or account binding retain 401/403 behavior.
- Request logging never records secret path, query, header, cookie, or body data.
- Server close drains receipt reconciliation before socket shutdown.

---

### Task 1: Fastify Kernel

**Files:**
- Modify: `apps/backend/package.json`
- Modify: `package-lock.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/backend/src/http/fastify.ts`
- Modify: `apps/backend/tests/backend-surface.test.ts`
- Modify: `packages/security-core/docs/security/dependency-review.md`

**Interfaces:**
- Produces: `createBackendFastify(options): FastifyInstance` with bigint JSON codec, 256 KiB limit, request IDs, and raw request observation.

- [x] **Step 1: Add failing Fastify ownership test**

Assert returned backend exposes `fastify`; assert `fastify.server === server`; use `fastify.inject()` for `/health`.

- [x] **Step 2: Run focused test**

Run: `npm --prefix apps/backend test -- --run tests/backend-surface.test.ts`
Expected: FAIL because Fastify surface is absent.

- [x] **Step 3: Pin Fastify and implement kernel**

Install exact `fastify@5.12.8`. Preserve bigint reviver/serializer, body limit, request IDs, no implicit logging, and request observer.

- [x] **Step 4: Run focused test**

Run: `npm --prefix apps/backend test -- --run tests/backend-surface.test.ts`
Expected: PASS.

### Task 2: Account and Transaction Services

**Files:**
- Create: `apps/backend/src/services/account-service.ts`
- Create: `apps/backend/src/services/transaction-service.ts`
- Create: `apps/backend/tests/services.test.ts`

**Interfaces:**
- Produces: `AccountService.setup()`, `AccountService.project(session)`, `TransactionService.prepare()`, `submit()`, and `find()`.
- Consumes: existing `AccountStore` and `AccountGateway` without authority expansion.

- [x] **Step 1: Add failing service tests**

Prove account setup returns one unprivileged session projection. Prove transaction lookup passes exact account and submission ID. Prove prepare/submit pass exact session ownership.

- [x] **Step 2: Run service tests**

Run: `npm --prefix apps/backend test -- --run tests/services.test.ts`
Expected: FAIL because service modules are absent.

- [x] **Step 3: Implement minimal services**

Move orchestration only. Keep persistence, WebAuthn verification, signing, and gateway authority in current owners.

- [x] **Step 4: Run service tests**

Run: `npm --prefix apps/backend test -- --run tests/services.test.ts`
Expected: PASS.

### Task 3: Domain Routes and Server Composition

**Files:**
- Create: `apps/backend/src/routes/account-auth.ts`
- Create: `apps/backend/src/routes/account-registrations.ts`
- Create: `apps/backend/src/routes/account-vaults.ts`
- Create: `apps/backend/src/routes/account-submissions.ts`
- Create: `apps/backend/src/routes/account-health.ts`
- Create: `apps/backend/src/routes/legacy.ts`
- Modify: `apps/backend/src/account-server.ts`
- Modify: `apps/backend/src/server.ts`
- Modify: `apps/backend/src/main.ts`
- Modify: `apps/backend/tests/account-server.test.ts`
- Modify: `apps/backend/tests/server.test.ts`

**Interfaces:**
- Consumes: Fastify kernel plus Task 2 services.
- Produces: existing `server` and `close()` API plus `fastify` instance.

- [x] **Step 1: Add failing route-boundary tests**

Use Fastify injection for health, account setup, unknown route, malformed JSON, transaction lookup, and close lifecycle.

- [x] **Step 2: Run focused HTTP tests**

Run: `npm --prefix apps/backend test -- --run tests/account-server.test.ts tests/server.test.ts`
Expected: FAIL until routes use Fastify and services.

- [x] **Step 3: Move routes and compose servers**

Keep route modules under `src/routes/`. Keep server files limited to dependency composition, error mapping, and lifecycle.

- [x] **Step 4: Run focused HTTP tests**

Run: `npm --prefix apps/backend test -- --run tests/account-server.test.ts tests/server.test.ts`
Expected: PASS.

### Task 4: Verification and Documentation

**Files:**
- Modify: `apps/backend/README.md`
- Modify: `docs/superpowers/plans/2026-11-12-fastify-backend-reorganization.md`

**Interfaces:**
- Consumes: completed Fastify migration.
- Produces: documented structure and checked plan.

- [ ] **Step 1: Document Fastify routes and services**

Describe folder ownership. State API and security boundary remain unchanged.

- [ ] **Step 2: Run full verification**

Run: `npm run backend:format && npm run backend:format:check && npm run backend:typecheck && npm run backend:test && npm run check && git diff --check`
Expected: all commands exit 0.

- [ ] **Step 3: Review diff**

Confirm no route, status, auth, signer, contract, encoding, provider, or deployment change.

- [ ] **Step 4: Commit and push**

Commit migration. Push `main` only after verification passes.

