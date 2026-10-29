# Nonce 869 local public-code provenance

Date: 2026-10-29
Scope: read-only local public code, public artifacts, ignored public operational scripts, sibling `recent-tx-safe-guard` worktrees, and local Git object history. No RPC/network access, private/config/key reads, process inspection, signing, or broadcast.

## Result

Actor and cause remain **UNKNOWN**. Local public evidence does not identify the contract source behind `0xadb8f835e565ac7e71d2df6cfbd0fc003fa22c27` or a function signature for selector `0xa0eb5570`. It does show that the repository's tracked funder-signing paths cannot directly have emitted the observed legacy transaction: those paths explicitly sign EIP-1559 envelopes and reject any signed envelope that is not type 2.

The strongest local lead is address-level deployment provenance. With viem `getContractAddress`, the destination is exactly the standard CREATE address derived from funder `0xaD4D5cd2Ec5beCdB9608baD4c36F0dBe8b2492Bc` at nonce `759`. This is a deterministic address calculation, not canonical proof of the actual deployment transaction; the RPC/private-boundary investigation must confirm the creator, creation transaction, runtime, and code history.

The two known calls are the same destination, value, and four-byte input:

- nonce 809: `packages/security-core/test/fixtures/ordinary-hashless/canonical-public-legacy-nonce809.json:8-21`
- nonce 869: `packages/security-core/test/fixtures/ordinary-usdc-recycle-continuation-nonce869.public.json:4-29`

Both are protected legacy Sepolia transactions with `gasPrice = 100000`, gas limit `1820162`, target `0xadb8…22c27`, value `0`, and input `0xa0eb5570`. The nonce-869 receipt used `1247851` gas. The fixed security spec explicitly preserves actor/cause as `UNKNOWN` (`packages/security-core/docs/superpowers/specs/2026-10-29-usdc-recycle-continuation.md:22-28`), and the certificate carries `cause: "UNKNOWN"` (`packages/security-core/scripts/live/ordinary-scenario-usdc-recycle-continuation-certificate.ts:295-305`).

## Selector and deployment-source checks

1. Computed selectors with viem `toFunctionSelector` for every function in all 139 current Hardhat artifact JSON files. No match for `0xa0eb5570`.
2. Parsed function declarations and inline ABI signatures in current `contracts`, `legacy`, `scripts`, `src`, and `test`. No match.
3. Scanned 1,046 unique local Git blobs across all refs for Solidity/source signatures and JSON ABIs, again using viem selector calculation. No match.
4. Searched the three sibling `recent-tx-safe-guard` worktrees' public `packages/security-core`, `apps`, and `.superpowers` trees for the destination, selector, and nonce 759. No match.
5. Searched current public code/artifacts for the destination and selector. All exact destination references are later observation/certificate/test material for nonce 809 or 869; none constructs the call or names the destination as a deployment.
6. Reproduced the address lead locally:

```js
getContractAddress({
  from: "0xaD4D5cd2Ec5beCdB9608baD4c36F0dBe8b2492Bc",
  nonce: 759n,
}) === "0xadb8f835e565ac7e71d2df6cfbd0fc003fa22c27"
```

The repository uses this same viem primitive for planned CREATE-address derivation (`packages/security-core/src/topology/addressing.ts:17-30`). Its known vault deployment bytecode is limited to `SafeAtomicSetupHelper`, `TieredSpendingGuard`, Zodiac Delay, and `GuardReplacementMaintenance` (`packages/security-core/src/live/vault-deployment.ts:1-48`). Their compiled ABIs do not contain the selector. No public plan, journal, receipt, or operational artifact found here records a planned deployment at funder nonce 759. Therefore the destination's source is not attributable to a repository contract from local evidence.

## Operational-path findings

### Tracked live and FIRST38 paths: excluded as the direct envelope source

- The shared live context signs with `type: "eip1559"` (`packages/security-core/scripts/live/runtime.ts:136-145`).
- The submission seam parses the signed transaction, requires raw prefix `0x02`, and requires `signed.type === "eip1559"` before broadcast (`packages/security-core/scripts/live/submission.ts:80-95`).
- The ordinary scenario production harness also signs explicit EIP-1559 envelopes and only exposes broadcast in `submit-one` (`packages/security-core/scripts/live/ordinary-scenario-executor-cli.ts:122-126`).
- The ignored root operational wrapper `first38-one.py` invokes only that closed ordinary-scenario CLI with the fixed reviewed report/proposal/approval/journal (`.superpowers/sdd/2026-10-19-native-safe-4337/first38-one.py:1-16`). It does not build transactions itself.
- The older generic live runner validates its intent as either a zero-value self probe or an exact passkey-factory `createSigner` call (`packages/security-core/scripts/live/runtime.ts:49-67`), then reaches the same EIP-1559 signing context. It cannot validate the observed target/input.

These facts exclude the observed **legacy** nonce-809 and nonce-869 envelopes from the tracked live signing implementations, even though those implementations can use the same funder under authorized operation.

### Import-time, rehearsal, and legacy-reconstruction checks

