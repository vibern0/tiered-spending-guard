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

## GLD sending follow-up

- [x] Deploy ERC20Mock, seed the requested address and show its token balance.
- [x] Configure one token and recipient in Settings. Require verified GLD guard policy for Send.
- [x] Sign the exact ERC-20 Safe transaction and router-domain UserOperation. Verify real base and step-up transfers and over-limit rejection through the browser.

The GLD rehearsal replaces the native-transfer preset for new local installations. The old native-only profile remains on its original chain. The requested address was recreated on a separate local chain with its original factory initializer and passkey owner. Installing GLD protection remains an owner action.


## Delayed GLD wallet follow-up

- [x] Route sends above the shared 30 GLD daily allowance into the existing two-passkey Delay queue.
- [x] Recover the verified queue from chain data. Display the cooldown, execution window and head-only cancellation and execution actions.
- [x] Display primary, combined instant, step-up and executed delayed GLD usage for the current UTC day.
- [x] Verify the browser flow with a separate Safe, including refresh, cancellation, the 120-second cooldown, balances and usage.

## Cumulative wallet thresholds

- [x] Base both wallet meters and the passkey prompt on total instant GLD spent today. Preserve the installed guard's separate primary-only accounting and disclose that distinction in Settings.

- [x] Enforce the cumulative X ceiling inside the ERC-4337 guard. Read the same per-token instant total for both signature tiers. Preserve raw signer counters and the UTC rollover.
- [x] Verify 1 GLD with primary, 9.1 GLD with both, rejection of a one-unit primary-only send, remaining 19.9 GLD with both and next-day primary approval through Safe 1.5.


## Single-prompt local GLD follow-up

- [x] Provision a separate local Safe with an EntryPoint v0.7 full-operation router and a guard in both slots.
- [x] Measure browser passkey requests and successful assertions per credential for 1 GLD and 9.1 GLD. Verify the shared challenge for the second send.
- [x] Check exact X and Y, stale tiers, same-bundle ordering, failed-token rollback, nonce replay, expiry, daily reset, sponsored receipts and zero Safe gas contributions.

## Sponsored queue on a separate local Safe

- [x] Bind both credentials to one queue-specific operation and restrict execution to the configured Delay's GLD enqueue call.
- [x] Count both browser assertions for a 20 GLD queue after spending 10.1 GLD. Verify cancellation, timed execution, expiry, paymaster charges and token accounting. [Local receipts](../specs/2026-11-23-one-prompt-delayed-queue.md)

## Sponsored cancellation

- [x] Bind one approval per credential to the selected withdrawal and current head, and verify the one-entry advance onchain.
- [x] Rehearse cancellation with two identical withdrawals, measure prompts and sponsor charges, and execute the surviving withdrawal after its cooldown. [Local receipts](../specs/2026-11-23-one-prompt-delayed-cancel.md)

## Static wallet browser acceptance test

- [x] Make `npm run wallet:test` own a disposable Hardhat chain and Chromium session. Exercise wallet creation, opt-in protection, both instant tiers, two identical queue entries, cancellation, execution after cooldown and sponsored receipts with virtual passkeys.
- [x] Replace the static wallet's Vitest files and manual smoke script with the Playwright scenario.
