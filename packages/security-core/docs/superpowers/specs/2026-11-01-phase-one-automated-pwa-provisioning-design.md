# Phase One Automated PWA Provisioning Design

**Status:** Implemented Phase One amendment
**Date:** 2026-11-01

> **2026-11-01 dynamic-envelope and recovery amendment:**
> [Dynamic PWA Provisioning Envelope and Recovery Design](2026-11-01-dynamic-pwa-provisioning-envelope-and-recovery-design.md) is authoritative where this document previously described fixed per-transaction gas/fee caps, one seven-transaction approval, or a hard stop for every non-empty provisioning journal. Phase One now uses one dual-provider quote and one append-only authorization record per transaction, permits only an exactly verified confirmed prefix of length `1..6` to resume, and requires both recovered passkeys to rebind before any spending path is available.

## Intent

Make localhost Sepolia onboarding deploy the reviewed vault automatically after the secondary passkey is verified. Remove the unusable manual operator-file ceremony without pretending that backend-generated authorization is independent approval.

This amendment knowingly trusts the Phase One backend process for deployment authorization. It supersedes the earlier Phase One requirement for human review of each generated PWA deployment package. It does not weaken the deployed Safe policy, authorize mainnet, or describe the backend as independently secure.

## Goals

- Start provisioning automatically after successful secondary-passkey registration; no additional user click.
- Keep all browser inputs outside deployment addresses, policy, transactions, gas, fees, artifacts, and authorization.
- Preserve unsigned deterministic review-package generation before any broadcast.
- Generate one exact per-transaction authorization from a canonical dual-provider quote and the pending plan transaction.
- Recheck chain, nonce, code absence/presence, gas estimate, fee quote, reservation, receipts, and final topology.
- Keep the authorization source behind an interface that a later KMS/HSM-backed independent approver can implement.
- Remove `BACKEND_PROVISIONING_APPROVAL` and `BACKEND_PROVISIONING_APPROVAL_HASH_FILE` from Phase One configuration.
- Preserve durable-before-broadcast journaling and never retry an uncertain transaction blindly.

## Non-goals

- Protection from arbitrary code execution in the backend process or complete compromise of its host.
- Mainnet, production readiness, audit claims, remote deployment, or a public provisioning service.
- A KMS, HSM, TEE, remote approver, second RPC trust domain, or locked onchain bootstrap factory in this change.
- Recovery of anything except an exact, canonical, six-confirmation successful prefix of the reviewed seven-transaction plan.
- Automatic retry after an unknown broadcast outcome, nonce drift, code drift, fee-cap breach, failed simulation, or failed topology verification.
- Funding the resulting Safe or beginning the X/Y/Z rehearsal automatically.

## Security statement

The Phase One backend holds the relay key and produces the authorization consumed by its own deployment runner. Therefore its authorization is a consistency and bounded-cost mechanism, not independent approval. A compromised backend can bypass in-process checks, deploy a malicious account, and lie to the browser. The relay is not a Safe owner and cannot spend from a correctly deployed vault, but a malicious backend could present an incorrect deposit address. Use only Sepolia test assets and a deliberately limited relay balance. Do not treat the returned address as independently verified.

The honest implementation still fails closed against browser manipulation, ordinary bugs, stale chain state, duplicate execution, fee spikes, partial deployment, unexpected code, and topology mismatch.

## Approaches considered

### 1. Backend writes the old operator files

Rejected. Writing both the approval and the supposedly independent digest preserves ceremony but no independence. It would misdescribe the trust model.

### 2. Human two-phase operator CLI

Rejected for Phase One product flow. It preserves separation but cannot support automatic onboarding. The earlier design remains useful as research evidence, not the selected experience.

### 3. Backend-local authorizer behind a replaceable interface

Selected. The backend creates the deterministic plan, writes the unsigned review package, asks a narrow authorizer for an exact canonical authorization, then invokes the existing durable executor. Phase One uses a committed-policy implementation in the same process. A later external implementation returns a signed KMS/HSM attestation over the same authorization fields.

