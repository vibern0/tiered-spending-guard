# Read-only verification profiling

This diagnostic measures the verification core used by the loopback backend. It is security-research tooling for Ethereum Sepolia, not evidence of production readiness or end-to-end send performance.

## Run a capture

Use the repository's pinned Node version and run from its root. The external account directory must contain the original `reviews/` and a `provisioning.json` with all seven successful deployment receipts. Preserve these files; do not edit or reconstruct a journal to make recovery pass.

```sh
npm run backend:profile:verification -- --account-directory /absolute/external/account --samples 3
```

The command requires no signer key, backend session, passkey prompt or backend environment configuration. It recovers the completed deployment, restores the existing vault, then runs 1–5 verification samples. It cannot provision an incomplete account.

Optional `--output-directory /new/external/directory` selects a new directory outside the repository and source evidence. Existing output directories are refused. Without it, output goes to a new private temporary directory. The command prints the location; after capture starts, failure retains partial artifacts there and exits unsuccessfully.

## Historical evidence and reader operators

The default reader pair is Publicnode/Tenderly. A diagnosed Publicnode retention limit advertised by `eth_capabilities` was 10,064 blocks for receipts, logs and historical state. The affected first deployment receipt was approximately 29,000 blocks old. Publicnode still returned its transaction and block header, but returned no receipt. Those responses do not prove receipt status, logs or the required historical state. No tested same-provider method recovered the missing evidence.

An explicit approved `infura-archive` profile uses Infura as the first reader and the fixed Tenderly reader as the second. The operator's existing private Infura service returned the required historical receipt and state during diagnosis. Availability must still be verified on every run. Read batches contain at most four calls; a shared member-weighted queue paces the fixed public Tenderly endpoint, including across reader instances, to avoid bursts that produced HTTP 429 in live captures. Queued canceled reads never start a network request. This preserves all evidence reads and the existing bounded transport timeout/retry behavior. This is a replacement of the complete evidence reader pair, not an automatic receipt fallback. Without opt-in, unavailable default evidence continues to fail closed.

Create a private JSON file **outside the repository**, mode `0600`, with exactly these fields. Replace the placeholder locally with the existing Sepolia Infura project key; never commit it or include it in command output:

```json
{
  "version": 1,
  "profile": "infura-archive",
  "rpcUrl": "https://sepolia.infura.io/v3/<32-hex-project-key>"
}
```

Only this named profile is accepted. Its URL must use HTTPS, exact host `sepolia.infura.io` and `/v3/` followed by the 32-hex project key. Credentials in the URL authority, explicit ports, queries, fragments and redirects are rejected. The second reader cannot be changed by this file. Unknown fields or invalid/missing configuration fail closed.

For the diagnostic, pass the file explicitly:

```sh
npm run backend:profile:verification -- --account-directory /absolute/external/account --evidence-config /absolute/private/read-evidence.json --samples 3 --output-directory /new/external/profile
```

For the local backend, set `BACKEND_EVIDENCE_CONFIG_PATH=/absolute/private/read-evidence.json` in the external launch configuration. This selects read evidence only. `BACKEND_RPC_URL` and the existing loopback backend remain the transaction relay/write boundary; the evidence URL is never used for signing or broadcasting. The profiler does not need the relay key or relay configuration.

Historical reviewed profile/provider commitments remain unchanged so original plans and authorization evidence retain their identities. Current source labels identify the actual Infura/Tenderly operators. The capture's closed `evidenceProfile` and operator labels permit comparisons without disclosing the URL or project key. Both readers must still agree on canonical evidence; six-confirmation requirements and the independent execution observation proof remain mandatory. Selecting an archive service grants no authorization, invents no receipt and weakens no confirmation threshold.

## Read the artifacts

| File | Use |
| --- | --- |
| `summary.json` | Completion/failure status; selected evidence profile/operators; stage wall time and process user/system CPU time; provider HTTP/RPC counts, batch sizes and body bytes. |
| `verification.trace.json` | Chrome Trace Event JSON showing recovery, restoration, verification samples and overlapping provider requests. |
| `verification.cpuprofile` | V8 sampled function stacks for CPU investigation. |

Keep the cold recovery and restoration measurements separate from the repeated `verification` samples. The first sample may differ from later samples because of process or provider warm-up; this is not a controlled cold-cache benchmark. With only 1–5 samples, report individual values and sample count. A p50 or p95 is merely descriptive for that tiny run, not a reliable latency distribution or service-level estimate. Compare successful runs with the same evidence profile and sample conditions.

