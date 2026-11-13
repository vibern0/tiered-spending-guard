# Multi-User Vault Accounts, Synced Passkeys and Local Sessions

## 2026-11-12 approved background-creation amendment

The [approved minimal local backend design](../../../../../docs/superpowers/specs/2026-11-12-minimal-backend-design.md) supersedes older browser-driven provisioning, startup-no-broadcast, legacy adoption/rebind and automatic successor/rebase requirements below. The user authorized implementation and waived a separate implementation plan. This is a narrow local Sepolia amendment; X/Y/Z, exact approvals, immutable deployment commitments and all independent-alert/live/audit gates remain unchanged.

The verified second credential and one queued creation-job marker commit atomically in the version-2 account database. After the server starts listening, only explicit queued/in-progress jobs in that current format may resume through the shared payer coordinator, bounded per-transaction authorizer, exact recovery verifier and existing seven serial transactions. Startup validation itself remains read-only; the committed job is the sole post-startup deployment exception. Historical files or two credential records alone never create a job. Browser closure, logout and session expiry do not revoke this bounded deployment job or authorize spending.

HTTP returns setup state promptly; the browser observes account/session polling and never holds a deployment request open or re-registers a fixed key to resume. Fully confirmed work is never replayed. Reconcile exact retained hashes before any new signature; evidence conflicts, unexpected nonce use and exhausted transient retries leave a visible blocked state and preserve the shared payer blocker. There is no automatic successor or nonce rebasing. First-key login opens the account; fresh exact second approval remains action-specific. Explicit import/rebind/archive and singleton/HTTPS compatibility paths are removed.

Use a fresh external data root. Do not migrate, delete or rewrite older account databases, journals, review packages or archived evidence. Missing/incompatible registries with retained evidence fail closed. Receipt/history workers remain read-only. Current readers require the fixed independent Infura/Alchemy Sepolia pair through private version-2 external access configuration; this does not rewrite signed deployment/profile commitments.

Earlier sections remain historical design/evidence where superseded by this amendment.


**Status:** Approved for implementation by the user on 2026-11-06. Local implementation verified; no live deployment or production claim.
**Date:** 2026-11-06

## Intent and Confirmed Requirements

Build the frontend/backend around persistent, independent user accounts. Users A, B and C can each visit, create an account and receive their own verified vault through automatic in-app provisioning. There is no hardcoded total account limit and no process-global current user, vault or signer pair.

A can later sign in with the same synced first passkey and open the same account, including after clearing browser storage. Registration creates an account; authentication opens an existing account. Neither browser reset nor a different device creates a replacement vault implicitly.

The user confirmed:

- The first passkey alone signs the user in.
- The second signer is requested only for actions whose policy requires it. It is not a prerequisite for sign-in, viewing an account, base-tier spending or reading transaction status.
- Synced first passkeys are supported. Devices are not account identities.
- Account creation has no hardcoded account-count ceiling.
- Localhost is the delivery scope for now; a public HTTPS deployment is not a prerequisite for this change.
- The architecture should support a proper multi-user product, rather than a singleton demo with manually exchanged configuration files.

Each independent account retains exactly one asset-holding Safe and the existing X/Y/Z enforcement. This product design does not declare the security research prototype production-ready.

## Evidence and Explicit Scope Amendments

`apps/backend/src/handlers.ts` currently holds one credential map, vault record and provisioning promise per process. `storeCredential` correctly rejects a new key against the recovered role key for that vault. `apps/backend/src/session.ts` also tracks registered signer roles globally. `apps/backend/src/main.ts` composes one provisioner and submission service around one set of external paths. The frontend attempts registration when browser configuration is absent, while existing rebind requires locally saved credential IDs. These assumptions explain the cleared-browser failure.

The prior investigation ran the existing handler/server/provisioner suites: 29 tests passed, including rejection of different keys for recovered roles. That evidence describes current behavior, not verification of this design.

The rejected `2026-11-05-phase-one-one-time-setup-design.md` is historical. Do not restore its separate setup command. Automatic registration, provisioning, exact recovery and topology verification remain required per account.

This approved revision explicitly makes the following changes to the earlier approved Phase One browser/recovery design:

