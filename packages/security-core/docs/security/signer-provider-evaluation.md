# Signer Provider Evaluation

**Status:** Security-core design note
**Date:** 2026-09-16

## 2026-10-19 native-profile amendment

The approved native candidate uses contract passkeys only: the primary is the sole active Safe owner and the distinct secondary is guard-only. No ECDSA secondary, dummy EOA, user EOA, application relay/deployment key, WalletConnect path, or alternate custody account is allowed. During locked bootstrap only, Safe's shared WebAuthn signer may own the Safe for the committed primary key; exact nonce-0 activation must replace it with the same key's credential-specific signer. The restricted fallback handler validates the outer EntryPoint 0.8 user-operation signature but exposes no general execute or ERC-1271 message API. Provider and sponsor acceptance remain unproven until real quotes, validation traces, inclusion receipts, browser requests, and bounded-policy tests exist.

This amendment supersedes the stock Safe4337Module and nested owner-call transport described in older notes. The ordinary Safe live gate and `apps/backend` remain in force until their documented replacement gates pass.

## 2026-10-09 active design

Primary passkey: sole Safe owner, threshold 1. Contract/ECDSA secondary: guard-only approval over the exact Safe transaction digest; Safe ownership is not required. The earlier three-owner implementation notes below are historical. Preserve the provider-neutral request binding and non-WalletConnect boundary. Direct Burner NFC and device-passkey UX are unverified; automated live tests must use real WebAuthn cryptography and real passkey contracts, never permissive mocks. The funded test EOA is a gas/deployment payer, not a vault authorizer.

This project should not choose an embedded-wallet or account-abstraction provider as the security baseline. The baseline is the verified Safe/Zodiac topology:

- Safe-native passkey support for the convenient signer
- Safe-native passkey support for a YubiKey-backed secondary signer
- Reviewed non-WalletConnect signing for Burner and other hardware wallets as ECDSA secondary signers
- `TieredSpendingGuard` and Zodiac Delay as the onchain policy authority
- Post-deployment topology verification before meaningful funds are deposited

Provider SDKs are useful only if they fit inside that topology.
WalletConnect is not part of the accepted prototype boundary.

The EURC browser demo uses `@simplewebauthn/browser@14.0.0` only for platform
registration and assertion transport. The backend supplies the challenge and
validates the resulting credential against the configured RP ID, origin,
Safe, chain, and exact Safe transaction digest. The browser adapter emits
only Safe's ABI-encoded WebAuthn payload; it does not persist credentials,
assertions, relay keys, or create an account outside the verified Safe.

## Baseline decision

The first security-core prototype uses Safe-native passkey contracts and a generic EIP-1193 signer boundary. This keeps the custody graph small enough to verify and avoids coupling the core vault to a vendor account model.

2026-10-01 update: the active Option B prototype has a primary passkey signer and two configured secondary signer forms: a YubiKey-backed Safe-contract passkey signer and an ECDSA secondary extension. 2026-10-07 update: the ECDSA secondary must not use WalletConnect. The previous offline recovery EIP-1193 role is deferred, and no `createRecoverySigner` adapter is exported. This accepts a testnet denial-of-service tradeoff: loss of the primary passkey or all configured secondary factors can block operation until a future delayed recovery design is reviewed and implemented. That risk is intentionally narrower than keeping a recovery signer path that could become an immediate policy bypass.

## Implemented signer boundary

Task 8 implements the provider-neutral boundary in `src/signers/types.ts`. A signer receives one immutable request containing `chainId`, the configured Safe, the exact `safeTxHash`, and the complete `SafeTx` EIP-712 typed data. The adapter rejects mismatched chain/Safe/domain/hash data before provider interaction and verifies provider state again after signing. No seed, passkey credential, Burner PIN, provider token, or RPC credential is accepted or logged by this boundary.