Process CPU time is not wall time and does not directly measure network wait. HTTP durations overlap and may sum to more than the capture's wall time. They begin when a request reaches fetch; pacing waits are included in phase wall time, not the HTTP-duration totals. `bytes` counts only decoded response-body chunks actually consumed by the verifier; it excludes headers, request bytes, compression savings and network framing. It is not wire traffic or a billable bandwidth measurement. HTTP request counts and RPC call counts differ when requests contain batches.

Open the trace using **Open trace file** in a trusted local Perfetto viewer. Inspect the phase track alongside both provider tracks to see waits and overlap. Load the `.cpuprofile` through Chrome DevTools' **Performance → Load profile** to inspect function costs. Use a trusted local viewer when reviewing sensitive source paths; do not upload artifacts to a hosted analysis service without reviewing them first. The capture command uploads no files.

## Scope and privacy

Included: completed-evidence recovery, completed-vault restoration, and dependency/topology/policy verification. Excluded: browser rendering, passkey interaction, backend snapshot collection, submission simulation, signing, broadcast, block inclusion and confirmation waiting. A controlled browser send must measure those stages separately.

Only explicitly allowed read-only RPC methods and the selected two endpoints are permitted. Redirects and write/sign methods are blocked before the network call; response-ID validation remains active. Source journals/reviews are neither written nor locked. Summary and trace retain closed stage/method/provider labels and timings/counts, not request parameters, URLs, project keys, addresses, account identifiers, credentials, assertions, headers or raw errors. CPU profiles contain function names and source locations rather than heap values; local filesystem paths may remain visible. Keep artifacts private until reviewed.

## Troubleshooting

- **Missing confirmed deployment evidence:** inspect the closed failure code and partial phases. A stored receipt alone is insufficient when a live reader cannot independently retrieve it. Retain the original evidence; use the explicit approved profile when appropriate.
- **Archive profile still fails:** check local file permissions/schema and service access without printing the URL or key. Both operators must supply consistent chain, receipt and historical-state data. Do not fall back to one reader, a fabricated journal entry or a receipt copied from an explorer.
- **Capture exits unsuccessfully:** `completed: false` means the run did not complete verification. Preserve its trace for diagnosis; never pool partial timings with successful samples.
- **Output path refused:** choose a new absolute external directory outside the account evidence. Do not reuse a previous capture directory.

The diagnostic cannot repair missing evidence, sign a transfer, rebroadcast a pending transaction or bypass readiness checks. Restore provider evidence or resolve its inconsistency before treating verification as successful.


## Observed live capture — 2026-11-10

The completed historical seven-transaction account passed recovery, restoration and all three verification samples using the explicit Infura/Tenderly profile on Node 24.21.0. The [redacted measured report](../evidence/2026-11-10-verification-profile.json) records the capture completed at 23:03:30 UTC.

| Phase | Wall time | Process CPU (user + system) |
| --- | ---: | ---: |
| Recovery | 7.595 s | 0.795 s |
| Restoration | 5.690 s | 0.519 s |
| Verification 1 | 7.716 s | 0.643 s |
| Verification 2 | 8.269 s | 0.670 s |
| Verification 3 | 7.269 s | 0.519 s |

The whole capture made 344 HTTP attempts containing 517 RPC calls, including 14 transaction-envelope reads and 15 receipt reads. Maximum batch size was four. Infura recorded no HTTP failures; Tenderly returned three HTTP 429 responses that recovered through the existing bounded retries. The final proofs all passed. Three samples describe this run only; unavailable/failed earlier captures are not successful baselines, so no percentage speedup or reliable percentile is claimed.

Process CPU was much smaller than wall time in these samples. Together with provider request spans, this points to RPC/service/queue waits as the main remaining cost, rather than local computation. This is an inference from this capture, not a measurement of exact network-wait time. Pacing is shared within one process; separate profiler/backend processes and other clients can still compete for the public provider quota. Existing request timeouts include queue wait, and overload still fails closed.

All seven source files were byte-identical before and after, and the payer nonce was unchanged. Artifact scans found no endpoint/project key or EVM address; generated files were private. The full Perfetto and CPU files remain outside the repository. No transaction was signed, broadcast or deployed. Wallet interaction, submission snapshot/simulation and chain confirmation latency remain outside this measurement.
