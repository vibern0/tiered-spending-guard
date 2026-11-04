# Base-Lane Open-Destinations and PWA Submission Design

**Status:** Proposed policy amendment
**Date:** 2026-11-04

## Intent

Fix the unusable Phase One send journey without hiding a policy change:

1. A healthy base-tier USDC transfer, approved by the first signer only, may use any valid non-zero recipient address.
2. Step-up and delayed transfers remain restricted to the onchain recipient allowlist.
3. Adding a recipient remains a security-weakening change: it is a delayed, primary-plus-secondary operation. The PWA must expose that operation instead of an unsigned draft.
4. The normal backend entrypoint must either install the reviewed submission runtime or fail its health check before the browser enables Send. It must never expose a route that predictably returns `submission preparation unavailable` after a user starts approval.

This is a testnet-only research amendment. It does not authorize mainnet, WalletConnect, ERC-4337, generic messages, arbitrary calls, native transfers in the PWA, or a backend authorization bypass.

## Security statement

This deliberately weakens the first-signer compromise bound in one dimension: a compromised primary can direct up to the existing onchain X allowance to any USDC address rather than only a pre-approved address. It does **not** change the amount, period, per-transfer cap, selected token, exact `transfer(address,uint256)` selector, `CALL` operation, Safe transaction binding, or primary-signature requirement. It does not let a primary spend above X, bypass Y, use a step-up lane without a secondary, queue an unapproved delayed recipient, modify policy, call an arbitrary contract, or create an approval/message/delegatecall path.

Existing deployed guards cannot be changed in place. A fresh Sepolia vault profile and deployment is required for this behavior; an existing vault retains its current recipient policy and must be shown as incompatible rather than being misclassified by the UI.

## Goals

- Classify a first-signer USDC transfer to any valid non-zero address as `base` when it fits X, Y, the configured base per-transfer cap, and available balance.
- Require an onchain allowlisted recipient for every `step-up` and `delayed` transfer.
- Preserve delayed, primary-plus-secondary recipient additions. The browser may supply only one candidate address; it may not supply calldata, policy values, Safe/Delay address, nonce, signatures, or a recipient list.
- Make the send action usable only when the backend has a real reviewed submission runtime. A backend with no runtime must advertise that it is not write-ready before the app enables Send.
- Prepare, revalidate, sign, broadcast, reconcile, and observe only closed exact intents through `apps/backend`.
- Update the call graph and adversarial tests for each new/existing execution path affected by the change.

## Non-goals

- An in-place migration of an existing deployed guard or its policy.
- Removing the recipient allowlist from step-up or delayed spending.
- A direct/instant recipient addition, removal of all recipients, or a broad editable protection form.
- Browser-side transaction construction, relay keys, generic provider access, or browser-controlled chain policy.
- Changing X/Y/Z caps, signer roles, Safe ownership, modules, fallback handler, or dependency versions.
- Hiding unavailable live transport behind optimistic UI or a placeholder runtime.

## Approaches considered

### 1. Keep allowlisting in every lane

Rejected by the user. It preserves the prior threat model but does not satisfy the requested one-signer send behavior.

### 2. Open the base lane; retain elevated recipient controls — selected

The guard and its policy classifier distinguish the base lane from step-up/delayed paths. Base only checks a valid non-zero recipient while elevated paths require membership in the exact per-asset recipient list. Recipient additions remain delayed maintenance requiring both signers. A fresh Phase One vault profile records this policy version.

This delivers the requested payment flow while preserving a recipient control where the extra signer and delay provide more protection.

### 3. Remove recipient controls entirely

Rejected. It would also weaken step-up and delayed transfers and make recipient addition meaningless.

## Architecture

```text
browser intent { transfer, recipient, amount }
        |
        v
apps/backend: server-held vault + fresh pinned chain snapshot
        |
        +-- base candidate: valid non-zero recipient; primary approval only
        |
        +-- step-up / delayed candidate: recipient must be in guard policy
        |
        +-- recipient addition: one candidate recipient only
        |       -> exact guard repairPolicy wrapped by Delay
        |       -> primary, then secondary, then delay Z
        v
exact Safe / Delay transaction + durable submission journal
        |
        v
guard and Delay enforce onchain policy; observer verifies receipt
```

