# Guarded Safe / Pimlico compatibility

**Date:** 2026-10-16
**Verdict:** `blocked`
**Scope:** Task 1 read-only investigation and disposition. No ERC-4337 implementation, dependency installation, contract probe, bundler run, or live transaction.

The prior ordinary-Safe live gate is open. Task 1 Step 1 therefore permits investigation/report only. The stock candidate also has concrete source-level conflicts with the accepted topology and message policy. Documentation completeness is not compatibility evidence. Tasks 2–10 remain gated; `apps/backend` remains the required browser write boundary.

**2026-10-17 follow-up:** The [native one-Safe design proposal](../superpowers/specs/2026-10-17-native-safe-4337-design.md) selects a restricted handler, locked bootstrap followed by execution-phase activation, contract-only secondary and manual ready Delay transport. It replaces the stock-module approach as a research candidate. It does not change this report's blocked verdict or supply the missing native-profile gas, trace, sponsorship, inclusion or live evidence.

**2026-10-19 disposition:** The native design is the approved implementation scope once the ordinary-Safe live gate passes. It supersedes this report's hypothetical stock-module nesting and funder-deposit resolution path; the source findings explaining why the stock candidate was rejected remain evidence. Only the named restricted handler/bootstrap/anchors, contract-only secondary, restricted nonzero fallback, sponsored gas, and delayed handler/profile maintenance are in scope. `apps/backend` remains the browser write boundary until replacement evidence is complete.

## Prior evidence audit

| Required evidence | Recorded result | Evidence / limit |
| --- | --- | --- |
| Real Safe 1.5, primary sole owner, threshold 1; guard-only contract/ECDSA secondary | LOCAL RECORDED | [2026-10-09 ledger](../superpowers/plans/2026-10-09-guard-live-validation.md), [real WebAuthn integration](../../test/integration/real-webauthn.test.ts), [guard signature integration](../../test/integration/guard-signatures.test.ts). Software-generated P-256 assertions through actual passkey contracts; no hardware/browser UX proof. |
| Local X/Y/Z, replay, failure rollback, cancellation, expiry, freeze, rotation, forbidden-path matrix | LOCAL RECORDED | Same ledger records 280 full-suite tests, 4 invariants, coverage 278 passing/2 deliberate skips, 11 reviewed Slither findings, and local rehearsal. [Demo evidence](../evidence/2026-10-15-eurc-wallet-demo.md) later records 297 security-core tests, 4 invariants and rehearsal on chain 31337. Historical results, not rerun here. |
| Public dependency runtime and passkey factory binding on Sepolia | PARTIAL RECORDED | 2026-10-09 ledger and [dependency review](dependency-review.md) record public dependency verification and credential-specific binding. The 2026-10-14 read-only artifact simulation produced an unsigned plan at funder nonce 413; no deployment was broadcast. No fresh RPC verification in this assessment. |
| Ordinary Safe deployed topology, receipt/state/balance/alert matrix on Sepolia | MISSING — BLOCKING | Phase One deployment/audit, native/ERC-20 matrix and receipt/alert rows are unchecked. [Runbook](testnet-runbook.md) and demo evidence explicitly leave live rehearsal outstanding. No recorded ordinary-Safe transfer/queue/control hashes establish this gate. |
| Bootstrap-only live transactions | RECORDED; INSUFFICIENT | Ledger records self-probe `0x382e6cc309b7925fe462159edc35e411a10be3a9a0961194aff42d97ba2cc14a`, primary creation `0x43d5993748d43b19308d32982caaf45bc55b805b88936c1c57328eac74392496`, secondary creation `0x916fb30007202b3f7ed2b250115c3e7604fdba04c8f53dbb30365778c8b48191`. These are existing public references, not newly checked receipts or evidence of vault execution. |
| Hardware authenticator/browser ceremony and independent live alerts | UNVERIFIED | Neither automated credentials nor UI unit tests establish hardware presence, device verification or alerts while the app is closed. |

## Candidate provenance; no dependency approval

Registry metadata was queried read-only on 2026-10-16 using exact-version npm registry endpoints. Archives were inspected in memory without installing packages or modifying a lockfile.

