# SDK: reusable vault TypeScript

The SDK contains logic shared by the backend and core's operating tools: transaction encoding, policy classification, signer adapters, topology checks, provisioning, and monitoring. The contracts remain in [`../core`](../core/README.md). The SDK does not replace their authority.

This is a private source-TypeScript workspace. Publishing and compiled dual CommonJS/ESM distributions are outside this change. There is no root barrel: import the specific capability you need. Backend code keeps the existing Node-only facade:

```ts
import type { PwaIntent } from "@tiered-spending-guard/sdk/pwa";
import { classifyAction } from "@tiered-spending-guard/sdk/policy/classify";
```

## Folder guide

| Folder | Purpose |
| --- | --- |
| `src/config/` | Policy types/validation, official dependency identities, and reviewed Zodiac artifact parsing. `zodiac-delay` needs Node filesystem access; `policy` and `deployments` do not. |
| `src/policy/` | Advisory base/step-up/delayed/blocked classification. Contracts make the final authorization decision. |
| `src/topology/` | Deterministic address/plan building, verified deployment evidence, reviewed artifact resolution, and read-only topology checks. `reviewed-artifacts` is Node-only. |
| `src/queue/` | Delay queue encoding, cancellation/execution builders, fingerprints, and lifecycle reads. |
| `src/signers/` | Existing provider-neutral, passkey, and non-WalletConnect ECDSA adapters. They bind approval to the exact transaction. |
| `src/transport/` | Closed submission types, canonical encoding/hashes, RPC revalidation, and restricted relay/HTTPS interfaces. It supplies no backend secret or unrestricted signer. |
| `src/monitoring/` | Guard/Delay event decoding and verified lifecycle alerts. Durable ledgers and watcher runtime use Node; monitoring never authorizes spending. |
| `src/pwa/` | Existing browser-wallet backend API: profiles, exact intents, bounded provisioning, receipt observations, and authorization records. These implementations are Node-only; the folder name does not make them safe to bundle into a browser. `backend-api.d.ts` preserves the existing backend-facing declaration contract. |
| `src/live/` | Shared Node helpers for public creation code, exclusive journal leases, canonical receipts, and bounded outer submissions. Executable operating commands stay in core. |
| `src/resources.ts` | Internal Node reader that rejects missing, unlisted, or byte-mismatched generated resources. It never imports core runtime code. |
| `generated/` | Ignored build output: three compiled prerequisite artifacts, five public PWA JSON profiles/records, the reviewed Zodiac JSON, and a deterministic manifest. Core owns the authoritative inputs. |

Browser-compatible entry points include `config/policy`, `policy/classify`, `queue/delay`, `signers/*`, and the pure transport helpers. Import only a compatible subpath. Never import `pwa`, `live/*`, resource readers, durable monitoring, or reviewed-artifact loading into the browser. Browser writes continue through the backend.

## Build order and tests

```sh
pnpm core:build
pnpm core:verify:sdk
pnpm sdk:check
pnpm core:test
pnpm backend:test
```

Core compilation deterministically publishes the public resources. The SDK checks each requested resource against its generated manifest; it does not read core source to determine freshness. Core's build/check compares current sources, compiler inputs, artifacts, profiles, and the active lockfile with the manifest. Rebuild after changing those inputs. Run builds and backend tests serially: clean/compile intentionally invalidates old output.

The unified test suite stays in core to retain real Safe/Delay fixtures and contract integration. Application and operating code use package exports. Tests may use documented relative SDK source imports to reach adversarial/test-only helpers; those imports do not add test branding helpers to the backend/browser facade. Public and implementation imports must share one module instance so verification brands cannot split.
