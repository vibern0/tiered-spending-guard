# EURC Wallet Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the local demo bridge to `apps/backend`, make its loopback HTTP backend runnable and server-authoritative, wire the app to it, and document/test the exact contract.

**Architecture:** Move the tested bridge modules without widening custody authority. Add a thin `main` entrypoint, validated config, handler composition, server-held credential/vault state, and chain-backed provisioning/submission adapters. Keep Safe, guard, Delay, and chain state authoritative; backend relay pays gas only.

**Tech Stack:** Node.js `node:http`, TypeScript, Vitest, viem `2.56.7`, `@simplewebauthn/server` `14.0.3`, existing TanStack/React app.

**Spec:** `packages/security-core/docs/superpowers/specs/2026-10-16-eurc-wallet-backend-design.md`

## Global Constraints

- Sepolia (`chainId = 11155111`) only.
- Bind the server to `127.0.0.1` and accept only the configured localhost app origin.
- Keep the funded relay account as a gas/deployment payer only.
- No WalletConnect, hosted auth, cloud database, arbitrary token calls, mainnet, or production claims.
- Fail closed when reviewed deployment evidence, runtime bytecode, topology, Safe nonce, EURC metadata, or policy state cannot be verified.
- Browser-provided Safe, guard, EURC, nonce, spend, and policy values are advisory inputs only.
- `apps/backend/README.md` is the canonical endpoint contract.
- Update `packages/security-core/docs/security/call-graph.md` for new execution paths and `dependency-review.md` for dependency/protocol changes.

## Review Focus

- Non-loopback request, wrong Origin, malformed body, unknown route, or missing readiness config returns a bounded error and never writes.
- Browser-supplied vault addresses, hashes, nonce, spend, or policy cannot replace server-held vault state or fresh chain reads.
- Duplicate registration/submission and uncertain broadcast reconcile against the journal before any retry.
- Valid signatures over another Safe, chain, digest, credential, or role are rejected before relay.
- App/backend outage, unhealthy readiness, and policy denial remain visible and never look like local success.

---

### Task 1: Rename Bridge Surface And Preserve Tested Behavior

**Files:**
- Rename: `apps/demo-bridge` -> `apps/backend`
- Rename/modify: `apps/backend/src/{config,journal,server,session,vault,webauthn}.ts`
- Rename/modify: `apps/backend/tests/*.test.ts`
- Create: `apps/backend/README.md`
- Modify: `.gitignore`, `apps/backend/package.json`, `packages/security-core/docs/superpowers/plans/2026-10-15-eurc-passkey-wallet-demo.md`

**Interfaces:**
- Produces: `BackendConfig`, `BackendHandlers`, `BackendServer`, `createBackendServer`, and unchanged exact-transfer/submission interfaces.
- Keeps: endpoint paths and security behavior from the existing bridge while public names become backend names.

- [x] **Step 1: Write failing rename/API tests**

Add imports and assertions against `apps/backend` names. Assert old `apps/demo-bridge` paths and `Bridge*` exports are absent from active code.

- [x] **Step 2: Run tests to verify they fail**

Run: `npm --prefix apps/backend test`

Expected: FAIL because the backend directory and public names do not exist.

- [x] **Step 3: Move modules and rename public symbols**

Use `git mv`; preserve exact calldata, Safe digest, role ordering, loopback/origin checks, journal semantics, and no WalletConnect boundary. Update env names to `BACKEND_*`.

- [x] **Step 4: Add canonical backend README**

Document setup, loopback/origin boundary, secrets outside the repository, endpoint request/response/error shapes, readiness, and testnet-only limits.

- [x] **Step 5: Run backend tests**

Run: `npm --prefix apps/backend test`

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add apps/backend apps/demo-bridge .gitignore packages/security-core/docs/superpowers/plans/2026-10-15-eurc-passkey-wallet-demo.md
git commit -m "refactor: rename demo bridge to backend"
```

### Task 2: Add Runnable Entrypoint And Server-Authoritative Handlers

**Files:**
- Create: `apps/backend/src/main.ts`
- Create: `apps/backend/src/handlers.ts`
- Create: `apps/backend/src/provisioner.ts`
- Modify: `apps/backend/src/{config,server,session,vault,journal}.ts`
- Create: `apps/backend/tests/{server,handlers,config}.test.ts`

**Interfaces:**
- Consumes: reviewed deployment evidence, local secret config, server-held registration/vault records, authoritative chain adapter.
- Produces: `createBackendHandlers`, `startBackend`, `GET /health`, server-authoritative `/v1/vaults`, `/v1/submissions/prepare`, `/v1/submissions/{id}/submit`, and `/v1/submissions/{id}`.

- [x] **Step 1: Write failing handler/server tests**

Cover health response, origin/loopback rejection, malformed JSON, unknown routes, duplicate sessions, server-held vault binding, ignored client deployment fields, exact digest binding, duplicate IDs, role ordering, uncertain broadcast reconciliation, and receipt-confirmed/reverted status.

- [x] **Step 2: Run focused tests to verify failure**

Run: `npm --prefix apps/backend test -- server.test.ts handlers.test.ts config.test.ts`

Expected: FAIL because the entrypoint, handlers, readiness, and server-held state do not exist.

- [x] **Step 3: Implement validated config and readiness**

Require `BACKEND_RELAY_PRIVATE_KEY`, `BACKEND_RPC_URL`, `BACKEND_JOURNAL_PATH`, reviewed artifact config, exact chain/origin, and a non-repository journal path. Refuse startup on missing/invalid values. Add `GET /health` without secrets.

- [x] **Step 4: Implement server-held records and handlers**

Store verified credential metadata and the provisioned vault record on the backend boundary. Ignore browser addresses/hashes; use the record plus chain adapter for preparation. Re-read nonce, EURC metadata, topology, policy, and receipt state before writes. Return bounded JSON errors with `no-store`.

- [x] **Step 5: Implement `main.ts`**

Load config, construct reviewed provisioner/chain adapters, start only on `127.0.0.1`, and fail startup before listening when readiness validation fails. Never log secrets or credential material.

- [x] **Step 6: Run focused tests**

Run: `npm --prefix apps/backend test -- server.test.ts handlers.test.ts config.test.ts`

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add apps/backend
git commit -m "feat: add authoritative backend handlers"
```

