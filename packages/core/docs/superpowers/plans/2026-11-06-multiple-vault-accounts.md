# Multi-User Local Vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Localhost multi-user signup; durable accounts; discoverable first-key login; exact action-specific signatures; no hardcoded account limit.

**Architecture:** SQLite account/session/challenge metadata; existing immutable journals retain execution authority. Account gateway composes existing per-vault services; global payer lease serializes all writes. Cookie sessions select accounts; Safe transaction signatures remain mandatory.

**Tech Stack:** Node 24.21.0 built-in `node:sqlite`, TypeScript, existing SimpleWebAuthn/viem, React, Vitest, existing real-Safe integration harness.

**Spec:** `packages/security-core/docs/superpowers/specs/2026-11-06-multiple-vault-accounts-design.md`

## Global Constraints

- Local app `http://localhost:5173`; RP `localhost`; backend browser origin `http://localhost:8787`; socket `127.0.0.1`.
- No hardcoded account-count limit. One asset-holding Safe per account.
- First passkey signs in. Second signer required only by selected action policy; both registered before deployment.
- Native token-denominated X/Y/Z, exact transaction digest, reviewed artifacts, six confirmations and existing authorization/outlay checks remain enforced.
- Secrets/config/database/journals outside repository. No private passkeys/assertions/approval payloads persisted or logged.
- No live transactions, mainnet, HTTPS ingress, new Solidity, WalletConnect or account abstraction.
- Existing accounts/evidence preserved. SQLite records never brand onchain verification.
- Native execution in existing checkout on `codex/multi-user-localhost`; original untracked approved spec preserved. No push/merge.

## Review Focus

- Two tabs change cookie account: stale requests reject; late replies cannot overwrite active identity. Task 4.
- Backend restart after durable hash: other users cannot consume payer nonce. Task 3.
- Cleared browser: discoverable login restores original account without local credential IDs. Tasks 2, 4.
- Synced credentials with zero counter: valid signatures succeed; replayed challenges fail. Task 2.
- Database/journal partial update: fail closed, preserve original execution evidence. Tasks 1, 3.

---

### Task 1: Durable Accounts and Session Store

**Files:** Create `apps/backend/src/account-store.ts`, `apps/backend/tests/account-store.test.ts`; modify `apps/backend/src/config.ts`.

**Interfaces:** `AccountStore(config)` owns external SQLite/path derivation. `createAccount()`, `account(id)`, `accounts()` iterator, `storeCredential(accountId, credential, userHandle?)`, `credential(id)`, `credentials(accountId)`, `updateCounter(id, previous, next)`, `createSession(accountId?, authenticated?)`, `session(token)`, `revokeSession(token)`, `createChallenge(sessionId,purpose,role?)`, `consumeChallenge(sessionId,id,purpose,role?)`, `claimSubmission(accountId,id,sessionId)`, `assertSubmissionOwner(accountId,id,sessionId)`, `markProvisioning(accountId,state)`, `adoptLegacy()`, `close()`.

- [x] Write failing storage/reopen/isolation tests; 130 accounts; duplicate role/key/credential; token hashing, expiry, replay, counter compare/update, path traversal and schema mismatch.
- [x] Run `npm run backend:test -- tests/account-store.test.ts`; observe missing implementation.
- [x] Implement transactions, versioned schema, stable account/user handles, bounded SQL iteration, restrictive files; Node built-in SQLite, no npm dependency.
- [x] Run focused test and `npm run backend:typecheck`.

### Task 2: Discoverable Authentication and Scoped HTTP

**Files:** Create `apps/backend/src/account-server.ts`, `apps/backend/tests/account-server.test.ts`; modify `apps/backend/src/webauthn.ts`, `apps/backend/tests/webauthn.test.ts`.

**Interfaces:** `verifyPasskeyLogin({credential,response,challenge,rpId,origin,userHandle?})`; `createAccountServer(config,store,gateway)` returns `{server,close}`. Gateway supplies `handlers(accountId,sessionId)`, `provision(accountId)`, `submit(accountId,sessionId,id,body)`, `status(accountId,id)`.

- [x] Write failing real-ES256 tests for first-only login, unknown/second-only credentials, wrong origin/RP/handle, zero counters, replay, expired/fixed sessions and CSRF.
- [x] Run `npm run backend:test -- tests/account-server.test.ts tests/webauthn.test.ts`; observe expected failures.
- [x] Implement closed auth/session/logout/signup routes and existing account routes; cookie verifier, session-bound CSRF, exact Host/Origin/CORS, limits while streaming bodies, redacted diagnostics. First signup discoverable; legacy verifier defaults retained for historical harness only.
- [x] Run tests and backend typecheck.

### Task 3: Account Runtime and Shared Payer

**Files:** Create `apps/backend/src/account-runtime.ts`, `apps/backend/tests/account-runtime.test.ts`; modify `apps/backend/src/handlers.ts`, `apps/backend/src/main.ts`, `apps/backend/tests/handlers.test.ts`, existing configured-runtime harness tests.

**Interfaces:** `createAccountGateway(config,store)` implements Task 2 gateway using per-account verified provisioner, handlers and submission runtime. Authenticated metadata alone never issues verification; recover existing exact plans first. `withPayer` holds external global lease and durably tracks active work; scan registered source journals before signing. `createConfiguredBackend()` serves account server by default; singleton HTTP exists only in explicitly test-gated harness.