| Candidate | Exact registry evidence | Disposition |
| --- | --- | --- |
| `permissionless@0.5.0` | `gitHead 473d64a5ef0802e4a146ff531f0174b1ccf516f1`; peer `viem ^2.44.4`; dependency `ox ^1.8.8`; integrity `sha512-MidZMPrTLmPBrex8srDFPAykK8ISbxon7gPLusFH7Yod8IX0gynLOWZF1tZXBHyPP1COQkRGTc0WR/lhGO/xEw==` | Candidate only; not in repository's direct security dependencies or a new reviewed resolution. |
| `@safe-global/safe-4337@0.3.0-1` | `gitHead 75e56fd52b0ddbe01dc237eaae7edb9a102ffc5c`; dependency `@safe-global/safe-contracts ^1.4.1-build.0`; integrity `sha512-utkGzRJ+wU/Xi4PhwYWNYUaVoS7uy41p6+pn++5XKx/627Ztec3sLLP1oQRnTjGrGaMukDe3mdxWTMyaVaWbTA==` | Upstream package/source provenance observed; not approved for the vault. |
| `@safe-global/safe-modules-deployments@3.0.11` | `gitHead bc4d80f7de099b8926edc211d65d86b053ff6b85`; integrity `sha512-H6ceE3n4jCyc6i2rMYMqpKPnXpUCG5Bw8bC44q3EzicdDTq6WZOxSzuaUwx/EO12Nwr9HPDxzya4Nb/wsW0A+Q==` | Registry observations only; no chain runtime validation. |
| Existing Safe/passkey/Delay/client baseline | Safe `1.5.0`, deployment registry `1.37.63`, passkey `0.2.0`, Zodiac `5.0.1`, viem `2.56.7`; Delay source `30f3aafa9b3be3425bcac390fe6ab6bd9afb5f16` v1.1.1 | Existing pins and their limits remain in [dependency review](dependency-review.md). No new audit or deployment approval. |