1. Replace process-global account selection with persistent account records and authenticated browser sessions.
2. Replace the requirement to rebind **both** roles before any prepare/submit/reconcile operation with first-passkey sign-in plus action-specific approval. In particular, the blanket gate in `2026-11-01-dynamic-pwa-provisioning-envelope-and-recovery-design.md`, under **Credential continuity**, changes. The second key must still match the reviewed account role whenever an action requires it.
3. Persist public credential identifiers, keys and verifier metadata, rather than keeping credential references/counters only in memory. Private passkey material and reusable assertions/signatures remain excluded.
4. Add a transactional account database around the existing durable deployment/submission evidence. Database contents cannot self-issue verified capabilities.
5. Interpret one Safe as one custody Safe **per independent account**, with no auxiliary custody Safe or cross-account spending allowance.

These amendments must be carried into the implementation plan, affected approved specifications, provider evaluation and call graph before enabling new execution paths. Current code retains its existing behavior until that implementation is reviewed and tested. The Safe signature format, policy checks and onchain signer topology do not change.

## Approaches and Selected Technical Choice

1. **Restore the singleton vault only.** Fixes one reopening path but cannot serve independent users. Rejected by the confirmed requirements.
2. **Separate backend processes and files per user.** Reuses isolation but requires operator actions for registration and does not provide normal multi-user sign-in. Rejected by the confirmed requirements.
3. **Shared backend with transactional account storage, isolated sessions and account-scoped vault services.** Selected product direction for this revision. Reuses the reviewed per-vault provisioner and submission machinery, with a shared payer coordinator.

Selected implementation: Node 24.21.0 built-in SQLite for the single-host localhost milestone, stored outside the repository. Use database transactions, schema migrations, indexed unique constraints and bounded queries. Retain existing append-only public deployment/submission journals as execution evidence. Do not replace their durability/verification rules with ordinary database status flags. A database backup includes its transaction state and matching evidence files.

A hosted database and multiple backend workers are later operational work. Keep storage access behind account/session/job boundaries, but do not implement a second database, distributed coordination or a hosted service now. The installed Node 24.21.0 runtime supplies `node:sqlite`; no additional npm database driver is needed. Record the runtime dependency in `docs/security/dependency-review.md`.

## Accounts and Persistent Data

An account is the product identity associated with one vault and its configured signer roles. No email, username, password or external identity provider is required for this milestone. Account IDs and WebAuthn user handles are server-generated opaque values. A person may create multiple independent accounts with distinct first credentials; authenticating the same credential returns its existing account. Multiple vaults sharing one first credential are outside this milestone.

The logical records are:

| Record | Purpose and constraints |
| --- | --- |
| Accounts | Stable ID, environment/profile/RP, setup state, vault projection and evidence references. One Safe per verified account. |
| Credentials | Account/role, credential ID, opaque user handle, ES256 public key/coordinates, transports, signature counter and backup metadata. Unique credential-to-account mapping within the RP; distinct first/second keys. |
| Browser sessions | One account, token verifier, creation/last-use/expiry/revocation state. No signer approval or spending authority. |
| Challenges | Purpose, session/setup context, role when applicable, RP/origin, nonce, expiry and consumed state. Transaction requests retain exact existing digest binding. |
| Provisioning jobs | Account, immutable plan/package references, queued/executing/reconciliation state and account-owned journal locations. |
| Submission references | Account-scoped IDs and indexes into the existing immutable public intent/journal records. No duplicated source of transaction authority. |

There is no account-count constant, fixed account array, per-user process allocation or startup loop that must load every account into memory. Paginate operational queries, load selected accounts on demand and reclaim expired sessions/challenges. Rate limits, deployment concurrency, gas budgets and storage capacity are resource controls; they must not become a hidden total-account ceiling. Keep existing bounded historical successor verification intact; those per-lineage security bounds are unrelated to total account count.

Only the backend assigns account IDs, storage paths, deployment inputs and supported profile versions. Account IDs never become raw filesystem paths or onchain authorization. Reject traversal, symlink escape, profile mismatch, duplicate credential binding and conflicting identities. Do not expose an unauthenticated account directory.

Persist public identifiers/keys/counters and non-authorizing session verifiers outside the repository with restrictive permissions. Never persist passkey private material, assertions, approval payloads, relay keys in account rows, or raw signed transactions. Runtime secrets/config remain external.

## Registration and Automatic Account Creation

An empty browser offers **Create account** and **Sign in with passkey**. It does not inherit another browser's current vault.

