# EURC Passkey Wallet Demo Evidence

Status: local release gates pass; live Sepolia rehearsal outstanding.

This report is deliberately redacted. It records implementation and local-gate evidence only. The wallet remains a security-research/testnet prototype and is not production-ready, audited, or authorized for mainnet use.

## Release-gate matrix

| Check | Status | Evidence |
| --- | --- | --- |
| Sepolia-only chain identity | PASS (unit coverage) | `apps/app/src/lib/vault-chain.test.ts` |
| Circle EURC runtime and metadata validation | PASS (unit coverage) | `validateEurc` tests runtime code, name, symbol, and 6 decimals |
| Fresh guarded topology projection | PASS (unit coverage) | `readVaultSnapshot` and `vault-store.test.tsx` |
| Browser primary/secondary passkey constraints | PASS (unit coverage) | `webauthn-passkey.test.ts`, backend WebAuthn tests |
| Exact EURC transfer calldata and Safe digest | PASS (local backend tests) | `apps/backend/tests/vault.test.ts`, `submit.test.ts` |
| Primary/secondary tier enforcement | PASS (local backend tests) | `SafeSubmissionService` adversarial tests |
| Duplicate and uncertain broadcast reconciliation | PASS (local backend tests) | `apps/backend/tests/submit.test.ts`, `journal.test.ts` |
| Chain-derived balance/policy/health UI | PASS (app tests/build) | `vault-store.test.tsx`, app build |
| Queue/history/alert projection | PASS (app tests) | `vault-activity.test.ts` |
| Fresh browser-passkey Safe on Sepolia | NOT RUN | Requires separately authorized backend secret, reviewed deployment artifacts, and controlled testnet funding |
| Base X transfer, Y step-up, delayed Z execution/cancellation/expiry | NOT RUN | No live transaction hashes recorded |
| Delayed recipient policy repair | NOT RUN | No live transaction hashes recorded |
| Rejected mutation matrix on Sepolia | NOT RUN | No live transaction hashes recorded |

## Local verification commands

```text
npm --prefix apps/app test
npm --prefix apps/app run build
npm --prefix apps/backend test
npm --prefix packages/security-core run security:check
```

The commands above must be rerun from the repository checkout immediately before any future live rehearsal. A passing local gate is not evidence of deployed-code identity, hardware authenticator behavior, or audit status.

Observed local gate result on 2026-10-16 before backend rename: app 27 tests passed and built; prior bridge 12 tests passed; security-core 297 tests passed, 4 invariant tests passed, coverage completed, Slither reported 11 reviewed baseline findings with no new findings, and the time-controlled rehearsal passed. The rehearsal reported `chainId: 31337`, `signed: false`, and `broadcast: false`. Backend rename and new boundary tests require fresh gates before this report is refreshed.

## Required live evidence, when separately authorized

Record only public values: chain ID, Safe/guard/Delay/passkey/EURC addresses, reviewed runtime hashes, Safe nonces, transaction hashes, receipt status and block hashes, decoded guard/Delay events, before/after EURC/native balances, spend state, queue timestamps, and gas cost. Reconcile each result by nonce, receipt, events, and balances before the next action. Do not record passkey material, relay keys, RPC secrets, PINs, or assertion payloads.

The live matrix must include modified-digest denial; primary-only/secondary-only rejection; approval, Permit/Permit2, batch, delegate-call, direct-module, unknown-calldata, unknown-recipient, wrong-chain, and duplicate-submission rejection; Y step-up; above-Y queue; early execution rejection; cancellation; expiry; elapsed-Z execution; and delayed recipient policy repair.