Primary metadata: [permissionless registry](https://registry.npmjs.org/permissionless/0.5.0), [Safe4337 registry](https://registry.npmjs.org/@safe-global%2fsafe-4337/0.3.0-1), [module registry package](https://registry.npmjs.org/@safe-global%2fsafe-modules-deployments/3.0.11).

The candidate's [upstream lockfile](https://raw.githubusercontent.com/safe-fndn/safe-modules/75e56fd52b0ddbe01dc237eaae7edb9a102ffc5c/pnpm-lock.yaml) resolves the inherited Safe contracts to `1.4.1-build.0`. The exact published `package/contracts/handler/CompatibilityFallbackHandler.sol` inspected from that dependency has SHA-256 `e1f78d39731ecaebce2e41436af217db87eb41e9e2e1d576b638847d549b1047`. This is a source-file hash, not a runtime-code hash or proof of reproducible module compilation.

The [v0.3.0 audit index](https://raw.githubusercontent.com/safe-fndn/safe-modules/75e56fd52b0ddbe01dc237eaae7edb9a102ffc5c/modules/4337/docs/v0.3.0/audit.md) identifies Ackee Blockchain and audited commit `7b3ea24cf06dca2bc88405fd1c991b2338f565f8`. The candidate source commit differs. Full PDF scope, fixes, diff correspondence, compiler settings and composed Safe 1.5/guard/passkey profile were not established here. An upstream audit reference does not audit this composition.

## Complete compatibility matrix

`SOURCE CONFLICT` means an observed source-level incompatibility; it is not an executed failing test. `UNVERIFIED` and `NOT RUN` never satisfy a gate.

| Spec gate | Status | Exact evidence and unresolved requirement |
| --- | --- | --- |
| Safe 1.5 / module / EntryPoint / passkey / Delay / SDK version compatibility | UNVERIFIED | Exact candidates above; no real EntryPoint/module/passkey integration. Safe 1.5 remains mandatory for module guards. |
| Owner and module enforcement; no direct module transfers | SOURCE CONFLICT | [Guard](../../contracts/TieredSpendingGuard.sol) `checkModuleTransaction` accepts only `config.delay`. Stock Safe4337Module is another module. Adding it to the list without exact envelope validation would create a policy bypass. |
| Arbitrary Safe ERC-1271 messages rejected onchain | SOURCE CONFLICT | Inherited handler exposes both `isValidSignature(bytes,bytes)` and `isValidSignature(bytes32,bytes)`. Signed Safe-message validation reaches owner signature checking without the spending guard. See fallback analysis below. |
| Approvals, Permit/Permit2, approved hashes, fallback replacement, unknown calldata, delegatecalls and unlisted modules denied | UNVERIFIED FOR AA | Existing [adversarial tests](../../test/integration/adversarial.test.ts) cover baseline. No AA rejection suite exists or ran. Message-policy conflict prevents importing baseline claims unchanged. |
| Only zero-value CALL to same Safe's canonical signed `execTransaction` | UNIMPLEMENTED | Candidate envelope is a design constraint, not current module behavior. Exact target/value/operation/selector/full ABI length/signatures must be bound; no broad self-call exception is accepted. |
| Inner owner check exactly once; X/Y once; matched after-hooks; failure rollback; no cross-call reentrancy | SOURCE CONFLICT | Guard's shared `checking` flag rejects nested owner check after module check. Current `checkAfterExecution` and `checkAfterModuleExecution` are baseline hooks, not a nested-envelope state machine. |
| Required inner secondary approval cannot be replaced by outer primary | UNVERIFIED | Existing guard signs SafeTx; outer module validates a different SafeOp. Guard-only secondaries are not outer Safe owners. No equivalence or secondary propagation may be assumed. |
| Safe/EntryPoint nonce domains, explicit key, SafeTx/SafeOp/UserOperation/Delay hashes distinct | UNVERIFIED | No AA digest implementation or mutation tests. Existing Safe nonce and Delay fingerprint stay authoritative on their paths. |
| Sponsorship only; missing-account-funds path cannot spend vault assets | SOURCE RISK / NOT RUN | Stock module contains a prefund module call. Current guard denies this module, but a future allowlist change must still reject prefund. No EntryPoint deposit withdrawal, vault refund, token charge or paymaster approval is accepted. |
| Standards-enforcing bundler validation/storage/staking acceptance | NOT RUN | No selected image/package digest or executable command, no validation trace, no inclusion receipt. A Hardhat call would not prove this gate. |
| Sponsored fresh deployment of all prerequisites, atomic protection, no hidden EOA | SOURCE CONFLICT / UNRESOLVED | [build.ts](../../src/topology/build.ts) derives nonce-based EOA prerequisite addresses and deploys setup helper, guard, Delay, maintenance at consecutive nonces before Safe creation. No sponsor-compatible replacement path demonstrated. |
| Sole primary owner; no second custody Safe/session/recovery path | BASELINE ONLY | [verify.ts](../../src/topology/verify.ts) enforces sole primary, threshold 1, zero fallback, only Delay module. Candidate AA profile changes fallback/modules and requires reviewed topology proof. |
| Queue/cancel/freeze/delayed maintenance/expiry via sponsorship | NOT RUN | No AA transport or provider acceptance evidence. Baseline [delayed-tier tests](../../test/integration/delayed-tier.test.ts) are not AA proofs. |
| Ready Delay execution after Z without original factors online | SEMANTIC SUPPORT / TRANSPORT BLOCKED | Delay's public `executeNextTx` is permissionless. No reviewed non-custodial sponsored submission route is identified; owner-authorized outer SafeOp still needs primary online. |
| Browser-safe credential and bounded sponsor exposure | UNVERIFIED | Provider documentation describes budget controls; no account-level configuration, browser credential approval, CORS, enforced sender/operation limits, expiry or abuse test recorded. |
| Independent monitoring while browser closed | BASELINE ONLY / AA NOT RUN | Existing read-only observer remains required. AA envelope decoding, receipt linkage and closed-browser alert evidence absent. |

## Source-level conflicts and required proof

### Fallback boundary

[Safe4337Module source at the candidate commit](https://raw.githubusercontent.com/safe-fndn/safe-modules/75e56fd52b0ddbe01dc237eaae7edb9a102ffc5c/modules/4337/contracts/Safe4337Module.sol) inherits `CompatibilityFallbackHandler`, validates SafeOp owner signatures and executes module calls; a nonzero missing-funds request triggers a module payment attempt. This surface is broader than a canonical inner SafeTx transport. These observations establish source risk, not runtime exploit tests.

The [1.4.1 handler source](https://raw.githubusercontent.com/safe-global/safe-smart-account/v1.4.1/contracts/handler/CompatibilityFallbackHandler.sol), corroborated against the exact npm dependency file above, allows nonempty Safe-message signatures through `safe.checkSignatures`; its bytes32 entry point delegates to the bytes entry point. Guard hooks do not run for this signature view path. With a compromised primary capable of signing arbitrary digests, hiding message signing in the UI does not enforce denial onchain. Zero fallback prevents the standard EntryPoint forwarding path; installing the stock module as fallback restores the unwanted surface. No reviewed selector-restricted primitive satisfying both paths was identified.

Relevant selectors: `isValidSignature(bytes32,bytes)` (`0x1626ba7e`), `isValidSignature(bytes,bytes)` (`0x20c13b0b`), and inner `execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)` (`0x6a761202`). The candidate outer entry points are `executeUserOp(address,uint256,bytes,uint8)` and `executeUserOpWithErrorString(address,uint256,bytes,uint8)`. This is an investigated surface inventory, not an approved selector allowlist.

### Nested guard and authorization boundary

The hypothetical chain is EntryPoint → Safe fallback/module → Safe module execution → same Safe `execTransaction` → owner guard → action → owner after-hook → module after-hook. Today module identity fails first; merely relaxing that check then reaches the `checking` reentrancy failure. A reviewed design would need exact pending-envelope binding, one allowed inner transition, a separate Delay path, matched digest after-hooks, full rollback, and denial of every unrelated nested call. No state machine was implemented or approved here. Existing direct owner enforcement must remain intact.

### Bootstrap and permissionless execution

[Exact permissionless 0.5.0 source](https://raw.githubusercontent.com/pimlicolabs/permissionless.js/473d64a5ef0802e4a146ff531f0174b1ccf516f1/packages/permissionless/accounts/safe/toSafeSmartAccount.ts) explicitly supports `1.4.1` and `1.5.0`; Safe 1.5 support in the type/address map corrects the older [reference page](https://docs.pimlico.io/references/permissionless/reference/accounts/toSafeSmartAccount), which lists only 1.4.1. This supports investigation, not guard/topology compatibility. Its shared WebAuthn signer defaults differ from the baseline credential-specific factory signers. Never silently substitute defaults, use ERC-7579, or fund an auxiliary custody account.

[Delay v1.1.1 source](https://raw.githubusercontent.com/gnosisguild/zodiac-modifier-delay/30f3aafa9b3be3425bcac390fe6ab6bd9afb5f16/contracts/Delay.sol) makes ready execution public, while proposal injection is module-controlled. The requirement is stronger than that Solidity visibility: a browser must obtain sponsored transport without original factors, a privileged relayer key or an extra custody Safe. The candidate SafeOp is owner-authorized, so permissionless ready execution is not established by wrapping it in that account. No accepted public executor route was found. This does not prove no existing primitive can ever satisfy it.

### Runtime, address and audit boundary

| Component | Address evidence | Runtime evidence in this investigation |
| --- | --- | --- |
| Safe singleton / proxy factory / MultiSendCallOnly 1.5 | Existing pinned registry addresses and runtime hashes in [dependency review](dependency-review.md) and [deployment resolver](../../src/config/deployments.ts) | Previously recorded verification only; no fresh RPC read. |
| Passkey 0.2 factory / Daimo verifier / credential signer | Existing pins and factory-binding requirements in same documents | Automated local signer evidence differs from hardware/browser proof; no new deployed signer verification. |
| Safe4337Module 0.3.0 | [Pinned official registry asset](https://raw.githubusercontent.com/safe-global/safe-modules-deployments/bc4d80f7de099b8926edc211d65d86b053ff6b85/src/assets/safe-4337-module/v0.3.0/safe-4337-module.json) lists Sepolia `0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226` | UNKNOWN; no `eth_getCode`, hash or `SUPPORTED_ENTRYPOINT` read. Registry asset reports release 0.3.0; correspondence to npm 0.3.0-1 still needs proof. |
| SafeModuleSetup 0.3.0 | [Pinned registry asset](https://raw.githubusercontent.com/safe-global/safe-modules-deployments/bc4d80f7de099b8926edc211d65d86b053ff6b85/src/assets/safe-4337-module/v0.3.0/safe-module-setup.json) lists Sepolia `0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47` | UNKNOWN; not an approved complete vault bootstrap. |
| EntryPoint 0.7 | Version candidate only; no canonical address adopted/verified by this report | UNKNOWN address binding/runtime hash/audit correspondence. |
| Guard / Delay / setup / maintenance instances | Baseline unsigned-plan provenance only; no fresh sponsored profile | UNKNOWN AA profile runtime, source/audit and constructor bindings. Local compatibility Delay fixture is not deployment evidence. |
| Paymaster / restricted fallback / public ready executor / sponsored prerequisite factory | No accepted addresses identified | UNKNOWN; absence of accepted primitives blocks pass. |

## Verification performed and stop disposition

Read required research, core plan, signer evaluation, full client-only spec/plan, live plan, runbook, evidence, current guard/topology sources and package manifests. Queried primary registry/source/audit-index metadata; inspected inherited dependency source and pinned deployment assets. No secrets or private configuration were accessed. No dependencies or locks changed.

A read-only attempt to compute selectors with existing `viem` failed with `MODULE_NOT_FOUND`; this checkout has no resolvable installed viem for that command. Nothing was installed to bypass the prior gate. No AA test failure, bundler failure or runtime proof is claimed from that tooling limitation.

Task 1 Steps 2–3 are NOT RUN because Step 1 expressly restricts work to investigation/report. A bundler image/digest/command is **unselected**, not reproducible evidence. No compatibility test or fixture was added. Step 4 disposition is complete: blocked; see the [separate focused proposal](../superpowers/specs/2026-10-16-pimlico-blocker-resolution.md). Step 5 delivers the report/docs commit for review only, without a probe or dependency changes. The report commit does not establish compatibility or authorize implementation. Tasks 2–10 and backend deletion remain stopped.

To reopen: complete the separately authorized ordinary-Safe live evidence gate; review a focused resolution for fallback, sponsored prerequisites and permissionless Delay transport; then authorize rejection-first probes. Only a fully evidenced compatibility report may become `passed`.