The security core introduces an explicit recipient mode in the asset policy instead of treating an empty list as unrestricted. The new Phase One profile pins `baseRecipientMode: "any-valid-address"` and preserves a non-empty `elevatedRecipients` list. The Solidity guard must enforce that exact distinction, and all frontend/backend/core snapshot models must carry it from fresh verified onchain reads. Existing profiles without that explicit mode are rejected as incompatible.

The backend starts a concrete runtime only when it can construct all of the existing closed boundaries: fresh two-provider state snapshot, `preparePwaIntent`, simulation/revalidation, server-side WebAuthn verification, canonical Safe contract-signature encoding, `validateAndBroadcast`, durable exact outer-hash reconciliation, and separate read-only receipt observation. The runtime has no fallback implementation. Startup and `/health` expose an explicit `writesReady: false` condition if that complete composition is unavailable; the app blocks Send before preparation.

Recipient addition is represented as a new closed submission kind. The app collects and validates one address, but the backend re-reads the current policy, rejects zero/duplicate candidates, derives the complete replacement list from chain state, constructs the exact delayed `repairPolicy` tuple, and uses the same primary-then-secondary journal flow. The UI presents the item as a delayed policy change and does not optimistically change the recipient list.

Each recipient-addition proposal binds the current policy version/hash and must fail at execution if that state has changed during Z. It is never valid to apply a stale full-policy replacement: doing so could restore a limit that was tightened or discard a concurrent recipient change. A stale queued addition stays visible as non-executable; creating a replacement requires a fresh chain snapshot and both approvals.

## Compatibility and deployment

- This requires a fresh guard deployment because the existing implementation has no per-tier recipient mode.
- The committed Phase One profile, topology verifier, deployment package, and policy hash must identify the new mode. Existing profile/hash pairs fail closed.
- An old vault remains readable. Its send screen must say that it uses the prior all-lanes allowlist policy and must not offer an arbitrary-recipient base send.
- No profile may silently infer open base recipients from an empty list.

## Test and evidence requirements

- Solidity unit, integration, and invariant tests prove a base transfer to a non-allowlisted valid recipient succeeds only with the primary and consumes both X and Y; zero/invalid values and every non-transfer path fail.
- Tests prove the same recipient cannot use step-up or delayed lanes until a delayed recipient-addition transaction is executed; a primary-only policy-change attempt, altered recipient list, altered nonce, altered inner tuple, or changed policy version during Z fails.
- Core PWA-intent tests prove fixed/stale/legacy profile rejection, exact recipient-mode projection, and correct lane construction.
- Backend tests prove normal startup either provides the full runtime or makes health/write readiness unavailable; no user can reach the legacy unavailable-preparation response from an enabled Send action.
- Browser tests cover manual arbitrary base recipient, elevated-recipient guidance, recipient-addition review/approval/queue lifecycle, backend-not-ready block, and no optimistic policy mutation.
- Call-graph and adversarial tests cover base-open, elevated-closed, delayed addition, old-profile rejection, stale snapshot, duplicate submission, altered digest, and revalidation before broadcast.
- A fresh low-value Sepolia vault must complete base-to-unlisted, recipient addition, step-up-to-newly-listed, and delayed-to-newly-listed receipt/observer evidence before any user-facing claim that the flow works.

## Stop conditions

- Any implementation that accepts an empty recipient list as an implicit wildcard.
- Any base path that accepts arbitrary calldata, tokens, value, operation, gas/refund fields, signer, or Safe identity.
- Any path that makes recipient addition immediate, primary-only, browser-constructed, or non-durable.
- Any attempt to enable the default backend runtime without the complete reviewed preparation, revalidation, broadcast, reconciliation, and observer composition.
- Any need for new security-critical Solidity beyond the approved `TieredSpendingGuard` and its existing internal helpers.

## Documentation amendment

Upon implementation, the research baseline, security-core plan, PWA Phase One design/profile, call graph, and app/backend documentation must replace their all-lanes recipient-allowlist statement with this precise rule: **base first-signer USDC transfers accept any valid non-zero recipient; step-up and delayed transfers require an allowlisted recipient; recipient additions are delayed primary-plus-secondary policy changes.**
