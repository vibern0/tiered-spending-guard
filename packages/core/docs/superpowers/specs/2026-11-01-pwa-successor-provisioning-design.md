# PWA Successor Provisioning Design

**Status:** Approved for one Sepolia testnet recovery
**Date:** 2026-11-01

## Intent

Finish the current PWA vault after unrelated relay transactions consumed nonces `961`, `962`, and `963`. Preserve the confirmed signer deployments at nonces `959` and `960`; derive setup-helper through Safe from current nonce `964`; never rewrite the original journal or treat unrelated transactions as deployment progress.

## Constraints

- Sepolia `11155111`; profile `sepolia-pwa-phase-one-v1`; local backend only.
- Original package `0xb307bb0656badfbeed91e9a4df500f31c85482563bb908010a85ef1f807d49bc`.
- Confirmed signer prefix length `2` remains canonical.
- Consumed transactions are public committed evidence, not authority or budget credit.
- Both committed providers verify each consumed transaction, successful canonical receipt, six confirmations, sender, chain, type, nonce, and cross-provider equality.
- Consumed transactions must differ from the old planned transaction at the same nonce. Old and successor future addresses must contain no code.
- Relay `latest` and `pending` nonce must equal `964` before successor creation and before every later authorization.
- Successor review remains unsigned/reproducible. Dynamic dual-RPC 30% envelopes, 10% divergence, append-only authorization sidecar, six confirmations, exact runtimes, final topology, `0.05 ETH` provisioning budget, and rebind gate remain unchanged.
- No new dependency, Solidity, mainnet path, journal edit, replacement transaction, or secret-bearing artifact.

## Approaches

### Delete/rebase the old journal

Rejected. It destroys confirmed evidence and can replay signer work.

### Start a new wallet

Rejected. It abandons the two verified user credentials and contradicts requested recovery.

### Selected: explicit successor lineage

Commit one public JSON artifact containing original package hash, prefix length, exact consumed transaction hashes/nonces, and expected next nonce. Recovery first reconstructs and verifies the original package, then verifies consumed lineage through both providers, then derives a distinct successor plan whose first two historical signer rows remain at `959/960` and whose remaining five rows are `964..968`.

## Flow

```text
old review + unchanged two-entry journal
  -> rebuild original plan at 959
  -> verify signer txs/receipts/runtimes through providers A+B
  -> verify committed unrelated txs at 961/962 through A+B
  -> prove old future addresses empty
  -> derive successor future addresses from 964
  -> prove successor future addresses empty
  -> write new unsigned successor review
  -> JIT quote / durable authorization / sign one / six confirmations
  -> final topology / passkey rebind
```

## Failure behavior

Missing/mutated lineage, wrong original package, wrong prefix, gap/hash/nonce/order drift, failed or unconfirmed receipt, reorg, provider disagreement, a consumed transaction matching old deployment intent, code at any old/successor future address, or relay nonce split stops before review creation, authorization, signing, or broadcast.

## Live boundary

The authorized live execution may send only successor rows `setup-helper`, `guard`, `delay`, `maintenance`, and `safe-proxy`. It stops on any preflight divergence and reports public receipt/topology evidence. Testnet research only.
