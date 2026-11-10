# Local Verification Profiling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add runnable local profiling; separate CPU work, RPC requests and wall time.

**Architecture:** Diagnostic process only. Read completed external public deployment evidence; use both approved independent readers; restore a read-only verified context; profile repeated real security-core verification. Export summary, Perfetto-compatible trace and V8 CPU profile outside repository. No production runtime instrumentation or dependency change.

**Tech Stack:** Existing TypeScript/tsx, Node inspector/performance/fetch, existing verification clients.

**Spec:** User requests tool profiling for real latency measurement; this plan defines the narrow diagnostic scope.

## Global Constraints

- Never sign, authorize, broadcast, provision, reconcile/persist source journals or request passkey interaction.
- Require all seven deployment receipts successful. Refuse incomplete evidence before network.
- Default fixed public Sepolia pair; explicit named archive access added by [archive evidence plan](2026-11-10-archive-evidence-access.md). Reject arbitrary readers and every non-read RPC method before fetch.
- Trace closed labels, counts, timings and HTTP statuses only; no addresses, calldata, assertions, credentials, endpoints, headers or error messages.
- Output new external directory only. Preserve input files. CPU profile contains function/source locations, never heap values.
- Explain that verification-only latency excludes passkey interaction, broadcast and confirmation.

## Review Focus

- Malformed/incomplete evidence: no network, signer or write capability.
- Unknown endpoint or RPC write/sign method: reject before fetch.
- Provider error: fail closed; retain redacted diagnostic artifacts; restore fetch/profiler lifecycle.
- Stream cancellation/abort: close timing and preserve transport behavior.
- Existing output or repository/input path: never overwrite or write evidence.

### Task 1: Profiling recorder

**Files:** `apps/backend/scripts/verification-profiler.ts`, `apps/backend/tests/verification-profiler.test.ts`.
**Interfaces:** `VerificationProfiler.phase(name, operation, sample?)`, `wrapFetch(fetch, providers)`, `report()`.

- [x] RED: phase/RPC/stream timing, privacy, forbidden methods/endpoints.
- [x] Implement local recorder; prove GREEN.

### Task 2: Read-only CLI and live profile

**Files:** `apps/backend/scripts/profile-verification.ts`, backend tests/package scripts, backend README, security call graph.
**Interfaces:** `--account-directory <external path> [--output-directory <new external path>] [--samples 1..5]`.

- [x] RED: strict arguments, external paths, incomplete evidence, output protection.
- [x] Implement read-only recovery/restoration/verification, CPU profiler lifecycle and artifact exports.
- [x] Run a real read-only profile; inspect trace/CPU shape and unchanged input evidence.
- [x] Run backend tests/typecheck and root tests; document outcomes and limits.
- [x] Independent read-only review; fix material findings with regression proof.

## Verification and measured limits

- `npm test`: 853 security-core passed / 2 existing deferred; 191 backend passed; 213 app passed; existing landing no-tests gate passed.
- Backend TypeScript and `git diff --check`: PASS.
- Successful profiling integration: genuine local Safe seven-transaction deployment, recovery/restoration/two verification samples, real read RPCs, complete trace/CPU artifacts, unchanged recursive source bytes and payer nonce 7 → 7.
- 2026-11-10 live read-only capture: recovery stopped after 2.439 seconds (0.466 seconds process CPU) with `missing-confirmed-deployment-evidence`. Publicnode returned no first/last deployment receipt in three direct repeated probes; Tenderly returned the first receipt. This is unavailable historical evidence, not a successful verification timing or an inferred pruning cause. Never bypass evidence checks or rewrite historical profile commitments to obtain a profile. The later explicit archive-access follow-up is documented separately; it retains both independent readers and every verifier predicate.
- Live artifacts: private generated directory `vault-verification-profile-d403c353-b6c7-4643-aed9-39541ca76241`; summary/trace contain closed labels only. Source journal hash unchanged.
- Review findings fixed RED→GREEN: dot-prefixed child containment (shared external-path helper and source evidence), default temporary output containment; abort metrics distinguish cancellation from provider failure. Existing valid external paths retain behavior.
- Review bounds: completed baseline changes were already reviewed; live provider reliability was observed directly rather than changed; successful full profiling was subsequently proved against real local contracts. No additional findings deferred. No live signing, broadcast or source-evidence writes.

- Archive-access follow-up: live recovery/restoration and three full verification samples now pass with unchanged source evidence and payer nonce. See [profiling guide](../../security/verification-profiling.md) and [redacted measured report](../../evidence/2026-11-10-verification-profile.json); original failed capture remains a partial availability diagnostic.
