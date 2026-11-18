# Secondary Signer Design

**Status:** Design proposal
**Date:** 2026-10-01
**Scope:** Future signer-model change after PR #6, not part of the current two-owner atomic deployment transport.

## Goal

Support a vault where the primary instant signer is a device passkey, and the required step-up signer can be either a YubiKey-backed passkey or a Burner hardware wallet. The user-facing concept should become "primary approval plus secondary approval," not "passkey plus Burner."

The design must preserve the existing security properties:

- one asset-holding Safe;
- onchain X/Y/Z enforcement by `TieredSpendingGuard`;
- exact authorization bound to chain, Safe, destination, value, calldata, operation, gas/refund fields, and nonce;
- no unrestricted owner, module, fallback, approval, Permit/Permit2, arbitrary message, approved-hash, or broad recovery path;
- mandatory Delay for transfers above Y and for security-weakening changes.

## Current Baseline

PR #6 narrows the active prototype to exactly two Safe owners: the configured passkey signer and the configured Burner signer. The Burner role is currently an ECDSA/EIP-1193 signer path that returns a terminal guard extension over the exact Safe transaction hash.

That model does not accept a YubiKey passkey as a drop-in Burner replacement, because a YubiKey passkey is a WebAuthn credential verified through Safe-native passkey and ERC-1271 paths rather than an Ethereum ECDSA account exposed through `eth_signTypedData_v4`.

## Proposed Model

Replace the hard-coded "Burner" role with a "secondary signer" role.

```text
Primary signer:
  device passkey signer contract

Secondary signers:
  YubiKey passkey signer contract
  Burner ECDSA signer

Guard policy:
  base transfer      primary only, within X and Y
  step-up transfer   primary plus one configured secondary, within Y
  delayed proposal   primary plus one configured secondary, queued through Delay
```

The Safe can still use threshold 1, but the guard remains the policy authority. A secondary signer alone must never authorize a transfer. Primary plus an unconfigured signer must fail. Two secondary signatures without the primary must fail.

## Contract Boundary

`TieredSpendingGuard` should store one primary signer and a bounded set of configured secondary signers.

Suggested role model:

```solidity
enum SignerRole {
    Primary,
    Secondary
}

enum SignerKind {
    SafeContractSignature,
    EcdsaExtension
}

struct SignerConfig {
    SignerRole role;
    SignerKind kind;
    bool enabled;
}
```

For step-up and delayed proposal paths, the guard requires:

- the Safe-validated signature slot to name the configured primary passkey signer;
- one valid secondary approval over the exact Safe transaction hash;
- the secondary approval to match an enabled secondary signer and its configured signer kind.

For a YubiKey passkey secondary, the secondary approval should be another Safe contract-signature slot that Safe validates through the configured ERC-1271 passkey signer contract.

For a Burner secondary, the secondary approval remains a terminal ECDSA extension signed by the Burner address over the exact Safe transaction hash.

The guard must reject duplicate, ambiguous, trailing, or mixed-kind secondary encodings. It must also reject approved-hash signatures and arbitrary Safe message signatures.

## Offchain Signer Boundary

The TypeScript signer boundary should become role-neutral.

Suggested shape:

```ts
export type SignerRole = "primary" | "secondary";
export type SignerKind = "safe-contract" | "ecdsa-extension";

export type VaultSigner = Readonly<{
  address: Address;
  role: SignerRole;
  kind: SignerKind;
  sign(request: SafeSignerRequest): Promise<Hex>;
}>;
```

Adapters:

- `createPasskeySigner`: Safe-native passkey/ERC-1271 contract signature. Usable as primary or secondary when configured for that role.
- `createBurnerWalletConnectSigner`: existing EIP-1193 / WalletConnect typed-data path for Burner.
- `createBurnerDirectSigner`: optional future adapter using documented Burner/HaLo signing primitives only.

The adapter must not accept seed phrases, private keys, passkey material, Burner PINs, provider tokens, or private RPC credentials as repository inputs. User rejection, provider account changes, chain changes, wrong recovered account, duplicate transaction hash, and malformed signatures remain hard failures.

## Direct Burner Integration

Direct Burner support is acceptable only if the implementation uses documented signing primitives and preserves the same authorization semantics as WalletConnect.

Minimum acceptance criteria:

- use an official or documented Burner/HaLo signing interface;
- produce a normal Ethereum ECDSA signature recoverable to the configured Burner address;
- sign the exact Safe transaction hash or EIP-712 typed data that hashes to it;
- verify the recovered address locally before returning a guard extension;
- expose user rejection, password/PIN failure, card absence, wrong key slot, and unsupported firmware as hard failures;
- never export, log, or derive raw private key material;
- never bypass the Burner card's password/PIN or confirmation behavior;
- never rely on undocumented NFC commands or reverse-engineered firmware behavior.

