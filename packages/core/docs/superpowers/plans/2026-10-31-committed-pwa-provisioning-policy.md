# Committed PWA Provisioning Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Commit fixed Sepolia provisioning policy/artifacts and remove external `reviewed-artifacts.json` without weakening exact per-wallet approval.

**Architecture:** `security-core` loads reviewed profile/Delay bytes from Git and derives distinct signer runtimes from pinned Safe passkey creation code plus verified onchain factory state. Backend consumes only that committed policy; external files hold generated wallet review, approval/digest, and journals.

**Tech Stack:** TypeScript, viem, Hardhat, Vitest, Node.js.

**Spec:** `packages/security-core/docs/superpowers/specs/2026-10-31-committed-pwa-provisioning-policy-design.md`

## Global Constraints

- Testnet security research only; no live deployment or mainnet claim.
- No dependency/version/contract change.
- Legacy external reviewed-input files are not dual-read.
- Generated plans remain unsigned and reproducible before human approval.
- Per-wallet review, approval digest, and journals stay outside Git.

## Review Focus

- Different credentials must yield different signer runtime hashes; mutation must fail before broadcast.
- A changed pinned signer proxy artifact must fail its committed creation-code anchor.
- Missing or changed committed Delay bytes must fail the pinned source digest.
- Retired `BACKEND_REVIEWED_ARTIFACTS` must fail explicitly; absence must not block startup.
- Final verification must reject drift in either credential-specific signer runtime.

---

### Task 1: Commit artifact and signer derivation boundaries

**Files:**
- Move: `packages/security-core/test/fixtures/ordinary-usdc-recycle-continuation-delay-mastercopies.public.json` → `packages/security-core/config/artifacts/zodiac-delay-v1.1.1-mastercopies.json`
- Modify: `packages/security-core/src/config/{zodiac-delay,deployments}.ts`
- Modify: `packages/security-core/src/topology/reviewed-artifacts.ts`
- Modify: affected scripts/tests and `packages/security-core/docs/security/dependency-review.md`

**Interfaces:**
- Produces: `loadCommittedZodiacDelayArtifact()`; credential-specific runtime derivation inside `resolvePwaPlanningInfrastructure`.
- Consumes: pinned package artifacts, verified factory/singleton/verifier, `ArtifactResolutionClient.call`.

- [x] Write failing tests for committed Delay loading, artifact-anchor mutation, and distinct credential runtime hashes.
- [x] Run focused tests; verify expected failures.
- [x] Implement committed artifact loading and signer derivation; remove caller-selected Delay source.
- [x] Run focused and full security-core tests; verify pass.
- [x] Commit.

### Task 2: Remove backend reviewed-artifacts configuration

**Files:**
- Modify: `apps/backend/src/{config,provisioner}.ts`
- Modify: `apps/backend/tests/{config,backend-surface}.test.ts`
- Modify: `apps/backend/README.md`
- Modify: `packages/security-core/src/pwa/{profile,provisioning,backend-api.d.ts}`

**Interfaces:**
- Consumes: committed profile, salt `0`, per-credential runtime evidence from Task 1.
- Produces: backend config without `reviewedArtifactsPath`; explicit retired-setting rejection.

- [x] Write failing backend/config and provisioning tests proving no reviewed JSON is required and the retired variable is rejected.
- [x] Run focused tests; verify expected failures.
- [x] Implement committed composition and distinct signer transaction hashes.
- [x] Port the Node ESM/CommonJS package interop regression test and fix.
- [x] Run backend and focused core tests; verify pass.
- [x] Commit.

### Task 3: Document, verify, and review the migration

**Files:**
- Modify: `packages/security-core/docs/security/{call-graph,dependency-review}.md`
- Modify: this plan checkboxes.

**Interfaces:**
- Consumes: Tasks 1–2 behavior.
- Produces: operator migration instructions and evidence.

- [x] Update call graph, dependency review, and backend environment instructions.
- [x] Run `npm run check` and `git diff --check`; verify pass.
- [x] Perform fresh whole-branch review; fix important findings with RED→GREEN tests.
- [x] Commit final documentation/fixes.