1. Create a short-lived anonymous setup session and backend-owned pending account context. It permits only that setup's registration/status operations, not existing account access or spending.
2. Register the first credential with a stable opaque user handle for that account, `residentKey: required`, `userVerification: required`, ES256 and no forced device attachment/transport restriction. This enables discoverable first credentials while allowing supported synced providers and security keys. Do not require a particular cloud provider or claim the backend can enable synchronization.
3. Commit the verified registration atomically to that setup/account. A first credential already bound to an existing account cannot create a second mapping; guide the user to sign in without disclosing that account's details.
4. Obtain a fresh first-passkey authentication assertion to upgrade the anonymous setup session to an authenticated account session. Registration responses or public credential IDs alone never create spending authority. Provisioning can remain incomplete while the signed-in user resumes setup.
5. Register the distinct second signer through the account's setup context, using a stable role-specific user handle distinct from the first handle to avoid replacing the first discoverable credential on the same authenticator. Its credential remains a guard-only configured signer, not a login identity. Preserve reviewed signer-provider support and user-verification checks. Prefer device separation without claiming it solely from an attachment hint.
6. After both registrations verify, automatically enqueue the reviewed per-account provisioning operation. The second signer is required here because the deployed topology must contain it; it is not subsequently required merely to sign in.
7. Publish a usable vault only after the existing exact plan, receipt, runtime and topology verification passes. Retries/reloads rejoin this account's existing job; they do not create new passkeys or redeploy completed transactions.

Freeze both role keys once the immutable plan is bound. Signup, login, another device or a new registration request cannot overwrite them. Signer replacement remains separately enumerated delayed maintenance.

## What Account Discovery Means

Account discovery is **finding the account belonging to the passkey the user chooses**, rather than asking for a saved browser record or wallet address.

The sign-in flow issues a fresh, single-use authentication challenge without enumerating allowed credentials. The browser/authenticator lets the user select a discoverable credential for the exact RP. The backend uses the returned credential ID to look up a candidate account, checks its expected user handle, then verifies the assertion against that stored first key, exact challenge/origin/RP and required presence/verification before authenticating the session. A lookup result or user handle is not proof of ownership. A targeted setup/account assertion may omit its user handle only when that server context identifies the exact stored first key; an incorrect supplied handle is never accepted. Unknown credentials, a second-role credential, mismatched handles and invalid assertions cannot sign in.

The user need not type an email, account ID or Safe address in the normal flow. The app does not inspect a cloud account, download a provider's passkey list or receive the private key. Syncing is performed by the user's passkey provider. Support is conditional on the original credential being available through that provider or a supported cross-device authentication mechanism.

For an imported older account whose first credential is not discoverable, provide an explicit existing-account reference flow with a targeted first-key assertion. For legacy evidence with no recorded credential ID, verify the assertion against the reviewed first key before learning its ID, as the existing rebind boundary does. A discoverable legacy assertion may try the single adopted legacy record without an explicit account reference; successful key proof, not the fallback lookup, attaches its ID. Never infer ownership from the supplied reference or insert a replacement key. This compatibility flow is not required for new discoverable accounts.

First credentials may be synced; that is not a reason to reject them or demand another registration on each device. Record verified backup metadata without treating it as proof of cloud-provider identity, independent devices or cloud recovery security. Two distinct credentials stored in one cloud account do not establish independent compromise domains.

Use the reviewed WebAuthn verifier and counter semantics. Legitimate all-zero counters are supported; do not assume every synced credential increments a device-local counter. Nonzero counter anomalies remain fail-closed under the existing verifier for this milestone; do not silently suppress them or auto-rotate keys. Consume challenges and update counters transactionally, preventing concurrent verification from losing state. For transaction assertions, atomically consume a durable normalized fingerprint along with the counter update; an already accepted zero-counter signature cannot be replayed under a new attempt/session. Normalize the P-256 s ambiguity in the fingerprint without changing the Safe signature format. Persist hashes only, never raw assertions/payloads. An identical deterministic assertion may fail closed on retry because a new gesture is not cryptographically distinguishable from replay. Add provider/concurrency coverage rather than treating counters as the only replay defense.

## Authenticated Sessions From the First Multi-User Milestone

Yes: sessions belong in the first multi-user implementation. A verified passkey assertion signs the user in; the session tells the backend which account later requests belong to. Without it, a browser-selected account ID cannot distinguish A from B. It also isolates pending signup, logout, reload and concurrent browsers.

