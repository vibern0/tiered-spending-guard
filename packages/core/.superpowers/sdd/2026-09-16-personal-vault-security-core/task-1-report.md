# Task 1 implementation report

**Task:** Preserve the historical prototype and establish reproducible dependencies
**Date:** 2026-09-17
**Repository:** `/Users/bernardo/.codex/worktrees/308c/recent-tx-safe-guard`
**Security posture:** Testnet security research only. No deployment or production-readiness claim is made.

## Follow-up review fix

The review identified that advertised later-task lanes and script entrypoints failed while their inputs were not yet present, and that coverage did not enable Solidity instrumentation. The package scripts now explicitly skip absent future directories/files, execute the real command when those inputs exist, propagate command failures, and run coverage with `SOLIDITY_COVERAGE=true`.

A second review found that a present `test/unit` directory is not itself a valid Mocha target. The test lanes now collect matching `.ts`/`.js` files and pass those file paths to Hardhat; an empty match skips explicitly, while any matching test failure propagates.

Verification of the second fix on 2026-09-17:

```text
npm run test:unit             # passed; 7 tests
npm run test:integration      # passed; explicit skip (no matching files)
npm run test:invariant        # passed; explicit skip (no matching files)
npm run build                 # passed; Nothing to compile
npm test                      # passed; 7 tests
npm run coverage              # passed; Solidity coverage enabled, 7 tests
git diff --check              # passed
```

Follow-up verification on 2026-09-17:

```text
npm run test:unit             # passed; explicit skip (directory absent)
npm run test:integration      # passed; explicit skip (directory absent)
npm run test:invariant        # passed; explicit skip (directory absent)
npm run plan:deployment       # passed; explicit skip (file absent)
npm run verify:dependencies   # passed; explicit skip (file absent)
npm run verify:deployment     # passed; explicit skip (file absent)
npm run watch:activity        # passed; explicit skip (file absent)
npm run rehearse              # passed; explicit skip (file absent)
npm run coverage              # passed; solidity-coverage v0.8.14, SOLIDITY_COVERAGE=true
git diff --check              # passed
```

## Scope completed

- Moved `RecentTransactionGuard.sol`, `GnosisSafeMock.sol`, and `RecentTransactionGuard.ts` under `legacy/` with `git mv`.
- Moved `ERC20Mock.sol` to `contracts/test/ERC20Mock.sol`.
- Added `legacy/README.md` documenting the prototype’s disabled authorization, missing transaction binding, missing limits, missing queue/cancellation, permissive mock behavior, and lack of security evidence.
- Configured Hardhat to compile only `contracts/` and test only `test/`, excluding `legacy/`.
- Removed deprecated `@gnosis.pm/safe-contracts` from the active dependency manifest.
- Added exact direct dependency pins and generated `package-lock.json` with `npm install --package-lock-only` followed by a clean `npm ci`.
- Added all Task 1 package scripts: build, test, unit/integration/invariant test lanes, check, coverage, slither, deployment planning/verification, activity watch, and rehearsal.
- Made the future-facing test lanes and TypeScript script entrypoints executable at the current repository state by skipping only when their later-task directory/file is absent; once present, each command runs directly and propagates failures. Coverage explicitly sets `SOLIDITY_COVERAGE=true`.
- Added `docs/security/dependency-review.md` with package integrity, provenance, audit/evidence links, chain/address verification requirements, runtime-hash status, rejected versions, and Policy Engine prior-art status.

## Exact dependency evidence recorded

| Package | Version | Registry integrity | Source commit where available |
| --- | --- | --- | --- |
| `@safe-global/safe-smart-account` | `1.5.0` | `sha512-VIMWxoeY/kNuZVsQVvAeOFKcQS3eojCXg0ecGnesBSLn5ypYshmBhVEEU5XiurJJGTs/MrcoLTbTxhs9W9GvdQ==` | `dc437e8fba8b4805d76bcbd1c668c9fd3d1e83be` |
| `@safe-global/safe-passkey` | `0.2.0` | `sha512-B9IpVvwXLvK3m+BRhn9z8kCbEizFmua4YmaUBZ9yr0xM9YsX2PRTnxbFvC7pLph1OQ2u+9O2V3FEmPiS10YEIw==` | npm metadata exposes repository `safe-global/safe-modules`; no package `gitHead` reported |
| `@gnosis-guild/zodiac` | `5.0.1` | `sha512-+fFXg+cSDFe6yQSKvyK7ivjEDkHXXwwcsh9g178u6OOM01gSII076ClKBXfp4ZX+JnQC5AP5gt6vyl/7RnRDkQ==` | `89352c4f05d4b223b9c555ca963a787fd930da2d` |
| `viem` | `2.56.7` | `sha512-8YXhttIOKikDnTLj4byvGQmF43Gi0FtEfxUWd6OqSJiuz9bxNYNGmzlS8ZaNiYSKUEfs5vmNprvwPIki9Lk4YA==` | npm `2.56.7` |
| `@openzeppelin/contracts` | `5.6.1` | `sha512-Ly6SlsVJ3mj+b18W3R8gNufB7dTICT105fJhodGAGgyC2oqnBAhqSiNDJ8V8DLY05cCz81GLI0CU5vNYA1EC/w==` | npm `5.6.1` |

The pinned Safe Research Policy Engine prior-art commit is `405ba1d91e85d0fd26abf0f645bf216822c8c595` from `safe-research/policy-engine` `main`, queried on 2026-09-17. It is explicitly unaudited prior art, not a dependency, compiled artifact, or deployment component.

## Verification performed

Commands required by the brief were run in the task worktree:

```text
git status --short                         # clean before changes
npm ci                                     # passed; 624 packages added
npm run build                              # passed; Compiled 6 Solidity files
npm test                                   # passed; 0 active tests
git diff --check                           # passed
```

The active build contains only the relocated `contracts/test/ERC20Mock.sol` among the current Solidity sources; legacy contracts were not compiled. The zero-test result is intentional for Task 1 because the only historical test was moved to `legacy/`; later tasks add active suites.

## Concerns and explicit limits

- npm reports 54 transitive vulnerabilities (4 low, 13 moderate, 29 high, 8 critical) and several deprecated transitive packages from the pinned Hardhat/tooling graph. They were not auto-fixed because changing them would exceed Task 1’s approved dependency evidence scope.
- npm also reports an optional TypeScript peer warning from viem’s transitive `ox` package; the lockfile still resolves reproducibly and the required build passes.
- Task 1 does not verify chain-specific deployed addresses, runtime bytecode hashes, or live audit scope. Those remain fail-closed gates for later dependency/deployment verification tasks.
- The future-facing scripts reference files introduced by later tasks. They currently report an explicit skip for absent inputs; once those inputs exist, the actual command executes and failures are not masked.
- The baseline script lanes currently report an explicit skip for absent later-task inputs; they do not suppress failures after those inputs are added.
