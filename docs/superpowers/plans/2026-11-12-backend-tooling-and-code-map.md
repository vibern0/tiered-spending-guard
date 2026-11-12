# Backend Tooling and Code Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Backend tabs, explicit dotenv loading, applied ESLint, complete Swagger, whole-repository file guide and diagrams.

**Architecture:** Keep existing Fastify routes and account security. Serve documentation-only OpenAPI for account and legacy compositions; preserve runtime validation/serialization. Load external environment before CLI configuration; shell values win.

**Tech Stack:** Node 24, TypeScript, pnpm, Prettier, ESLint, dotenv, Fastify Swagger/UI, Vitest, Mermaid.

**Spec:** User request, 2026-11-12; formatting/linting scope: backend only.

## Global Constraints

- `apps/backend` remains the loopback browser write boundary.
- Keep secrets/config outside repository; permit existing `.env` symlink to external file.
- Pin exact added dependency versions; update `pnpm-lock.yaml` and dependency review.
- No contracts, transaction encoding, signer semantics, topology or live gates changed.
- Swagger inherits existing loopback/Host/Origin/no-store checks; no write console.
- No relocation yet; document current structure and rework candidates.

## Review Focus

- Environment loading independent of working directory; shell precedence; missing files and read errors.
- No private environment values in diagnostics or generated API documentation.
- Both HTTP compositions fully documented; no invented legacy auth requirements.
- Documentation/assets cannot bypass loopback, Host or Origin checks.
- Lint fixes preserve execution behavior; full backend and workspace tests.

---

### Task 1: Environment loading

**Files:** `apps/backend/src/environment.ts`, `apps/backend/src/main.ts`, `apps/backend/tests/environment.test.ts`, `apps/backend/tests/backend-surface.test.ts`, backend manifest, lockfile.

**Interfaces:** `loadBackendEnvironment(env = process.env): void`; optional external `DOTENV_CONFIG_PATH`; default module-relative `.env` symlink.

- [x] Write/run failing tests: external file, shell precedence, cwd independence, absent default, explicit missing/unreadable/repository file, sanitized failure.
- [x] Add exact dotenv dependency; load before CLI `loadBackendConfig()`; remove Node `--env-file` flag.
- [x] Run `pnpm --filter @tiered-spending-guard/backend test -- tests/environment.test.ts tests/backend-surface.test.ts`.

### Task 2: Swagger documentation

**Files:** `apps/backend/src/http/openapi.ts`, `apps/backend/src/http/documentation.ts`, both server compositions, `apps/backend/tests/documentation.test.ts`.

**Interfaces:** `registerBackendDocumentation(fastify, surface)`; separate account/legacy specifications.

- [x] Write/run failing HTTP tests: spec, UI/assets, all route coverage, request/response schemas, boundary denial, no side effects.
- [x] Add exact Fastify Swagger/UI dependencies. Document every registered endpoint, fields, errors, auth, bigint wire encoding, readiness and legacy-only rebind.
- [x] Run `pnpm --filter @tiered-spending-guard/backend test -- tests/documentation.test.ts`.
- [x] Update security call graph for read-only documentation paths.

### Task 3: Backend format and lint

**Files:** backend Prettier/ESLint/editor config, manifest, root scripts, backend sources/tests/scripts.

**Interfaces:** `backend:lint`, `backend:lint:fix`; `check` includes lint.

- [x] Set `useTabs: true`, `tabWidth: 4`; pin lint dependencies.
- [x] Apply lint fixes, then formatting. Fix remaining errors without weakening security checks.
- [x] Run `pnpm backend:lint`, `pnpm backend:format:check`, `pnpm backend:typecheck`, `pnpm backend:test`.

### Task 4: Codebase guide and final verification

**Files:** `docs/codebase-map.md`, `docs/file-guide.md`, backend README, dependency review.

- [x] Inventory every tracked file; explain source responsibilities, tests, configs, evidence and generated assets.
- [x] Draw workspace/dependency and backend request/execution diagrams; identify concrete reorganization candidates.
- [x] Record dependency provenance, limits and documentation boundaries.
- [x] Run `pnpm test`, `git diff --check`; inspect semantic diff separately from formatting.

## Execution Notes

- Local `main` already current after `git pull --ff-only`; work branch `codex/backend-tooling-code-map`.
- Existing private `.env` symlink observed; contents not read or printed.
- Repository supplies pnpm workspace dependencies and `workspace:*`; pnpm lockfile is authoritative for this change. Retain historical npm/yarn lockfiles pending explicit cleanup.

## Verification Record

- Focused environment + entrypoint + Swagger checks: 21 passed.
- Full backend suite: 233 passed; security-core: 853 passed; wallet app: 229 passed; landing has no test files and exits successfully.
- Backend lint, format check and typecheck pass; `git diff --check` passes.
- Whole-change source review: no Important/Critical findings. Corrected documentation to include accepted canonical unsuffixed integer inputs.
- Initial HTTP test failures exposed raw Node listen bypassing asynchronous Fastify boot. Fixtures now use `fastify.listen`, matching the CLI lifecycle.
- Initial frontend failures did not reproduce in an original-main archive with its original lockfile. Full workspace `pnpm install --frozen-lockfile --offline` repaired the local install; all 229 frontend tests then passed without frontend source changes.
- Registry audit: no advisory paths through newly added dotenv/Swagger dependencies; existing workspace findings remain documented in dependency review. No live transactions or gate changes.
- No commit or push performed; changes remain reviewable on `codex/backend-tooling-code-map`.

- Final root `pnpm check`: PASS (security-core compile + 853 tests; backend lint/format + 233 tests + typecheck; wallet 229 tests; landing no-tests success).
- AST structure comparison of existing TypeScript changes confirmed semantic edits are limited to intended startup/documentation registration, unused binding/type cleanup and test fixture lifecycle/unused-argument changes; remaining edits are formatting/comments.

### Task 5: Explicit CLI entrypoints and native Fastify logging (user follow-up)

**Files:** backend `src/index.ts`, `src/main.ts`, `src/logging.ts`, `src/http/fastify.ts`, both server compositions, receipt worker, profiler implementation/CLI, logger/entrypoint tests, manifest/lockfile and current structure/security docs.

**Interfaces:** native `BackendServerOptions.logger?: FastifyBaseLogger`; `createBackendLogger({ pretty?, level?, stream? })`; side-effect-free imported server/profiler implementations; executable CLI modules.

- [x] Capture failing native logging and explicit CLI tests before implementation.
- [x] Remove execution-detection guards from both commands; isolate executable CLI code.
- [x] Enable native Fastify/Pino lifecycle logging and request/server loggers; keep allowlisted serializers, private-field exclusion, generated correlation and one disconnect warning.
- [x] Pin existing transitive `pino@10.4.0` directly; add development-only `pino-pretty@13.2.0`; re-audit new dependency paths.
- [x] Update tests to inspect real native records and test readable development output, production JSON, import safety and profiler help.
- [x] Update file guide (693 files), diagrams, README, dependency record and call graph.
- [x] Verify backend lint, typecheck, formatting and full 238-test suite. Review native logging privacy/entrypoint changes independently before reporting completion.

The original custom console event writer and startup/ready/request observer wrappers are removed. Safe diagnostics remain code/stage fields on native request logs. No signer, transaction, custody or independent-alert behavior changes.

- Native logging review reproduced an implicit Pino error-message privacy leak. Added red/green regression and a narrow native hook; native logging tests now cover both implicit error call forms and explicit safe diagnostics.