- Repository-wide searches found no ethers `Wallet`, `ContractFactory`, `eth_sendTransaction`, or legacy `signTransaction({ gasPrice: ... })` path in product/operational source. Direct Sepolia broadcasts are the viem type-2 seams above.
- Several standalone scripts invoke `main()` at module load rather than guarding it, including `deploy-disposable.ts`, `safe-creation.ts`, `runner.ts`, and `prove-passkey-base.ts`. The write-capable ones still route through `createSepoliaLiveContext`/`submitLiveIntent`, so even accidental import execution would sign type 2 and then be rejected if the raw transaction were not `0x02`. Their import-time behavior is operationally undesirable for forensic clarity but does not match this legacy envelope.
- The rehearsal launcher strips provider/credential/broadcast inputs, forces `REHEARSAL_LOCAL=1`, and runs only a Hardhat test (`packages/security-core/scripts/rehearse.ts:4-21`). The rehearsal input validator rejects non-Hardhat network selection and provider/private/broadcast environment names (`packages/security-core/src/security/rehearsal-inputs.ts:1-13`). `hardhat.config.ts` defines no Sepolia network or account (`packages/security-core/hardhat.config.ts:25-41`). Test helper `sendTransaction`/`deployContract` calls therefore run on chain 31337, not Sepolia.
- The only production-source construction of a legacy serialized transaction is forensic reconstruction from already-published `r/s/v` to verify hash and recover sender (`packages/security-core/scripts/live/ordinary-scenario-hashless-continuation-cli.ts:148-175`). The returned provider surface contains reads only. The successor evidence reader reuses that reconstruction for canonical evidence (`packages/security-core/scripts/live/ordinary-scenario-usdc-successor-cli.ts:153-169`). Neither path signs or broadcasts the reconstructed bytes.

### Backend external-module boundary: possible capability, no attribution

The backend public shell requires a relay private key and loads its provisioner/submission implementation from an absolute module path outside the repository (`apps/backend/src/config.ts:18-33`, `apps/backend/src/provisioner.ts:40-67`). The repository passes vault deployment to that external `provisioner.deploy` implementation (`apps/backend/src/vault.ts:215-228`). The public tree therefore cannot establish the envelope type, target restrictions, or deployed bytecode of the actual external adapter. No local public evidence links that boundary to the funder, nonce 759, selector, or either transaction. This is a boundary for the separate private/config investigation, not evidence of causation.

## Ranked hypotheses

1. **Out-of-repository or unavailable legacy deploy/caller tooling using the funder — strongest fit, unproven.** The target matches the funder's CREATE nonce-759 address, and the same unusual legacy tuple (`gasPrice 100000`, gas `1820162`, value zero, exact four-byte input) recurs at nonces 809 and 869. No repository ABI or tracked signer produces it. This pattern is consistent with a separate script/tool that both deployed and later called a contract, but no local artifact identifies its operator or source.
2. **Backend external provisioner/submission adapter — possible boundary, weak evidence.** The adapter is intentionally outside the public repository and can perform deployments/submissions. Local code exposes the boundary but supplies no link to this address or legacy tuple. Verify the reviewed adapter identity and its public source/config provenance separately without assuming it used the funder.
3. **Never-committed/unavailable helper or import side effect — possible in principle, currently disfavored.** Current source, all local Git refs (1,046 scanned code/ABI blobs), and three sibling public worktrees contain no matching selector, destination deployment, nonce-759 plan, or legacy signer. The unguarded standalone `main()` scripts all use the type-2 seam. A file absent from these worktrees/history remains possible, but local public evidence gives no concrete lead.
4. **Tracked vault/FIRST38/rehearsal execution — contradicted by envelope and call constraints.** Live paths use type-2 transactions and exact reviewed targets/calldata; rehearsal is isolated to chain 31337. They can explain ordinary funder nonce movement, but not this protected legacy call.

## Cheap next discriminators for the separate RPC/private-boundary investigation

- Resolve the canonical transaction at funder nonce 759 and require `to == null`, recovered sender equal to the funder, and created contract equal to the destination before treating the CREATE derivation as deployment proof.
- Compare the creation input/runtime/runtime hash with known public artifacts and verified source. A mismatch closes the repository-contract hypothesis; a match may identify source even though the selector is absent from its ABI (for example, runtime mutation/proxy/fallback behavior).
- Inspect the destination's runtime/code changes and nonce-809/869 traces for delegate calls, creations, self-destruction/redeployment, logs, and state effects. Four-byte-only success with high gas could be a custom no-argument function, fallback dispatch, proxy route, or deployment-like internal work; local evidence does not distinguish them.
- At the private boundary, check only explicit reviewed adapter/script provenance and durable journals around nonces 759, 809, and 869. Do not infer an actor from possession of the funder key or from the repeat interval alone.

No product or tracked files were modified by this investigation.

## Root subsequent attribution evidence

After this read-only investigation, the user identified the recurring SorteCerta task “Support unlimited participants.” Root compared its public saved soak state with the already verified canonical hashes. Nonce869 hash a81d6df9…4781e is cycle-40-close; nonce809 hash83923abf…e1f5 is cycle-2-close. Both sender/nonce/gas/fee facts agree. See nonce869-service-provenance.json. This identifies the consuming service; it does not infer the reason the original hashless attempt stopped or change any frozen source record, authority, or cap. No service edits, messaging, private key/raw access, or financial submission occurred.