The current research notes already identify Arx `libhalo` as prior art: its documented command set includes EIP-712 typed-data signing and raw secp256k1 digest signing. That is promising, but it is not enough by itself. A direct Burner adapter needs a small spike to prove that the exact Safe transaction request can be signed, recovered, and accepted by the guard without changing the custody graph.

Until that spike passes, WalletConnect remains the supported Burner path.

## Topology Options

### Option A: Two Safe Owners, Secondary Chosen at Setup

Owners are `[primaryPasskey, selectedSecondary]`.

This is closest to PR #6. It supports either device passkey plus YubiKey, or device passkey plus Burner, but not both at the same time without delayed signer rotation.

Pros:

- smallest owner set;
- easiest topology verification;
- narrowest PR #6 follow-up.

Cons:

- switching between YubiKey and Burner requires delayed maintenance;
- less convenient for users who want both secondary devices active.

### Option B: Three Safe Owners, Either Secondary Accepted

Owners are `[primaryPasskey, yubikeyPasskey, burner]`.

The guard enforces primary plus any one enabled secondary for step-up and delayed proposal paths.

Pros:

- matches the desired "YubiKey or Burner" experience;
- improved availability if one secondary is unavailable;
- no immediate signer rotation needed for ordinary use.

Cons:

- larger signer surface;
- security is bounded by the weaker secondary path;
- every owner/module/topology verifier must prove that neither secondary can spend alone.

### Option C: Configured Secondary Registry, Not Necessarily Safe Owners

The Safe owner set remains minimal, and the guard verifies secondary approvals independently through configured verifier contracts or ECDSA recovery.

Pros:

- most flexible long term;
- can support future signer kinds without owner churn.

Cons:

- more custom security-critical logic;
- may diverge from Safe-native validation;
- higher audit burden.

## Recommendation

Use Option B for the product direction, but implement it only after PR #6 is stable and separately reviewed.

Option B gives the user-visible model the project wants:

```text
daily payments:       device passkey
larger instant spend: device passkey + YubiKey or Burner
large/weakening ops:  device passkey + YubiKey or Burner, then Delay
```

Use Option A only as a smaller intermediate if the team wants to land YubiKey-secondary support before supporting multiple active secondary factors.

Do not start with Option C. It is attractive, but it expands custom authorization code before the simpler Safe-owner model has been proven.

## Testing Requirements

Add tests before implementation.

Required cases:

- primary-only base succeeds within X and Y;
- primary-only step-up fails;
- YubiKey secondary alone fails;
- Burner secondary alone fails;
- YubiKey plus Burner without primary fails;
- primary plus YubiKey succeeds within Y;
- primary plus Burner succeeds within Y;
- wrong YubiKey passkey fails;
- wrong Burner ECDSA signer fails;
- disabled secondary fails;
- duplicate secondary signatures fail;
- mutation of chain, Safe, target, value, calldata, operation, gas/refund fields, or nonce fails;
- direct transfer above Y fails;
- primary plus each secondary can queue the exact delayed action;
- delayed execution still requires the verified Delay path;
- secondary signer rotation is delayed when it broadens capability;
- removal or disabling of a secondary may be immediate only if mechanically tightening.

Run the existing guard, topology, signer-flow, adversarial, invariant, rehearsal, Slither, and package-generation gates after the change.

## Documentation Updates

Implementation must update:

- `docs/research/2026-09-16-personal-vault-research.md`;
- `docs/security/call-graph.md`;
- `docs/security/signer-provider-evaluation.md`;
- `docs/security/testnet-runbook.md`;
- `docs/security/dependency-review.md` if adding `@arx-research/libhalo` or any Burner direct dependency;
- the active implementation plan or a new plan that supersedes the signer sections.

The language should change from "Burner is required above X" to "one configured secondary signer is required above X," with Burner listed as one supported secondary kind.

## Open Questions

1. Should the first implementation support both secondary signers active at once, or only one selected secondary?
2. Should direct Burner support start as a throwaway spike before becoming a dependency?
3. Should the YubiKey secondary be required to be hardware-bound and non-synced, or is any WebAuthn credential acceptable for testnet?
4. What is the maximum number of secondary signers before the UI and verifier become too complex for the first product pass?

## Decision Gate

Do not implement this proposal until the team explicitly chooses Option A or Option B and approves a task-by-task implementation plan.

Direct Burner work must pass a separate spike first. If that spike cannot prove exact Safe transaction signing through documented Burner/HaLo APIs, direct Burner support stays out of scope and WalletConnect remains the only Burner transport.

## References

- Burner WalletConnect help: https://help.burner.pro/en/articles/10074232-how-to-connect-your-burner-wallet-to-a-dapp-with-walletconnect
- Burner key model: https://help.burner.pro/articles/why-doesn-t-burner-have-a-seed-phrase-and-how-is-my-private-key-secured
- Arx `libhalo` repository: https://github.com/arx-research/libhalo
- HaLo command set: https://github.com/arx-research/libhalo/blob/master/docs/halo-command-set.md
