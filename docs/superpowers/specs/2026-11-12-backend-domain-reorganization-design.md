# Backend Domain Reorganization Design

User approved this structure in chat on 2026-11-12 and requested implementation, commit and push.

## Intent

Expose ownership: process startup, HTTP boundary, accounts, authentication, vault readiness, provisioning, submissions, chain adapters and scheduled observation. Preserve existing behavior.

## Approaches

- Selected: feature folders plus narrow shared HTTP/chain adapters. Extract real workflows; keep SQLite atomic operations together.
- Rejected: more controller/service/repository forwarding layers. Existing transaction facade adds no behavior.
- Rejected: folder moves alone. Large mixed provisioning/submission modules need responsibility extraction.

## Boundaries

- `index.ts`: executable startup. `app.ts`: import-safe composition/lifecycle.
- `http/`: Fastify, security context, safe errors, health and documentation assembly.
- `accounts/`: account projection, SQLite metadata, runtime cache and application contracts.
- `auth/`: registration/login workflows, exact WebAuthn verification and signature parsing.
- `vaults/`: current verified vault, credential readiness and provisioning orchestration.
- `provisioning/`: immutable deployment workflow, restart recovery and successor lineage.
- `submissions/`: closed preparation, approval/state lifecycle, bounded execution, receipt reconciliation, durable journal and observation evidence.
- `chain/`: approved provider reads, relay adapter, strict batching and one payer-wide coordinator.
- `jobs/`: receipt scheduling and drain-on-shutdown.
- `compatibility/`: preserved singleton test and restricted HTTPS composition/challenges.
- Feature documentation sits with feature ownership; OpenAPI assembly remains documentation-only.

## Preserved Properties

Keep `apps/backend` as the loopback browser write boundary. Preserve HTTP endpoints, cookies, CSRF, Origin/Host checks, account/session ownership, exact approval sequencing and digest binding. Preserve one shared payer lease across all accounts, unresolved-work blocking, durable-hash-before-broadcast, independent evidence validation and six-confirmation reconciliation. Preserve SQLite transaction atomicity for credential counters/replay fingerprints. Journals remain authoritative for execution evidence. Historical profiles stay read-only. No new dependencies, contracts, policy, signer semantics, browser write paths or live/audit gate changes.

## Delivery

Move shared contracts out of HTTP/bootstrap modules first. Extract adapters and workflows behind existing capabilities. Retain current exported function names where harmless; responsibilities and dependency direction take priority over cosmetic API renames. Existing adversarial/actual-Safe suites bracket the refactor. Add focused ownership tests only where a new extraction exposes an untested boundary. Update structure/file guides, call graph and source-path-based verification. Commit reviewed tooling baseline and refactor separately, then push the current branch without rewriting history.
