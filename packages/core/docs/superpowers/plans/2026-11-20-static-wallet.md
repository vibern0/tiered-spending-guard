# Static wallet implementation plan

> **For agentic workers:** Use superpowers:executing-plans. Track steps below. One implementation subagent.

**Goal:** Create one passkey Safe. Enable tiered spending later in Settings. Same address throughout.

**Architecture:** New static React app in `apps/static-wallet`. Browser sends ERC-4337 v0.7 UserOperations to a bundler. Chain reads supply wallet and installation status. Local development infrastructure supplies RPC, bundling, sponsorship and shared contract addresses.

**Tech Stack:** React, Vite, TypeScript, viem, Safe 1.5, repository route installer.

**Spec:** [Installable Safe 4337 route](../specs/2026-11-19-installable-safe-4337-contract-routing-design.md)

## Global Constraints

Local research chain 31337 only. One unfunded Safe, primary passkey, distinct contract secondary at activation. No new Solidity, user EOA, browser secret, application backend, indexer or changes to the existing wallet. Public-network adoption remains gated.

## Review Focus

Wrong chain. Rejected passkey. Ambiguous submission after refresh. Reverted installation. Mismatched onchain policy or topology.

### Task 1 — Create wallet

- [x] Build a static React wallet screen. Enroll a passkey, persist public recovery metadata, submit sponsored factory deployment via bundler. Confirm Safe address, owner and initial module before showing wallet ready.

### Task 2 — Enable tiered spending

- [x] Add Settings. Show exact research policy and status. Enroll secondary passkey. Prepare per-Safe contracts, configure policy and install both guard slots with existing installer. Verify installed policy and topology before showing enabled.

### Task 3 — Rehearse

- [x] Supply reproducible local development infrastructure and startup instructions. Exercise creation, activation and refresh against a real local EntryPoint. Test refusal and inconsistent state. Update [call graph](../../security/call-graph.md).
- [x] Run `npm --prefix apps/static-wallet run smoke`, `npm --prefix apps/static-wallet test`, `npm --prefix apps/static-wallet run build` and `git diff --check`. Record actual results and remaining gates.

## Local verification

Chromium virtual authenticator. Three sponsored EntryPoint operations: create, prepare, install. Same Safe after reload. Declined final sponsorship leaves guard slots empty. Retry resumes prepared state. Two tabs creating simultaneously submit one operation.

Verified both guard slots, one route recipient, zero vault balance. Read-only native transfer simulation accepts 0.001 ETH with the primary passkey and rejects one wei more. Recipient uses the pinned Safe test receiver fixture. Production build passes the browser flow over plain static HTTP. Fifteen app tests pass.

Live bundler admission, sponsor coverage, physical authenticators, alerts and profile repair remain unverified. UI covers creation and installation only.