Use opaque random session tokens in an HttpOnly cookie, with at least 256 bits of randomness and only a one-way token verifier stored server-side. Rotate the token on authentication; invalidate the anonymous token. Reject unknown, expired, revoked or fixed tokens. Local defaults are a 30-minute idle timeout and a 12-hour absolute lifetime, enforced by the backend. Logout revokes the server record and expires the cookie. Backend restarts may retain unexpired sessions through the database, but must rebuild verified vault capabilities from current evidence.

For localhost, use frontend `http://localhost:5173`, browser backend origin `http://localhost:8787` through `VITE_BACKEND_ORIGIN`, and backend sockets bound only to `127.0.0.1`. Both browser endpoints must use the same hostname; do not mix `localhost` and `127.0.0.1` and silently rely on cross-site cookies. Use `credentials: include` and exact local credentialed CORS. Cookies use `HttpOnly`, `SameSite=Strict`, `Path=/` and no `Domain`; the explicit HTTP-local profile uses a separate cookie name without `Secure` or the `__Host-` prefix. This exception is accepted only for the fixed loopback development profile. Future HTTPS uses a separately named `Secure` cookie and its reviewed deployment identity.

Protect state-changing requests with exact Origin/Host validation, JSON-only closed request schemas and a session-bound CSRF token. SameSite is additional protection, not the sole check. Do not log cookies, CSRF values, session tokens, credentials or assertion bodies. Tokens never appear in URLs or browser storage. Cookie sharing across tabs is normal: if another tab changes the signed-in account, stale requests must fail their account/session check, and late responses must not overwrite the active account.

Sessions authenticate application access only. They cannot replace a Safe transaction signature, satisfy a second-signature requirement, change policy/keys or authorize deployment inputs chosen by the browser. Login challenges are fresh backend-only authentication challenges and are never forwarded to a Safe/ERC-1271 message-signing path. Transaction approvals continue to use only the exact existing Safe transaction digest. A login assertion cannot authorize a transaction, and a transaction assertion cannot create a session.

## Action-Specific Authorization

A logged-in first-key session can view its own account, resume its own setup, read/reconcile its own transaction status and prepare supported human intents after fresh state verification. Preparing an intent or reading status is not approving it. Do not require the second signer to display a balance or explain an elevated action.

| Operation | Required authority |
| --- | --- |
| Sign in, view account, read own status | First-key authenticated session; no second signer prompt. |
| Base transfer within X and remaining shared Y | Session plus fresh exact first-key transaction approval. |
| Step-up transfer within shared Y | Session plus fresh first and configured second approvals over the exact transaction. |
| Queue above Y or delayed maintenance | Session plus both exact approvals; mandatory Z remains enforced. |
| Cancel/freeze and other existing dual-factor emergency actions | Session plus both exact approvals under the existing policy. |
| Execute ready queue item / skip expired item | Existing non-signing intent rules and exact queue checks; no new factor prompt where the existing policy permits permissionless execution. |
| Replace signer, broaden limits or change security policy | Existing reviewed delayed maintenance path; login alone has no authority. |

The current blanket `both recovered passkeys must be rebound` gate must be replaced at the responsible backend layer, not merely hidden in the UI. Authenticate/bind the first role on login. For elevated actions verify the second role against that account's reviewed key when its exact approval is requested; no separate generic second-key login ceremony is needed. When its credential reference is missing, learn it only after signature verification against that reviewed key. Each new elevated transaction still requires a fresh second approval. Public metadata, session booleans or a second signature from another account cannot substitute.

Account and credential identities are scoped persistently; challenges, prepared requests and approval payloads are additionally bound to the initiating browser session. Reconciliation after restart or a new successful first-key login may read the account's durable public hash/status. Unsubmitted approval payloads do not survive logout/restart or migrate into another session; a new attempt must recollect any required fresh approvals. An already recorded uncertain broadcast is reconciled by exact hash without another signature.

## Frontend and HTTP Isolation

All wallet state continues through `apps/app/src/lib/vault-store.tsx`. Screens do not compute authorization. `localStorage` may cache public UI/account references under environment/account keys; it is neither the account registry nor proof of authentication. Clearing it must preserve server data and allow first-passkey sign-in without re-registration.

