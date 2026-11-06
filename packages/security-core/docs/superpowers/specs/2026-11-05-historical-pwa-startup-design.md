# Historical PWA Vault Startup Compatibility

## Intent and authorization

Restore startup for the existing completed Sepolia vault. User approved the prior focused historical read-only compatibility proposal on 2026-11-05. Keep the newer recipient-mode write gates intact.

## Approaches

- **Selected:** pin original/completed package hashes; verify historical evidence and old all-lanes allowlist topology through two fixed RPC providers. Return a distinct read-only record. No planner, artifact reconstruction, writer, or current provisioning brand.
- Rebuilding old contracts/profiles inside the current write planner adds obsolete execution paths; excluded.
- Redeploying/upgrading changes custody configuration; outside this request.

## Boundaries

- Only the explicitly committed original/successor package pair. No filename, browser, or environment override.
- Exactly seven successful journal rows. Canonical content hashes, committed consumed lineage, historical intent/cost hashes, six-confirmation receipts, and every deployed runtime must match through both providers.
- Live confirmed nonce consensus and completion floor remain mandatory. Pending unrelated activity is allowed as documented by the completed-deployment amendment.
- Verify official dependencies, signer-factory bindings, Safe owner/threshold/fallback/both guards/only Delay, guard identities/old policy hash/limits/recipients/counters, maintenance bindings, and Delay owner/avatar/target/upstream/cooldown/expiration. Pin topology reads to one common canonical block; reject changed or inconsistent reads.
- Return `mode: "read-only"`, historical profile identity, public addresses, old policy, and evidence. Never issue `PwaProvisioningResult` or a current snapshot capability.
- Backend selects this explicit path before current reconstruction. Historical verification errors stop startup; there is no catch-and-continue fallback.
- `/health` reports `writesReady: false` and historical compatibility. `GET /v1/vaults/current` returns the verified public record. POST routes and direct handler write methods reject historical mode, even with injected submission callbacks.
- No credential registration/rebind, new deployment, upgrade, signature, broadcast, operational-file rewrite, dependency, or Solidity change.

## Acceptance

Compatible historical evidence starts the real backend. Unknown packages, incomplete/pending journals, reorgs, changed code/policy/topology, inconsistent providers, and write attempts fail closed. Fresh/current provisioning retains its existing behavior. Verify local suites and actual loopback startup against existing files; compare operational-file hashes before/after.

## Browser read compatibility follow-up — 2026-11-05

The browser previously decoded every guard with the newer five-word `assetPolicy(address)` response. The historical guard returns four words, so viem rejected the read and discarded the balance snapshot. Browser snapshots now hash the actual guard runtime at the same canonical block as all other reads. Only the exact historical runtime `0x596a66022b0aa360ed7faa0ba2fa550480f6b750a3ccc44da125ff14eff38428` selects the explicit old four-word ABI. All other guards retain the current ABI; a failed or truncated modern response is never retried as historical.

A successfully read historical snapshot retains balances, limits, recipients, counters, nonce, and queue activity, with an explicit read-only compatibility marker. The historical recipient policy remains allowlisted on every tier. Compatibility alone is not a verification failure, and it never enables writes. Real topology/RPC/USDC failures remain blocking and visible. Store preparation and approval reject read-only mode before backend or signer calls, including cached credential state. The UI displays an earlier-version read-only notice instead of a misleading decoder failure or generic writable-health success. Backend historical validation and write denial remain unchanged.