### Task 3: Wire Browser App To Backend Contract

**Files:**
- Modify: `apps/app/src/lib/vault-store.tsx`
- Modify: `apps/app/src/lib/provisioning-errors.ts`
- Modify: `apps/app/src/lib/provisioning-errors.test.ts`
- Modify: `apps/app/src/lib/vault-store.test.tsx`, `apps/app/src/lib/webauthn-passkey.test.ts`
- Modify: `apps/app/src/routes/{index,onboarding,send}.tsx`
- Modify: `apps/app/package.json`, `apps/app/README.md`

**Interfaces:**
- Consumes: backend `/health`, registration, provisioning, preparation, submit, and status endpoints.
- Produces: `VITE_BACKEND_ORIGIN` configuration and visible backend-unavailable/unhealthy/error states with no simulated success.

- [x] **Step 1: Write failing app contract tests**

Assert the client uses `VITE_BACKEND_ORIGIN`, checks `/health`, preserves server error bodies/statuses, and renders actionable backend-unavailable/backend-error setup state.

- [x] **Step 2: Run focused tests to verify failure**

Run: `npm --prefix apps/app test -- provisioning-errors.test.ts vault-store.test.tsx`

Expected: FAIL because the app still uses demo-bridge naming and does not check backend readiness.

- [x] **Step 3: Implement backend client wiring**

Rename env/error copy, add health check before provisioning/submission, retain chain-derived state as authority, and do not persist secrets/assertions/relay credentials. Keep exact request unchanged through signing and submission.

- [x] **Step 4: Update UI failure states and docs**

Show backend unavailable/unhealthy, passkey cancellation, stale chain, and policy denial distinctly; never render local simulated confirmation. Document `VITE_BACKEND_ORIGIN`.

- [x] **Step 5: Run focused app tests and build**

Run: `npm --prefix apps/app test -- provisioning-errors.test.ts vault-store.test.tsx && npm --prefix apps/app run build`

Expected: PASS and successful build.

- [x] **Step 6: Commit**

```bash
git add apps/app
git commit -m "feat: wire app to local wallet backend"
```

### Task 4: Update Security Call Graph, Dependency Review, And Evidence References

**Files:**
- Modify: `packages/security-core/docs/security/call-graph.md`
- Modify: `packages/security-core/docs/security/dependency-review.md`
- Modify: `packages/security-core/docs/evidence/2026-10-15-eurc-wallet-demo.md`
- Modify: `packages/security-core/docs/superpowers/specs/2026-10-16-eurc-wallet-backend-design.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: final backend endpoint names, trust boundaries, dependency versions, and test commands.
- Produces: docs aligned with active code; no claim of production readiness or live execution.

- [x] **Step 1: Write documentation consistency checks**

Use repository searches/tests to assert no active `demo-bridge`/`DEMO_BRIDGE` references remain except historical evidence explicitly labeled as such, and that backend endpoints/entrypoint are documented.

- [x] **Step 2: Update docs and local instructions**

Record backend as the required loopback boundary, exact dependency evidence, no-WalletConnect rule, call paths, and testnet limitations. Mark the design status implemented locally while preserving non-production language.

- [x] **Step 3: Run documentation/security checks**

Run: `npm --prefix packages/security-core run security:check`

Expected: PASS with no unreviewed dependency or call-graph drift.

- [x] **Step 4: Commit**

```bash
git add AGENTS.md packages/security-core/docs
git commit -m "docs: record wallet backend trust boundary"
```

### Task 5: Full Verification And PR Integration

**Files:**
- Modify: plan checkboxes and execution ledger only as evidence requires.

- [x] **Step 1: Run full acceptance gates**

Run: `npm --prefix apps/backend test && npm --prefix apps/app test && npm --prefix apps/app run build && npm --prefix packages/security-core run security:check && npm test`

Expected: all commands exit 0; record exact counts and any known baseline warnings.

- [x] **Step 2: Run fresh review**

Review the complete diff against the spec, with special focus on server authority, exact digest binding, loopback/origin isolation, journal uncertainty, and app failure states. Fix Important/Critical findings with RED→GREEN tests.

- [ ] **Step 3: Push and open PR**

```bash
git push -u origin codex/eurc-wallet-backend
```

Open a PR against `main` with security scope, tests, non-production/testnet limitation, and no-live-secret statement.

- [ ] **Step 4: Wait for all PR checks**

Inspect CI status and review output; do not merge while any required check is pending or red.

- [ ] **Step 5: Merge PR if all green**

Merge through the repository’s GitHub integration only after required checks are green and the PR is approved/mergeable. Keep the worktree until merge state is verified.