Use explicit account/setup context on the registration, provisioning, preparation, approval, submit and status routes. The authenticated session resolves the permitted account; if a request also contains an account ID, require equality. Missing/unknown/mismatched contexts must not default to another account. Signup endpoints have only their bounded anonymous setup authority. Health/liveness can remain public without revealing other users' readiness, identities or balances.

Scope idempotency keys and journal lookups by account; bind active preparation/approval attempts to their session as well. One session's first-key sign-in does not authenticate another browser, and no process-global primary/secondary readiness flags remain. Clients cannot select paths, artifacts, policy, arbitrary contract identities, RPCs, gas, nonces or transaction calldata.

Expose backend-derived readiness separately: authenticated, setup pending, vault verified, write transport available, and approvals required for the selected action. Do not label a usable first-key account globally write-unready simply because the second signer has not been used in that session.

## Shared Payer and Deployment Queue

One shared payer cannot safely sign concurrent nonce-consuming work. Preserve its durable global coordination independently of account-specific journal paths.

- Queue provisioning by account; do not preplan multiple competing CREATE nonce layouts.
- Acquire the payer-wide lease before fetching the nonce that fixes a plan. Hold coordination across its complete seven-transaction deployment operation. Other users may register, sign in and read while waiting.
- Before any new payer signature, check unresolved durable hashes in all registered account journals and preserved legacy journals using a maintained index validated against the source records. A stale/missing/corrupt index cannot bypass the check. Independently inventory the managed evidence directory against registry rows; opening a missing registry with retained evidence, orphan account directories or mismatched paths must fail closed before any signature.
- Reconcile an uncertain transaction by its exact recorded hash. An incomplete immutable deployment retains its exact remaining nonce requirements. Another account cannot consume those nonces or trigger silent rebase/replacement.
- Preserve every dual-provider quote, runtime/topology check, six-confirmation requirement, per-plan outlay cap, authorization-before-signing and hash-before-broadcast boundary. Single-flight duplicate requests within the account.
- Durably record active payer/job ownership before work. A crash cannot hide unresolved work by losing an in-memory queue.

This local queue has deliberate head-of-line blocking when a payer transaction is uncertain or a bound deployment cannot safely continue. That is an operational limit, not an account-count limit. Relay pools or distributed workers require a separately reviewed design; do not add them here.

## Adoption, Recovery and Rollback

Adopt the configured existing deployment/submission paths as one account record, retaining every journal, review, authorization sidecar and historical reference byte-for-byte. Use existing exact recovery verification before issuing any current-profile capability. Historical read-only compatibility is per account, rather than a process-wide prohibition on creating another account.

Import/restart validation never trusts registry JSON, database keys or readiness flags as onchain evidence. Verify credential bindings, exact component identities, receipts and topology through existing production boundaries. If an existing credential ID is unavailable, first-key proof against reviewed coordinates may attach its ID; no new key may replace it. Adopt pending deployments as setup records and continue only their original verified lineage.

Database migrations and new file allocation occur outside the repository. Restore bounded recent submission references plus every unresolved hash reference in the authenticated account projection, so clearing browser storage never removes the UI path to exact-hash reconciliation. These references authenticate no action and remain account-scoped.

Record pending job/evidence references before broadcast, keep source evidence immutable, and reconcile crash points between database updates and journal writes using the exact durable hashes. Do not require an atomic transaction spanning SQLite and filesystem writes; explicitly test and recover each ordering without duplicate signing. Account publication requires final verified evidence, not a successful database write alone.

Rollback retains accounts, database, all journals and packages. Old singleton code may open only a separately selected preserved configuration, with all other writers stopped; it must not run concurrently with the multi-account coordinator. A database rollback never undoes chain transactions or restores consumed challenges/session tokens.

## Localhost Now; HTTPS Later

Localhost remains the exact supported origin/RP for this milestone: app `http://localhost:5173`, RP `localhost`, backend browser endpoint `http://localhost:8787`, backend socket `127.0.0.1`. No TLS certificate, tunnel, hosted database, public ingress or domain purchase is needed now. Keep backend secrets/config external and retain `VITE_BACKEND_ORIGIN` in the browser.

This still tests genuine multi-user behavior: separate browser profiles/contexts A, B and C share the same backend/database. Crypto tests can represent the same first credential in two authenticator contexts and prove that it opens the same account after storage reset. Those tests establish application behavior, not actual cloud-provider sync or phone access.