### 4. Locked onchain bootstrap factory

Deferred. This can provide stronger enforcement than an offchain approver, but it adds security-critical Solidity and belongs to the separately gated native Safe design.

## Architecture

```text
secondary passkey verified
          |
          v
browser automatically POSTs /v1/vaults/auto-provision with an empty body
          |
          v
backend loads both server-held verified credentials
          |
          v
security-core resolves committed Sepolia plan and writes unsigned review package
          |
          v
ProvisioningAuthorizer.authorizeTransaction(plan, nextTransaction, quote, budgetFacts)
          |
          +-- Phase One: committed local caps, same backend process
          +-- Future: verified signed KMS/HSM attestation
          |
          v
append-only authorization sidecar + durable executor
          |
          v
receipt/runtime checks after each transaction
          |
          v
full final topology verification
          |
          v
only verified public vault projection returned to the browser
```

## Authorization boundary

The provider-neutral `ProvisioningAuthorizer` consumes the branded `PwaProvisioningPlan`, its next exact transaction, the confirmed journal prefix, one canonical dual-provider quote, and aggregate budget facts. It returns the exact transaction envelope to sign. It has no relay account, private key, signing callback, broadcast callback, journal writer, or browser input.

The Phase One implementation accepts only:

- chain ID `11155111`;
- the committed PWA profile and fixed Safe proxy salt `0`;
- exactly seven ordered transaction IDs: `primary-signer`, `secondary-signer`, `setup-helper`, `guard`, `delay`, `maintenance`, `safe-proxy`;
- each plan transaction's exact nonce;
- the existing aggregate Phase One outlay ceiling of `0.05 ETH`.

The authorizer returns no arbitrary field. Each authorization binds the package, plan, immutable transaction, common quote block, both committed provider observations, the 30% policy margin, exact signed EIP-1559 fields, and prior/resulting budget facts. It is persisted before signing in a versioned append-only sidecar. This is backend-local consistency and cost evidence, not independent approval.

## Gas and fee handling

The committed Sepolia automation artifact contains ratios and economic bounds, not contract-specific gas constants: 30% gas/fee margin, 10% maximum estimate divergence, maximum two-block quote lag, six confirmations, and the `0.05 ETH` aggregate outlay ceiling.

Before each signature, the executor must:

1. recheck the exact pending plan transaction and deployer nonce;
2. recheck all prior expected runtimes and all future code absence;
3. make both committed providers agree on chain, common canonical block/hash, and exact nonce;
4. estimate the same transaction on both providers and reject divergence above 10%;
5. set the exact gas limit to the higher estimate plus 30%, and derive EIP-1559 fields from the common base fee and higher observed tip plus 30%;
6. require the relay to agree on the quote-block hash and exact latest/pending nonce;
7. recheck confirmed actual cost plus pending/new reservation against `0.05 ETH` and relay balance against pending/new reservation;
8. persist the exact authorization record, then sign only that envelope.

Later transactions are checked only after earlier receipts have six confirmations and their canonical block identity and runtimes are re-read, allowing state-dependent Safe-proxy estimation without trusting a pre-deployment aggregate estimate. A receipt with fewer than six confirmations never advances the sequence.

## Backend API and state

Remove the browser-facing plan/execute pair from the supported onboarding path. Add one closed endpoint:

```text
POST /v1/vaults/auto-provision
body: {}
```

The endpoint accepts no package hash or deployment field. It loads the two server-held verified credentials and calls one single-flight provisioning operation. Concurrent or repeated calls return the same in-flight result or the already verified vault; they never create a second plan. The route is available only when `BACKEND_PROFILE=local`; HTTPS-profile provisioning is unavailable until its separate mobile/ingress gate is redesigned for the future independent authorizer.

