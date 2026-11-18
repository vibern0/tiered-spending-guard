# Local Multi-User Account Implementation Evidence

Date: 2026-11-06. Initial scope: localhost code/tests. User-assisted Vivaldi follow-up appears below. This document is not an independent audit, monitoring-delivery proof or production-readiness claim.

## Implemented Boundaries

- Durable SQLite accounts/public credential metadata, opaque cookie sessions, CSRF and account/session ownership. No hardcoded account-count ceiling; metadata test creates 130 independent records.
- Discoverable synced first-key sign-in; first key alone opens the existing account and authorizes base transactions. Exact second signatures remain mandatory for policy-required elevated actions.
- First/second registration handles are distinct, preserving the primary credential on a shared authenticator. Targeted legacy sign-in accepts nullable handles only with server-known exact first-key context.
- Shared payer lease and independent external-directory/registry inventory; retained/incomplete/uncertain evidence cannot be hidden by a missing account row or database.
- Durable normalized approval fingerprints reject cross-session/idempotency zero-counter assertion replay. The counter update and fingerprint consumption, including learned secondary metadata, are atomic; raw assertions/payloads remain unpersisted.
- Login/logout/account switching protects against stale browser responses. Restored own submission references permit exact-hash reconciliation after losing all browser storage.

## Local Verification

- `npm run backend:test`: **144 passed**, including real ES256/Safe HTTP tests; backend typecheck passed.
- `npm run app:test`: **191 passed**; app typecheck and production build passed; changed-file lint had zero errors and 14 existing-pattern warnings.
- `npm --prefix packages/security-core test`: **845 passed, 2 pending**. Deferred cases are the existing actual default reader/context and actual recycle loader/production repair adapter/store compositions; their production gates remain open.
- Root `npm test` passed before the final recovery-ID metadata addition; affected backend/app suites were rerun after it. Landing has no test files and exits through its existing `--passWithNoTests` setting.
- `git diff --check` passed.

`apps/backend/tests/multi-user-http.integration.test.ts` runs a temporary local EVM with actual pinned Safe/passkey/guard/Delay code, a local token implementation behind the pinned USDC proxy, and ephemeral software authenticators. It creates A, B and C through independent browser-equivalent HTTP sessions, produces 21 real deployment transactions, preserves their distinct Safes, reopens the same account after restart, accepts synced backup flags/zero counters, transfers base value with first approval only, rejects B's secondary for A's step-up, and confirms the correct first/second path. It also rejects an already accepted primary assertion after logout/new-session/new-ID for the same exact digest, and restores an uncertain transfer reference after browser reset without a second broadcast.

A fresh whole-change reviewer identified five material findings. Each received regression coverage and a scoped follow-up: registry omission, primary discoverable credential overwrite, zero-counter assertion replay, targeted legacy UI/transport and nullable targeted user handles. All are closed in the final scoped review. The late own-account recovery-reference addition was separately checked for isolation and non-authorizing behavior.

## Remaining Gates

Actual cross-device/cloud-provider sync, second physical device access, HTTPS/mobile, full live Sepolia X/Y/Z/cancel/expiry/repair receipts, independent alert delivery, external specialist review and professional audit remain separate. Existing legacy records are preserved; this change does not replace their onchain signers, move funds or weaken X/Y/Z. Backend compromise remains within the explicitly accepted Phase One trust limitation.

## Vivaldi Debugging Follow-up

The actual Vivaldi tab initially showed `ERR_CONNECTION_REFUSED`; the configured backend exited on a dead authorization-sidecar lock. Reuse of the existing inode-bound PID lease now recovers only provably dead owners, while live/malformed owners remain rejected. Completed read-only restoration no longer requests an authorization writer. Regressions cover retained records and a real local completed account restored while its authorization lock remains held.

Vivaldi also exposed overlapping session reads and an unfinished anonymous account loop. Session reads now coalesce per generation; a stale focus response cannot erase a newly selected account. Explicit account creation logs out the old anonymous context before creating a separate signup, preserving its original passkey. Each issue received failing-then-passing regression coverage.