A different physical device's `localhost` points to that device. It cannot reach this machine's backend merely because a passkey synced. Actual remote-device/browser/provider proof remains a later HTTPS milestone against a shared service, with the existing ingress, monitoring and live gates. Do not weaken loopback binding to claim that gate passed.

A future public RP is a new identity. Localhost credentials are not assumed usable on the public domain; plan fresh registration and separately reviewed account migration if needed. Do not promise automatic credential portability or silently replace deployed signer keys. The current HTTPS auto-provision route remains disabled until its own gate is explicitly approved.

No Solidity, signature-format, Safe topology, WalletConnect, account-abstraction or mainnet change is part of this design. Independent review/audit and live gates remain required before production claims.

## Acceptance Evidence

- A, B and C independently register distinct pairs; each receives its own account and verified Safe without process/configuration changes. Interleaved ceremonies never share roles or challenges.
- Account storage/query tests cross an arbitrary small former-demo threshold using paginated fixtures, without introducing another total count constant. Real deployment tests retain reviewed resource budgets.
- Clear A's cookies and browser storage; select A's discoverable synced first credential and sign in to A without a new registration, Safe address entry or second-signer prompt. B/C data is unchanged.
- Represent the same first credential in another authenticator/browser context; preserve its account mapping. Unknown credentials, wrong user handles, second-only credentials and changed RP/origin cannot sign in.
- New account registration creates discoverable credentials without a forced platform-only transport. Provider backup flags/all-zero counters work under reviewed verification; nonzero counter anomalies, challenge replay and concurrent lost counter updates fail closed.
- Logout, expiry, revoked/fixed/stolen lookup identifiers and cross-account cookie/ID combinations cannot access account endpoints. Login and transaction challenges cannot substitute for one another. Cross-origin/CSRF requests reject.
- With only the first credential used in a session, account view, status and actual base-tier transfer succeed. Missing/wrong/replayed second approvals still prevent step-up, queue, cancellation and maintenance when required.
- A valid first-plus-second approval from A cannot approve any B transaction. Switching account invalidates outstanding UI responses and approval contexts; another tab's cookie change cannot submit the old account's request.
- Same idempotency key in A and B resolves only their respective intents. A new session can reconcile A's durable uncertain hash without acquiring old approval payloads or signing again.
- Simultaneous provisioning requests serialize before nonce planning. Restart with completed A and unfinished B restores each correctly and resumes only B's exact lineage.
- Uncertain work in A blocks new payer signatures for B before/after restart. Corrupt/missing journal/index entries, lock contention and crashes between database/journal updates cannot hide it.
- Import current and historical records without modifying their evidence. Historical read-only A does not globally block new B; malformed evidence cannot issue a writable capability.
- Update affected specifications, `docs/security/signer-provider-evaluation.md` and `docs/security/call-graph.md`; add adversarial account/session/action tests and retain real-cryptography backend/app/core provisioning/submission gates. Review/pin any database dependency.
- Record actual cloud sync, second-device access, HTTPS/mobile, independent monitoring and live receipts separately. Local tests cannot close those gates.

## Decisions and Delivery Boundary

**Confirmed by the user:** independent multi-user accounts, no hardcoded account limit, synced first passkeys, first-key-only sign-in, second signer only for policy-required actions, and localhost-first delivery.

**Selected technical defaults:** local SQLite plus preserved execution journals; first credential maps to one independent account; discoverable first-key registration; opaque cookie sessions; the local expiry values above; one shared payer queue; lazy verification of selected accounts. The implementation plan must settle driver/version, schema/migration layout and exact closed route names without changing these security boundaries.

The user subsequently authorized local implementation. This does not authorize live deployment, ingress changes, funding or transfers. Real-device/cloud-provider acceptance and external review remain separate gates.

## Primary References

- [W3C WebAuthn Level 3](https://www.w3.org/TR/webauthn-3/): discoverable authentication, user handles, verification, backup metadata and counter considerations.
- [Passkeys.dev terminology](https://passkeys.dev/docs/reference/terms/): synced credentials and provider availability.
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet): opaque server sessions, cookie controls, token rotation, expiry and revocation.
- [W3C Secure Contexts](https://www.w3.org/TR/secure-contexts/): loopback development origins. This allowance is not a public HTTP deployment model.