- [x] Write failing first-only base/status tests and cross-account/session/idempotency/payer/restart tests.
- [x] Run `npm run backend:test -- tests/handlers.test.ts tests/account-runtime.test.ts`; observe expected failures.
- [x] Replace blanket second-key readiness with explicit option for authenticated account composition; preserve exact role-key checks and fresh approvals. Persist counter updates. Compose verified account services, legacy adoption, serialized nonce planning and unresolved hash gating. Status never signs.
- [x] Run complete backend tests/typecheck and real-crypto HTTP integration; preserve existing harness gates.

### Task 4: Browser Sign-In and Account Lifecycle

**Files:** Modify `apps/app/src/lib/vault-store.tsx`, `apps/app/src/lib/webauthn-passkey.ts`, `apps/app/src/lib/environment-profile.ts`, `apps/app/src/routes/onboarding.tsx`, `apps/app/src/routes/profile.tsx`; add/update focused tests.

**Interfaces:** `VaultBackend` adds `session()`, `signIn()`, `signOut()`, `createAccount()`; server session returns account ID, credential references, provisioning state and verified public vault when available. Default backend sends cookie/CSRF/account headers. `VaultProvider` restores server session, signs in, clears prior state on logout/new account; `signSafeDigest` retains exact digest binding.

- [x] Write failing discoverable/cleared-storage/login/logout/two-browser/stale-response tests; first-only base with absent second verification.
- [x] Run `npm run app:test -- src/lib/webauthn-passkey.test.ts src/lib/vault-store.test.tsx src/routes/-onboarding.test.tsx`; observe expected failures.
- [x] Implement first-key discoverable flow, automatic primary auth after registration, authoritative server hydration, account-keyed public storage, first-only readiness, action-specific approvals, visible sign-in/logout/create actions. Keep provider injection seams for existing tests.
- [x] Run app tests/build/lint on changed files; reject environment/cookie hostname mismatch.

### Task 5: Documentation and Integration Gates

**Files:** Update approved recovery/provider/call-graph/dependency docs, `apps/backend/README.md`, `apps/app/README.md`, env examples and this plan.

- [x] Amend blanket recovered-role gate explicitly; document local session/cookie/SQLite configuration, migration and no live gate claims.
- [x] Run `npm run backend:test`, `npm run backend:typecheck`, `npm run app:test`, `npm run app:build`, nearest security-core provisioning/signature/transport tests and `git diff --check`.
- [x] Fresh whole-change review; fix material findings with regression tests. Record exact results and remaining real-device/live limits.
- [x] Leave complete reviewed changes on task branch for user review; no deployment/push/merge.


## Verification Record — 2026-11-06

- Backend: 144 passing; `npm run backend:typecheck` passed.
- App: 191 passing; production build and TypeScript check passed. Changed-file lint: zero errors; 14 existing mixed-export warnings.
- Security core: 845 passing; 2 existing deferred production-composition tests pending. Full root `npm test` also passed before the final account-recovery metadata addition; the affected backend/app suites passed again afterward.
- Real local proof: A/B/C, 21 genuine deployment transactions, backup-eligible zero-counter first credentials, restart/browser reset, first-only login/base spending, exact step-up second approval and cross-user rejection.
- Review: five findings fixed; scoped follow-ups clear, including own-account recovery IDs. Missing registry/evidence inventory and normalized durable approval replay regression added.
- No live deployment/transfer/ingress, push, merge, independent notification or real-provider/mobile gate claimed. Changes retained for review on `codex/multi-user-localhost`.

## Vivaldi Follow-up — 2026-11-06

- [x] Reproduce connection refusal and failed backend startup; retain external evidence.
- [x] Prove dead authorization-lock recovery and live/unknown-lock rejection; reuse existing safe lease.
- [x] Restore completed account without authorization writer; real local three-account regression.
- [x] Prove overlapping session-read race and stale-focus cleanup; preserve current-session failure handling.
- [x] Prove fresh-account action exits unfinished anonymous context; preserve its account/credentials.
- [x] Preserve first credential's provider transport hints; label same-key verification clearly.
- [x] Complete user-assisted Vivaldi signer/setup verification; seven successful Sepolia deployments, same Safe restored after backend restart; safety acknowledgements and other-device sync remain untested.
- [x] Stop test backend; verify no port 8787 listener and `/health` connection refused.

## Main Integration Request — 2026-11-06

User explicitly authorized committing all work and pushing to `main`, superseding the earlier retain-for-review instruction.

- [x] Fresh root `npm test`: security core 847 passed / 2 existing pending; backend 149 passed; app 200 passed; landing no tests, successful configured exit.
- [x] Root production build, backend/app TypeScript, staged-scope whitespace checks and changed-app-file lint; zero lint errors, 15 existing mixed-export warnings.
- [x] Final whole-change read-only review: no actionable material findings.
- [x] Check 57 changed/new files against configured relay/RPC secrets; zero matches. Local `.env` and diagnostic artifacts remain ignored.
- Integration target: existing `main`, preserving published history. No mainnet or additional live security gate claimed. Automatic receipt refresh remains open.