The user created the first credential in Vivaldi. Its verified metadata reported backed-up, backup-eligible `hybrid`/`internal` transports. The immediate next ceremony was first-key sign-in, not second registration. The frontend now preserves those exact provider hints for the targeted first credential and labels that step. The user resumed with discoverable first-key sign-in and registered the second signer; Vivaldi visibly advanced to automatic provisioning. Other-device/cloud-sync access remains untested.

Fresh checks: backend **144 passed**, app **199 passed**, security core **847 passed / 2 existing pending**. Backend/app TypeScript and app production build passed. Changed-file lint: zero errors, 14 existing mixed-export warnings. A separate read-only review found no material bug in these follow-up changes.

The actual localhost Vivaldi flow then completed all seven Sepolia deployment steps. The external account journal reported `verified` with seven successful entries; the browser showed both signer steps and provisioning complete, first signer active, and the following public identity:

- Safe: `0xb9622AB5b43CE8E58B0552214bb2822533070B2F`.
- Provisioning receipt: `0xcc5d06637ecccb2033f59b6312679abf66bf5630004833e2112498c74bae0a92`.

This is account-creation evidence only. Safety acknowledgements remained unchecked, and no asset transfer, other-device sync, independent alert or audit gate was claimed.

Restart proof: stopped the configured backend, confirmed port 8787 closed, restarted it, and reloaded the same Vivaldi tab. It restored the same Safe and receipt with both signers active and no new registration or authentication ceremony. The journal still contained exactly seven successful deployment entries. At test closeout the backend was stopped again; `lsof` found no listener on 8787 and a direct `/health` request failed with `ECONNREFUSED`. The pre-existing frontend development server was left running.

## Backend Readiness and Request Logging Follow-up

After the user started their own Ghostty instance, `/health` returned 200 on localhost:8787 with the exact browser origin and credentialed CORS. Vivaldi retained an earlier connection-failure message; reloading restored the existing vault without new credentials. No frontend connection-policy changes were needed.

The CLI now emits timestamped `backend_starting` before verification and `backend_ready` with actual bind address, port, loopback URL and allowed browser origin only after listening. Both HTTP compositions emit immediate request arrival and one completion/abort, with correlation ID, closed route template, status when available, and elapsed time. Private headers/bodies/identifiers/query/path values are excluded. Tests cover failed and successful requests, privacy, aborted long requests and premature readiness rejection.

Verification: **149 backend tests passed**, backend TypeScript and `git diff --check` passed; separate focused review found no material issue. A temporary real configured backend on 8788 logged startup, actual readiness after about 20 seconds, GET health arrival/completion (200) and OPTIONS arrival/completion (204). That test instance was stopped and port 8788 closed. The user's original Ghostty backend remained listening on 8787; it needs a restart to load the new logging code. Computer-use access to Ghostty was blocked, so its terminal was not controlled or restarted. Final Vivaldi state showed the existing account provisioned and all onboarding steps complete.

## Logout and Login Navigation Follow-up

The profile already exposed server-backed logout but was missing from the main navigation. Added the **Account** tab on every main screen, with a failing-then-passing navigation regression. In actual Vivaldi, opened Account from the main navigation, signed out, observed the unauthenticated screen, and signed in with the user's existing first passkey. The same account `e2199994-207a-40be-aa77-fc34cd7d0fbe` and Safe `0xb9622AB5b43CE8E58B0552214bb2822533070B2F` reappeared. No second signer, registration, provisioning or asset transfer was requested. The user's running backend remained untouched.

App verification: **200 tests passed**, TypeScript and production build passed, changed-file lint had zero errors and one existing mixed-export warning; `git diff --check` passed.

## User-Assisted First-Only Sepolia Transfer

The user later selected the separate account `b8b32dfd-a383-4490-a4db-d09cf741511d`, Safe `0x467e8EA4EB74560E03ADC8EE02d30e0Cb13D4516`. Its initial 0.05 USDC attempt returned a provider-availability error before a submission was recorded. A read-only reconstruction successfully prepared and revalidated the same intent without signing/broadcasting. The user retried and completed their first-passkey approval.