The passkey adapter accepts only the reviewed Safe-native WebAuthn raw signature. Its `deployments` input must be the resolver-branded aggregate returned by the official deployment-verification boundary; it then selects the factory-bound `passkeySigner` instance and retains exact verified evidence, runtime-code-hash, factory-binding-hash, and configured-passkey address checks (the P-256 verifier is infrastructure, not the credential-specific Safe owner). Cloned aggregates or caller-supplied `evidence: "verified"` and hashes are rejected before provider interaction. It also requires `deployments.chainId` to equal the request chain before signing. Before signing and after verifier `eth_call`, it pins the provider chain to the request chain, then queries ERC-1271 at that exact address with the exact Safe transaction hash and raw signature. It emits exactly one canonical Safe contract-signature slot: configured signer address, `v = 0`, `s = 65`, and the length-prefixed raw WebAuthn payload. It does not accept a caller-supplied verifier callback, ECDSA, approved-hash, or arbitrary message signatures. All adapters reject non-canonical SafeTx domain keys, `SAFE_TX_TYPES`, `primaryType`, message keys, or value types before calling a provider.

The role-neutral passkey adapter can be configured as the primary Safe-contract signer or as the YubiKey Safe-contract secondary signer. The ECDSA secondary adapter must use a reviewed non-WalletConnect boundary, request only `eth_signTypedData_v4`, verify the selected account and chain before and after the request, recover the EOA locally from the exact typed data, reject user/provider failures and ambiguous injected-provider lists, and reject duplicate Safe transaction hashes. The adapter appends only the versioned `TieredSpendingGuard.EcdsaSecondarySignature.v1` terminal extension. Direct Burner NFC/libhalo signing remains a future spike; no direct NFC adapter or libhalo dependency is part of the active security-core prototype.

The adapters are transport components, not policy authorities. The deployed Safe 1.5 plus `TieredSpendingGuard` integration proves the matrix: primary-only base succeeds, each secondary alone fails, two secondaries without the primary fail, primary plus YubiKey succeeds within the shared immediate limit, primary plus a configured ECDSA secondary succeeds within the shared immediate limit, and delayed proposals are rejected before cooldown and execute after it.

Cometh Connect remains a credible future frontend/onboarding candidate because it supports WebAuthn, ERC-4337, and Gnosis Safe based smart wallets. It is not the default security dependency for the MVP. It may be added later as a provider adapter if it passes the acceptance tests below.

Pimlico and `permissionless.js` are account-abstraction infrastructure. They may help with bundlers, paymasters, gas sponsorship, and user-operation transport, but they are not the root policy layer.

Privy, Dynamic, Turnkey, ZeroDev, Kernel, Biconomy, Alchemy smart wallets, and similar systems should be evaluated by the same criteria. Their passkey support or gasless UX is not sufficient by itself.

## Acceptance tests for any provider

A provider adapter is acceptable only if it proves all of the following:

- It signs the exact Safe transaction typed data for the configured single Safe.
- The produced signature verifies against the expected Safe owner.
- It cannot switch chain, Safe, owner, account, or transaction hash after the user review step.
- It does not create a second smart account that holds assets outside the Vault Safe.
- It does not add or retain an unrestricted owner, module, session key, recovery path, relayer authority, or message-signing path.
- It cannot bypass the primary-passkey-only X limit, the one-configured-secondary requirement above X, or the shared immediate Y allowance enforced through `TieredSpendingGuard`.
- It cannot bypass Zodiac Delay for transfers above Y or security-weakening changes.
- It exposes user rejection, provider account changes, chain changes, and signature failures as hard failures.
- It can be exercised in tests without relying on undocumented NFC, passkey, or hosted-service behavior.

If any provider requires a different onchain topology to work, stop and write a focused design proposal before implementation. Do not hide a topology change behind a frontend integration.

## Current recommendation

Start with:

1. Safe-native passkey adapter.
2. Safe-native passkey adapter configured as the YubiKey secondary.
3. Reviewed non-WalletConnect adapter for the ECDSA secondary.
4. Provider-neutral conformance tests against the exact transaction digest and signature formats accepted by `TieredSpendingGuard`.

Evaluate Cometh after the security core passes, as a frontend acceleration path rather than as the authority for custody policy.
