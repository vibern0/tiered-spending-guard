# Archive Evidence Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore historical receipt/state availability; preserve independent two-provider verification and existing reviewed deployments.

**Architecture:** Explicit private external access profile selects the complete Infura/Tenderly evidence-reader pair. Default Publicnode/Tenderly remains unchanged. Historical signed PWA identity/profile commitments remain immutable; current observation labels name actual operators.

**Tech Stack:** Existing Node/TypeScript/viem; no dependency or contract change.

**Spec:** User authorizes historical availability fix without weaker checks, real profiler rerun, documentation, same PR update and merge only when green.

## Global Constraints

- Never infer missing receipts from journals, transaction inclusion or one provider.
- Keep exact transaction/receipt/canonical block/runtime/signer/policy/state agreement, six confirmations and successful-execution observation.
- Archive access is opt-in, fixed Infura operator plus fixed Tenderly; no arbitrary provider, relay substitution, per-call fallback or hidden source attribution.
- Private external `0600` JSON: `version: 1`, `profile: infura-archive`, exact HTTPS Infura Sepolia `/v3/<32-hex-project-key>` URL. Reject redirects, ports, alternate hosts, credentials, query, fragment, extra fields and missing/insecure files.
- No changes to existing reviewed plans, profile commitments, custody, signing, gas payer or provisioning sequence.
- Never log/persist endpoint credentials in repository, traces, summaries or PR.

## Review Focus

- Same-operator/arbitrary/malformed reader config fails before network/signing.
- Archive source returns unavailable/disagreeing/wrong-chain/reorged data: preserve failure and payer blocker.
- Endpoint credentials never enter source IDs, authorization metadata, logs or artifacts.
- Real historical profile rerun passes with unchanged source evidence/payer nonce; tiny samples remain observations, not p95 claims.

### Task 1: Reviewed access profile

**Files:** Backend evidence access/config/read-client composition and tests; profiler options/tests.
**Interfaces:** `BACKEND_EVIDENCE_CONFIG_PATH`, `--evidence-config`, `loadEvidenceAccess(path?)`.

- [x] RED: strict schema, private/external file, fixed independent sources, truthful/redacted IDs, shared runtime/profiler selection.
- [x] Implement access selection without changing verifier predicates or signed commitments; GREEN.

### Task 2: Live proof, documentation and delivery

**Files:** Backend README; security verification-profiling/call-graph/dependency-review docs; redacted evidence summary.

- [x] Run actual old-account profiler; verify successful recovery/restoration/samples, unchanged journal and payer nonce.
- [x] Document setup, tools, limitations, observed timings and retention diagnosis.
- [x] Resolve genuine introduced analysis findings; retain explicit false-positive rationale for constrained cases.
- [x] Full tests/types/build/strict static analysis and independent review.
- [x] Prepare follow-up for PR #12; gate merge on latest-head cloud checks.


## Analysis review

- Local strict PR and staged analysis executed installed Semgrep, ESLint8, markdownlint and Trivy; PR scope also ran Jackson. No Semgrep/Jackson/markdownlint/Trivy findings. Existing Semgrep parser warnings and missing ESLint type-aware parser services remain explicit coverage limits.
- Generic dynamic-file warnings refer to validated external paths or test temporary files. Object-index warnings refer to bounded provider arrays, closed trace/method labels, canonical own-property serialization and null-prototype status dictionaries. The genuinely unsafe inherited-status dictionary was corrected with seven adversarial browser regressions.
- The cloud timing warning compared a public transaction-hash fixture, not an authentication secret. The fixture now represents unavailable hashes as a set; no production authentication comparison or cryptography changed.


## Final verification

- Full root suite: 853 security-core passed, two existing deferred; 220 app passed. Final backend rerun after pacing: 213 passed across 29 files, including genuine dual-profile deployment recovery/restoration/verification. Landing retains its existing no-tests gate.
- Backend/app TypeScript, app build and whitespace checks pass. Independent read-only archive/queue reviews found no actionable issue; existing professional audit/live gates remain open.
- Final staged strict analysis: all five configured tools executed; Semgrep/Jackson/markdownlint/Trivy zero findings. ESLint8 reported 42 reviewed generic path/index/bounded-regex warnings across changed files and baseline, with the existing missing type-aware parser-services limit. Full PR scope also records two existing Semgrep parser warnings. Local generic warnings are not represented as a clean scan; latest cloud PR findings remain the merge gate.
- Successful live capture: recovery 7.595 s; restoration 5.690 s; verification 7.716/8.269/7.269 s. Seven source files and payer nonce unchanged. Three HTTP 429 responses recovered through existing bounded retries. No signer/broadcast/source write. [Measured evidence](../../evidence/2026-11-10-verification-profile.json).
