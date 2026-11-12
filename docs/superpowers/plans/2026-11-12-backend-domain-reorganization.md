# Backend Domain Reorganization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Implement approved backend ownership; verify, commit, push.

**Architecture:** Feature folders own workflows. Shared HTTP/chain adapters stay narrow. Index starts; app composes. SQLite atomicity and shared payer coordination remain intact.

**Tech Stack:** Existing TypeScript, Fastify/Pino, viem, SQLite, Vitest, pnpm. No dependencies added.

**Spec:** `docs/superpowers/specs/2026-11-12-backend-domain-reorganization-design.md`

## Global Constraints

- Keep `apps/backend` as the loopback browser write boundary.
- Preserve endpoints, failures, security checks, approval order and exact transaction binding.
- Preserve one payer-wide lease and unresolved-work gate across all accounts.
- Preserve durable-hash-before-broadcast, canonical independent evidence, six confirmations and historical read-only behavior.
- Preserve SQLite counter/replay-fingerprint atomicity. Journals remain execution evidence authority.
- No contracts, dependencies, signer semantics, browser paths or live/audit gate changes.
- Reuse current branch; preserve previous authorized tooling changes. Commit/push requested; no force push or main merge.

## Review Focus

- Account and session cannot cross prepared approval attempts; logout still revokes retained approvals.
- Payer lease cannot become account-local; any uncertain durable hash blocks other signatures.
- Deployment recovery remains distinct from signing and fresh provisioning.
- Read adapters cannot gain private relay/signing authority.
- Import-safe modules cannot execute CLI behavior; relocated environment/path/artifact resolution stays correct.

---

### Task 1: Establish baseline and domain paths

**Files:** backend `src/` ownership moves; tests/scripts imports; shared `accounts/types.ts`, `vaults/types.ts`, `submissions/types.ts`, `http/types.ts`, `http/errors.ts`.

**Interfaces:** Keep `createConfiguredBackend`, `createAccountServer`, `createBackendServer`, `createBackendHandlers`, `createConfiguredSubmissionRuntime` and existing test seams. Move `AccountGateway` out of server; move `ConfiguredSubmissionRuntime` out of bootstrap.

- [x] Run `pnpm check`; expect all existing gates green.
- [x] Commit authorized tooling/native logging baseline separately.
- [x] Move files into approved folders; rewrite relative imports and literal source references.
- [x] Preserve module-relative paths in `config/config.ts`, `config/environment.ts` and source hashes.
- [x] Run backend typecheck and focused entrypoint/config/HTTP tests; expect green.

### Task 2: Authentication workflow ownership

**Files:** `auth/routes.ts`, `auth/registration-routes.ts`, new `auth/service.ts`, `http/security.ts`, account contracts; auth/account HTTP regressions.

**Interfaces:** Routes retain exported registration functions. Auth service consumes config, account store, gateway and account projection; accepts explicit session/account context, never Fastify request/reply. Return cookie/session actions for routes to apply.

- [x] Read existing login/registration/CSRF/replay tests; keep assertions.
- [x] Extract setup/login/logout/registration workflow from HTTP handlers without reordering consumed challenge, counter update, active-session check or cookie rotation.
- [x] Keep exact HTTP validation/error mapping; routes only adapt input/context/results.
- [x] Run account-server, WebAuthn, account-store and multi-user HTTP tests; expect green.

### Task 3: Submission workflow ownership

**Files:** `submissions/service.ts`, `types.ts`, `prepare.ts`, `execute.ts`, `reconcile.ts`, `runtime.ts`, `journal.ts`, `observations.ts`, `compatibility/submission.ts`; submission tests.

**Interfaces:** Preserve `PwaSubmissionService`, `createConfiguredSubmissionRuntime`, `createSubmissionRuntimeForTestsOnly` and existing capability signatures. Runtime composes extracted preparation, signing/broadcast and receipt observation functions. Legacy `SafeSubmissionService` and `prepareUsdcTransfer` move to compatibility.

