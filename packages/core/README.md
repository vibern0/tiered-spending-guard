# Core: contracts and operating tools

This package owns the contracts and the tools used to build, verify, rehearse, and operate them. Reusable TypeScript lives in [`../sdk`](../sdk/README.md); the browser's write boundary remains [`apps/backend`](../../apps/backend/README.md).

This is security research and a testnet prototype. The package move does not complete the live Sepolia, independent-alert, independent-review, or audit gates.

## Read these folders

| Folder | Purpose |
| --- | --- |
| `contracts/` | Vault guard and approved setup/maintenance contracts. `libraries/` contains internal digest/signature helpers. `test/` contains contracts used by automated tests. |
| `scripts/` | Commands for unsigned plans, dependency/deployment verification, monitoring, local rehearsals, and reviewed testnet operations. These are entry points, not the SDK. |
| `scripts/live/` | Reviewed ordinary-Safe CLI workflows. Shared journal/lease/submission implementations now live in SDK `src/live/`. Some commands can sign or broadcast when deliberately configured; inspect their existing gates before running them. |
| `scripts/pwa/` | Local browser-wallet rehearsal, profile capture, observation, and evidence commands. |
| `scripts/test/` | Tests the resource build bridge with disposable files, separately from Hardhat coverage. |
| `scripts/security/` | Input validation for safe rehearsals and validation of the Slither report/baseline. |
| `test/` | Contract, SDK, actual Safe/Delay integration, invariant, and CLI tests. `unit/` checks components; `integration/` checks composed flows; `invariant/` checks stateful policy; `helpers/`, `support/`, and `fixtures/` provide test data/adapters. |
| `config/` | Authoritative public profiles, policy settings, reviewed dependency artifacts, and runtime allowlists. `artifacts/` contains committed upstream data, not locally compiled output. |
| `deployments/` | Public deployment manifests/examples. They contain no private credentials. |
| `docs/` | Research, security decisions, call graph, plans, test guidance, and public historical evidence. Start with [`research/`](docs/research/2026-09-16-personal-vault-research.md). |
| `legacy/` | Quarantined 2024 experiment. It is excluded from active compilation and provides no current security evidence. |
| `artifacts/`, `cache/`, `coverage/` | Generated compiler/test output. Never edit these as source. |

`hardhat.config.ts` pins the existing compiler settings and publishes public SDK resources after a successful normal compile. `.solcover.js` preserves reviewed artifacts during instrumented tests. `slither.config.json` and `slither-baseline.json` define the existing static-analysis gate.

## Build and verify

From the repository root:

```sh
pnpm core:build
pnpm core:verify:sdk
pnpm core:test:resources
pnpm sdk:check
pnpm core:test
pnpm core:rehearse
pnpm core:coverage
pnpm core:slither
```

Build core before starting the backend. Compilation generates the SDK's public contract/configuration resources; it copies the exact authoritative bytes, records input/resource hashes, and publishes only a complete set. Normal clean/failed builds invalidate consumable output. Do not rebuild/clean core while a backend process is using these local development files. A build can temporarily make resources unavailable; the SDK fails closed.

Coverage keeps the reviewed pre-instrumentation SDK output and existing reviewed-artifact snapshot behavior. Coverage cannot publish instrumented artifacts into the SDK. After coverage, run `pnpm core:build` before using normal build freshness checks again.

The old root `security-core:*` commands remain aliases to `core:*` for saved runbook commands. The old package import name and source directory are removed. Source paths embedded in historical evidence describe that historical run; moving files does not rewrite or re-attest those records. Historical npm/Yarn lock snapshots remain historical; `pnpm-lock.yaml` is the active workspace lockfile.
