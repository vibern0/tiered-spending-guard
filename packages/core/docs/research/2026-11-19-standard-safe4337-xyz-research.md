# Standard Safe4337Module on Safe 1.5: X/Y/Z research

**Date:** 2026-11-19
**Status:** Research and local compatibility probe only. No architecture approval, guard change, dependency addition, live transaction, or deployment.
**Question:** Can the published standard Safe4337Module work with Safe 1.5, and what is the smallest change that could preserve this vault's X/Y/Z policy without a custom fallback handler?

## Answer

**Yes, Safe 1.5 and the published standard module are signature-ABI compatible.** Safe 1.5.0 retains `checkSignatures(bytes32,bytes,bytes)`, which the standard Safe4337Module calls, alongside its newer executor-aware overload. The local probe below deployed an actual Safe 1.5 proxy, the published `@safe-global/safe-4337@0.3.0-1` artifacts, and credential-specific passkey signers. A valid passkey SafeOp returned validation data `0`; changing its call data returned `1`. The earlier claim that Safe 1.5 removed this overload was wrong. [Safe 1.5 source](https://github.com/safe-fndn/safe-smart-account/blob/dc437e8fba8b4805d76bcbd1c668c9fd3d1e83be/contracts/Safe.sol#L355), [standard module source](https://github.com/safe-fndn/safe-modules/blob/75e56fd52b0ddbe01dc237eaae7edb9a102ffc5c/modules/4337/contracts/Safe4337Module.sol#L223), [permissionless Safe 1.5 support](https://github.com/pimlicolabs/permissionless.js/pull/440).

**The current guard is not compatible unchanged.** It admits only Delay in its module hook and blocks a nested owner check while a module check is open. A stock module can also send an unguarded direct transfer if the module guard is absent. The local probe observed all three outcomes. See [probe evidence](../evidence/2026-11-19-standard-safe4337-probe.json) and [reproducible runner](../../scripts/research/safe4337-compatibility.cjs).

**X/Y/Z could plausibly use the existing guard with a narrow, explicit AA branch, but that has not been implemented or proved.** It would reuse the existing owner-path policy for instant spending and proposals, plus the existing Delay module path for ready execution. This is a meaningful change to the guard state machine, topology, setup, client, and monitoring; it is not a drop-in module swap.

**The full accepted security policy cannot be preserved by changes to `TieredSpendingGuard` alone.** The standard module is also a Safe fallback handler. Its inherited `isValidSignature` accepts arbitrary Safe messages signed by the primary passkey without calling either transaction or module guard. The probe exercised that path with a real P-256 signature and observed ERC-1271 success (`0x1626ba7e`) with unchanged guard counters and Safe nonce. The accepted policy forbids arbitrary messages. No frontend restriction fixes that onchain path. [Inherited fallback source](https://github.com/safe-fndn/safe-smart-account/blob/dc437e8fba8b4805d76bcbd1c668c9fd3d1e83be/contracts/handler/CompatibilityFallbackHandler.sol#L73).

## What was already researched

The [2026-10-16 Pimlico compatibility report](../security/pimlico-compatibility.md) found the module/fallback and guard nesting conflicts, and already noted permissionless.js support for Safe 1.5. The [client-only Pimlico design](../superpowers/specs/2026-10-16-client-only-pimlico-design.md) considered wrapping an owner `execTransaction` inside a module operation. The [native Safe 4337 design](../superpowers/specs/2026-10-17-native-safe-4337-design.md) and [approved implementation plan](../superpowers/plans/2026-10-19-native-safe-4337.md) then chose a restricted handler and superseded the stock-module branch. Task 0 of that plan remains open; native implementation tasks have not started. This report updates the compatibility evidence, not the approved scope or delivery gates.

## Exact artifacts and local evidence

| Artifact | Pinned observation | Limit |
| --- | --- | --- |
| Safe | `@safe-global/safe-smart-account@1.5.0`, source `dc437e8fba8b4805d76bcbd1c668c9fd3d1e83be`; local singleton runtime hash `0xdda019cbd7c867a533a2a86e5c53434fdc50b13122b5a5ddb4a8df61b31c20f2` | Local hash matches the [official deployment registry](https://github.com/safe-global/safe-deployments/blob/main/src/assets/v1.5.0/safe.json); no fresh Sepolia `eth_getCode` in this research. |
| Standard module | `@safe-global/safe-4337@0.3.0-1`, source `75e56fd52b0ddbe01dc237eaae7edb9a102ffc5c`, npm tarball SHA-256 `7be4a60729e8df59fe6f7b691057c8609188cfbab2af2b76612e8d97ae095642`; local deployed runtime hash `0x2aea997c4e3cf0e2f333025372e219abcfde81c21fc2f8fb066414a5685dd3e0` | Published artifact was fetched and hash checked by the runner. Local deployment is not verification of the advertised Sepolia module address `0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226`. [npm version](https://registry.npmjs.org/@safe-global%2fsafe-4337/0.3.0-1). |
| EntryPoint | Module constructed for EntryPoint 0.7 address `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | Local caller impersonation only; no actual EntryPoint, bundled operation, nonce manager, or sponsor execution. The approved native plan targets EntryPoint **0.8**. This probe does not establish whether the published module works with 0.8; choosing 0.7 instead would require a protocol/profile amendment. |
| Passkeys | Existing `@safe-global/safe-passkey@0.2.0`, credential-specific signer factory, FCL P-256 verifier, two software-generated credentials | Actual contract signature validation, not a browser or hardware authenticator ceremony. Stock permissionless WebAuthn defaults must not silently replace these signers. |

The runner uses the installed Safe/passkey artifacts and downloads only the exact published module tarball into memory. From `packages/core`, run:

```sh
./node_modules/.bin/hardhat run --no-compile scripts/research/safe4337-compatibility.cjs
```

The local fixture intentionally installs the standard module, its fallback handler, and the existing Delay/guard on one Safe. That **does not** satisfy the current approved topology: the old verifier requires zero fallback and only Delay, and the fixture uses the existing ECDSA secondary slot as well as a contract secondary. It establishes path behavior, not an acceptable vault deployment. The runner did not execute a real UserOperation, test Z/cancellation/expiry under AA, prove a browser flow, check live bytecode, or review the module's full audit scope and deployed-code correspondence. The [upstream v0.3.0 audit index](https://github.com/safe-fndn/safe-modules/blob/75e56fd52b0ddbe01dc237eaae7edb9a102ffc5c/modules/4337/docs/v0.3.0/audit.md) names an audited commit different from this published package's source commit; that difference needs review before adoption.

## Smallest policy-preserving execution path to investigate

The standard module's `validateUserOp` checks the outer SafeOp signature and permits only its two execution selectors. Its execution calls Safe `execTransactionFromModule`. Its validation may also call `execTransactionFromModule(EntryPoint, missingAccountFunds, "", CALL)` to pay prefund. [Module validation/execution source](https://github.com/safe-fndn/safe-modules/blob/75e56fd52b0ddbe01dc237eaae7edb9a102ffc5c/modules/4337/contracts/Safe4337Module.sol#L133). The guard receives the inner module call, **not** the complete UserOperation or paymaster data.

For base, step-up, and delayed proposals, the narrow candidate is:

```text
EntryPoint 0.7 → Safe fallback / standard module
  → Safe module hook: only configured module, CALL, value 0,
    target this Safe, canonical execTransaction calldata
  → same Safe execTransaction with exact inner SafeTx signatures
  → owner guard: passkey (+ configured secondary where required), X/Y or queue policy
  → owner after-hook → outer module after-hook
```

The smallest **contract** change would be in `TieredSpendingGuard`: add an immutable/pinned standard-module identity and replace its single `checking` boolean with a bounded phase machine. An outer module check would commit to the exact canonical wrapper, inner SafeTx hash/nonce, allowed operation, and expected module transaction hash. It would permit exactly one nested owner check, require both after-hooks in order with success, retain the pending ERC-20 balance proof across nesting, and clear state only after the outer hook. Other module calls, direct transfers, arbitrary Safe self-calls, delegatecalls, batches, refunds, and prefund transfers to EntryPoint would still revert. The inner Safe transaction must retain `safeTxGas = gasPrice = 0` and exact passkey/secondary validation; a pre-approved-hash or Safe-as-owner shortcut must not satisfy it. Existing ordinary owner and direct Delay paths must remain independently constrained. This is a design sketch, not an audited or tested construction.

For **ready delayed execution**, only wrapping owner `execTransaction` is insufficient: `Delay.executeNextTx` would reach the owner guard as an unknown call, while the accepted queue should be publicly executable after Z without asking the original secondary to sign again. A second bounded outer branch could allow the standard module's zero-value CALL to the configured `Delay.executeNextTx(exact queued tuple)`. That call then enters the existing Safe **Delay module** hook; the phase machine must match the queued head, preserve Delay cooldown/expiry/cancellation checks, require the existing delayed-action policy, and close both hooks without incrementing X/Y. Direct public `Delay.executeNextTx` remains possible through an externally paid transaction. This branch, including nested hook ordering and failure rollback, has not been tested. [Delay test fixture behavior](../../contracts/test/ZodiacDelayV1_1_1.sol), [current guard hooks](../../contracts/TieredSpendingGuard.sol).

| Property | Result with stock module and proposed guard-only change |
| --- | --- |
| X and shared Y per token, passkey-only base, exact secondary for step-up | Candidate via existing owner hook inside exact wrapper; **unproved** until adversarial integration and actual EntryPoint execution. |
| Queue above Y, Z from onchain queue time, cancel/expiry, ready execution | Candidate via existing queue policy plus separate ready-Delay branch; **unproved**. |
| Unlisted module/direct owner spending blocked | Requires exact module/fallback topology pins and both guard slots; direct standard-module calls must fail. |
| No arbitrary messages | **Fails** with stock fallback even after guard changes; proved locally with real passkey. |
| Sponsored gas without vault funds | Guard can reject module prefund transfers and Safe refunds, but cannot inspect/require a particular sponsor or outer fee schedule from its hooks. Actual sponsorship, denial on paymaster rejection, and fee bounds need separate provider/EntryPoint proof. |
| No backend or application key | Not established by module compatibility. Public client/provider setup and a sponsor key restricted to this account/operation profile need their own review; [Pimlico warns that exposed API keys can authorize sponsorship](https://docs.pimlico.io/guides/how-to/security/protect-api-keys). |

## Changes outside the guard

1. **Setup and topology.** The current [builder](../../../sdk/src/topology/build.ts) sets fallback to zero; [verifier](../../../sdk/src/topology/verify.ts) requires zero fallback and exactly one Delay module. A stock profile would require the exact standard module and Delay as the only enabled modules, the standard module as fallback, a verified EntryPoint binding (0.7 in this probe; 0.8 would need its own proof), runtime-code pins, both guard slots, sole credential-specific primary owner, and contract-only secondary. The current [atomic setup helper](../../contracts/SafeAtomicSetupHelper.sol) does not install this profile. Atomic setup/activation must leave no spendable unguarded state. Existing nonce-based EOA prerequisite deployment is not solved by changing the guard.
2. **Maintenance.** Delayed replacement must preserve the module/EntryPoint/fallback profile, guard identities, signer bindings, and both guard slots. The [maintenance helper](../../contracts/GuardReplacementMaintenance.sol) and pinned replacement hashes would need review. A replacement that reopens direct module spending cannot be accepted.
3. **Browser and observer.** Each wrapped operation needs two distinct signed commitments: the exact inner SafeTx (and secondary when required) and the outer SafeOp, which binds UserOperation call data, nonce, gas, fees, and paymaster data. Refreshing a sponsor quote or fee means recomputing the outer signature. Reconcile both nonce domains, inspect UserOperation receipt **success** and inner Safe/Delay effects, and maintain independent non-authorizing alerts. The earlier [Pimlico report](../security/pimlico-compatibility.md) identifies the broader unproved browser/provider and live gates.

## Focused design decision

| Choice | Effect | Disposition |
| --- | --- | --- |
| Keep the approved restricted handler | Keeps an onchain place to reject arbitrary message selectors while supporting a restricted AA execution path; still needs all native implementation and live gates. | **Recommended under the current security policy.** No scope change from this research. |
| Use the standard module and allow arbitrary ERC-1271 Safe messages | Avoids a custom fallback handler, but changes an explicit security property and exposes any protocol that trusts Safe signatures to that new authority. Requires a separately reviewed threat-model amendment; UI restrictions are insufficient. | Do not infer approval from Safe 1.5 compatibility or X/Y/Z transfer tests. |
| Find another audited standard handler that restricts messages and forwards only the required 4337 selectors | Could avoid custom handler code if its exact source/runtime and Safe 1.5 composition meet every requirement. The installed Safe 1.5 `ExtensibleFallbackHandler` has built-in default Safe-message validation and its extension API is not a drop-in router to `Safe4337Module`; it does not solve this as configured. [Source](https://github.com/safe-fndn/safe-smart-account/blob/dc437e8fba8b4805d76bcbd1c668c9fd3d1e83be/contracts/handler/extensible/SignatureVerifierMuxer.sol#L93). | No qualifying primitive identified in this investigation; would need a new focused dependency/security review. |

## Disposition

Safe 1.5 compatibility is **locally demonstrated**; full X/Y/Z compatibility and the accepted vault security profile are **not**. The least invasive candidate for X/Y/Z uses the standard module unchanged plus a tightly scoped guard phase machine and two module branches, but it does not meet the arbitrary-message prohibition. The stock module requires a revised topology and a proved EntryPoint binding; it does not itself remove the backend or solve sponsored prerequisite deployment. Under [AGENTS.md](../../../../AGENTS.md) and the [approved plan](../superpowers/plans/2026-10-19-native-safe-4337.md), implementation would require an explicit security-scope amendment and the pending ordinary-Safe/live gates. A guard-only change cannot be presented as preserving every accepted guarantee. The restricted-handler design remains the approved native direction unless that scope is formally revised.