- [x] Read approval, exact-hash, uncertainty, rollback and real-Safe regressions before extraction.
- [x] Extract canonical preparation, private envelope execution and canonical receipt/observation responsibilities with explicit shared context; no global state or capability broadening.
- [x] Keep durable submission lifecycle in service; remove trivial transaction forwarding layer once routes consume gateway contract directly.
- [x] Run submission/journal/observation and actual Safe HTTP integration tests; expect green.

### Task 4: Provisioning, shared chain adapters and payer coordination

**Files:** `provisioning/service.ts`, `recovery.ts`, `successors.ts`; `chain/read-client.ts`, `relay-client.ts`, `payer-coordinator.ts`, `accounts/runtime.ts`; `vaults/service.ts`; relevant tests.

**Interfaces:** Keep existing reader/relay/provisioner exports. `createPayerCoordinator` owns one shared queue/lease and reads every account's authoritative journals before invoking operation. Runtime owns account cache/session ownership only.

- [x] Extract shared RPC adapters from provisioning; update submissions/profiler imports.
- [x] Extract payer lease/unresolved-work checks unchanged; add focused regressions if current account-runtime suite leaves an exposed boundary untested.
- [x] Separate vault readiness/credential approval responsibilities where currently mixed; preserve exact existing verification sequence.
- [x] Run provisioning/recovery/RPC/account-runtime and real-Safe HTTP suites; expect green.

### Task 5: Documentation ownership, broad verification and delivery

**Files:** feature `schemas.ts` files, `http/openapi.ts` assembly, README, codebase/file guides, security call graph, plan progress.

**Interfaces:** `createBackendOpenApi(surface)` preserves document contracts; schemas stay documentation-only. No runtime validation migration.

- [x] Split schema definitions/operation catalogs along feature boundaries; retain route-completeness/privacy tests.
- [x] Update responsibility guide and diagrams to actual final tree; verify every local target.
- [x] Run `pnpm check`, `git diff --check`; expect green. Compare semantic changes separately from moves/formatting.
- [x] Independent full diff review; address blocking findings with regression proof.
- [x] Commit domain refactor; push `codex/backend-tooling-code-map`; verify remote head and clean worktree.

## Execution Record

- Tooling/native logging baseline committed as `976e2d0`; no earlier authorized work discarded.
- Baseline security-core 853/backend 238 tests green. Initial frontend baseline hit existing local install issue; pinned workspace refresh restored all 229 wallet tests before structural edits.
- Task 1: 30 module moves, owning contracts and external-path anchors; focused 36 tests, lint/typecheck passed.
- Task 2: auth/account/credential suites and genuine-crypto service regressions passed; actual multi-user HTTP test passed.
- Task 3: 65 focused tests passed twice, including actual-contract submission integration; canonical executable statement comparison preserved preparation, signing, broadcast and lifecycle ordering.
- Task 4: shared payer/lease/journal checks extracted unchanged; 36 focused runtime/provisioning/RPC/handler tests passed. Full backend after composition: 240 passed.
- OpenAPI objects: account and legacy deep equality against baseline, without schema-validation migration.
- Independent review found one nested environment default resolving the current private symlink target. Corrected to backend-relative `../../.env`; added real-default selection test without private reads. Wrong-fixed-target mutation fails that regression; all seven environment tests pass. No remaining Important/Critical findings.
- One forwarding-only transaction facade and its mirror unit test removed; actual HTTP/runtime cross-account/session coverage retained. Three real-crypto auth service tests and one default-path regression added; final backend total is 241 tests.
- Current guide covers 720 actual files; historical deleted paths excluded. No dependencies, contracts, transaction encoding, signer policy, live writes or gates changed.

- Final `pnpm check`: PASS (security-core compile + 853 tests; backend lint/format/typecheck + 241 tests; wallet 229 tests; landing no-test success). Independent review: no remaining Important/Critical findings. `git diff --check` and all 720 file-guide targets pass.