- Transaction: `0x1793ea6a8fa907889e854d23e94c6c0ebbefbc5e02e09c87ada79fd3cea3ae41`.
- Sepolia block: `12078649`, hash `0xdd656ebbe95063711d8f1d827aaae13f26c67e0badcdac38e365f2fe10ec6250`.
- Both committed providers independently agreed on the successful canonical receipt at **9 confirmations** when checked.
- Outer destination matches the currently signed-in Safe; its receipt contains exactly one Safe `ExecutionSuccess` and no `ExecutionFailure`.
- The pinned Circle USDC contract emitted exactly one matching `Transfer`: that Safe to `0xaD4D5cd2Ec5beCdB9608baD4c36F0dBe8b2492Bc`, amount `50000` base units (**0.05 USDC**).
- Durable approvals: primary `true`, secondary `false`.
- Read-only **Reconcile** in Vivaldi changed the recorded result from `uncertain` to `confirmed`, with no new approval or broadcast.

This proves this one user-assisted base transfer. It does not complete the live step-up/delayed/cancel/expiry/repair, other-device sync, independent-alert or audit gates. No product code or running user backend was changed during validation.

## Prior Receipt Blocking a Two-Signer Attempt

The user's next 0.10 USDC attempt was blocked before signature processing by a previous 0.94 USDC submission (`1cbfb10c-955c-4461-b3a7-41d820a8c1b1`) still recorded as `uncertain`. Its exact hash `0x0c66152cf4e47d4842951df7118919eabab314bf614fd5d78024d025dbdd123f` had already succeeded. Both committed providers agreed at **12 confirmations** on canonical block `12078722`, hash `0x84b9146a499d8182f939ca1b8233f5b6b91dfbb1a12fbab663ca22ca32b84aeb`, one Safe execution success and the exact pinned-token transfer of `940000` units from the signed-in Safe to the configured recipient.

`assertPayerAvailable` correctly blocks another submission while any source journal retains an unresolved outer hash. The initial submission reconciliation can return before six confirmations, and the browser has no ongoing receipt polling, leaving that source record stale until explicit reconciliation. This was a receipt-status blocker, not a second-signer verification failure.

Opened Activity in a separate Vivaldi tab, reconciled only that exact prior record, observed `confirmed`, and verified no unresolved broadcasts remained. The 0.10 USDC attempt (`13f02726-bf1a-40d0-b5f5-17400e31539d`) remained `awaiting-primary` with neither approval recorded and no outer hash. Its original review was preserved. No new transfer was authorized/broadcast, and no product code or running backend was changed. Automatic receipt refresh remains a product follow-up; the payer safety gate was preserved.

## User-Assisted Two-Signer Sepolia Transfer

The user retried with both signers in a new submission `2215200c-87b0-40d5-ac28-7e9946de7dd5`. Exact transaction `0xb0d0234f9b35c117c8ceb906b3528b088ac1469f55c2e1215312b19adab48168` successfully transferred **0.10 USDC** from the same signed-in Safe to the configured recipient.

Both committed providers agreed on the canonical successful receipt in block `12078947`, hash `0x31f52647f7aea3d06bc608d88c3327d0931926b43244eeb8b729ddeb1300d2f1`; the final check had **7 confirmations**. The receipt matched the Safe destination, exactly one pinned-token `Transfer` of `100000` units and one Safe execution success. Both providers also decoded the configured guard's `TransferAuthorized` as tier `1` (`StepUp`), with `baseSpent=990000` and `instantSpent=1090000`. Thus first-only spend remained **0.99 USDC**, while shared instant spend became **1.09 USDC**.

Durable approvals recorded primary `true` and secondary `true`. Read-only reconciliation changed the result to `confirmed`; Vivaldi displayed that result and no unresolved broadcasts remained. The older unsent 0.10 attempt stayed non-authorizing. No product code, running backend, or security rule was changed during validation. This adds one successful step-up receipt, not the remaining delayed/cancel/expiry/repair, independent-alert or audit gates.

## Final Integration Verification

At the user's explicit request to commit and push all work to `main`, reran the complete root test suite sequentially after the production build: **847 security-core tests passed / 2 existing pending; 149 backend tests passed; 200 app tests passed**. Landing retained its successful no-tests exit. Root production build and both backend/app TypeScript checks passed; changed-app-file lint had zero errors and 15 existing mixed-export warnings. A final independent whole-change review reported no actionable material finding. All 57 changed/new files were checked against configured relay/RPC secret values with zero matches; ignored local configuration and diagnostics are excluded from the commit. The known automatic receipt refresh gap remains documented.