After the browser successfully verifies the secondary registration, it stores the public secondary credential ID locally and immediately calls this endpoint. Normal success requires no additional click. The UI displays `Provisioning and verifying…` until the endpoint returns the final verified projection.

If provisioning fails before a durable transaction hash, the UI displays the fail-closed error and may explicitly retry the same closed operation. A pending or uncertain broadcast permits reconciliation only and never a replacement signature or blind rebroadcast. On restart, an empty journal starts normal onboarding; an exact successful prefix of length `1..6` is rebuilt and verified through both committed providers, the unique review package, onchain transactions/receipts, intent hashes, runtimes, future code absence, and latest/pending relay nonce. Any other non-empty journal hard-stops. Startup itself never broadcasts; the empty auto-provision request resumes the first missing transaction.

## Configuration migration

Remove these required settings:

```text
BACKEND_PROVISIONING_APPROVAL
BACKEND_PROVISIONING_APPROVAL_HASH_FILE
```

Retain:

```text
BACKEND_RELAY_PRIVATE_KEY
BACKEND_RPC_URL
BACKEND_PROVISIONING_REVIEW_DIRECTORY
BACKEND_PROVISIONING_JOURNAL_PATH
```

The review package and journal remain outside the repository. Existing approval files are neither read nor deleted. Startup rejects the retired approval settings so operators cannot believe they still authorize deployment.

## Browser behavior

- Secondary registration success immediately transitions to `provisioning`.
- The old `ready-to-plan`, `awaiting-operator`, and `approved` states are removed from the supported flow.
- No plan, refresh-approval, or provision button remains.
- The browser never receives the automatic authorization, raw deployment transactions, relay key, or journal.
- Wallet configuration is persisted after the backend returns verified final topology evidence. A recovered vault then prompts `Verify first signer` and `Verify second signer`; all spending paths remain blocked until both assertions rebind to the reviewed public keys.
- Failure leaves public credential progress visible and the wallet unfunded/unready.

## KMS/HSM migration

The future external authorizer implements the same interface through a signed attestation. Its signature binds at least:

- chain ID;
- code/profile revision;
- package and plan hashes;
- deployer and starting nonce;
- ordered transaction identities and hashes;
- gas and fee ceilings;
- total reservation ceiling;
- issuance time, expiry, and unique authorization ID.

The backend will trust a pinned approver public key, reject replayed/expired attestations, and still perform every pre-broadcast and post-receipt check. The KMS service receives no relay key and cannot broadcast.

## Testing and evidence

- Unit tests prove the automatic authorizer accepts only the exact seven-row plan and committed caps.
- Mutation tests cover package, plan, transaction order, nonce, gas, fee, chain, and unknown fields.
- Provisioner tests prove review-package write precedes authorization and authorization precedes signing.
- Backend tests prove the endpoint accepts only `{}`, single-flights duplicates, and never consumes browser deployment fields.
- UI tests prove secondary registration automatically provisions and persists configuration only after verified completion.
- Execution tests prove per-step estimate/fee checks, the `0.05 ETH` ceiling, durable pending hash, reconciliation-only uncertainty, runtime checks, and final topology verification.
- Documentation and call graph explicitly label Phase One authorization as backend-trusted and non-independent.

## Stop conditions

- Any need for caller-selected addresses, calldata, policy, nonce, artifact, gas, fee, or authorization.
- Any mainnet chain ID or non-Sepolia dependency.
- Any transaction outside the exact seven-row catalog.
- Missing review artifact, journal lock, simulation, fee data, receipt, runtime evidence, or final topology proof.
- Any attempt to auto-retry an uncertain broadcast.
- Any requirement for new custom Solidity outside the separately approved native Safe scope.

## Delivery boundary

This change ends when clean localhost onboarding automatically reaches a verified Sepolia vault after the second passkey, with no approval files and no manual provisioning action. Funding, X/Y/Z rehearsal, notifications, KMS deployment, HTTPS/mobile provisioning, and production hardening remain separate work.
