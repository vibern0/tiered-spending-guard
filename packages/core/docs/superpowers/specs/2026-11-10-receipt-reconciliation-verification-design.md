# Automatic Receipt Reconciliation and Verification Reads

Implement the user's requested automatic receipt reconciliation, batching and fewer duplicate reads. Preserve all security checks.

## Approach

Backend owns durable reconciliation. A single-flight, read-only worker inspects pending submission journals, including after restart, and calls existing exact-hash status reconciliation. Browser updates known submission statuses without authorizing, signing or broadcasting. Terminal receipt requirements remain two-provider agreement, six canonical confirmations and the existing successful-execution observation proof.

Verification keeps every authorization boundary. Batch independent JSON-RPC reads and execute independent topology reads concurrently; retain deterministic verification/report ordering. Deduplicate identical explicit-block reads only inside one provider-local collection. Never cache head, chain identity or block-anchor reads; never reuse a collection across approvals, signing, broadcast, providers or accounts. Remove redundant immediately adjacent snapshot collection by returning the fresh, semantically revalidated snapshot to its immediate consumer.

Alternatives: browser-only reconciliation leaves closed-tab/restart payer blockers; global or timed verification caches risk stale authorization; dropping confirmation or topology checks violates scope. These are rejected. No contract, dependency, provisioning sequence, signer, session or policy change.

## Proof

Use failing-first tests for worker startup/retry/shutdown/overlap and durable pending-only selection; browser restoration, eventual terminal display, session isolation and stopped polling; batching with real local JSON-RPC transport; scoped read isolation and uncached anchors; unchanged real-Safe tier/lifecycle and observer tests. Measure read/request reduction with deterministic counts. Do not sign or broadcast on live Sepolia.

## Review fixes

Restored first-terminal responses compare receipt block with the account-scoped projected snapshot. Newer or unknown coverage refreshes; covered history does not. Batches require the complete unique expected response-ID set and exclusive JSON-RPC result/error envelopes before library demultiplexing. Regression proofs cover both findings.
