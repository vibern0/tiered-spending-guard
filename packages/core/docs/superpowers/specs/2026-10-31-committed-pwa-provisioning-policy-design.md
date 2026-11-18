# Committed PWA Provisioning Policy Design

## Intent

Make fixed Sepolia deployment policy reviewable with code. Remove `reviewed-artifacts.json`: operators must not reconstruct global profile, artifact, salt, or signer-hash inputs outside Git.

## Goals

- Commit fixed profile, Safe proxy salt `0`, exact Zodiac Delay v1.1.1 source, and Safe passkey proxy creation-code anchor.
- Derive each credential-specific signer runtime hash from pinned `@safe-global/safe-passkey@0.2.0` creation code plus factory `SINGLETON()`, credential coordinates, and verifier.
- Keep exact unsigned wallet review, approval JSON, independently recorded approval digest, and both journals outside Git.
- Reject the retired `BACKEND_REVIEWED_ARTIFACTS` setting so operators cannot think it still authorizes anything.
- Preserve the loopback backend as sole browser write boundary.

## Non-goals

- No live deployment, funding, mainnet claim, Task 10–12 completion, or weaker approval gate.
- No dependency/version/contract change.
- No browser-selected policy, address, nonce, fee, artifact, signer, or approval.

## Constraints

- Testnet security research only.
- All deployment dependencies remain live-bytecode verified.
- Generated plans remain unsigned and reproducible before human approval.
- Distinct passkeys must produce distinct runtime hashes; one shared hash is invalid because proxy runtime embeds credential data.
- Migration is fail closed: legacy external reviewed-input files are not dual-read.

## Approaches

1. **Chosen: committed policy plus runtime derivation.** Move the already committed, SHA-256-pinned Delay source from test fixtures to reviewed config; load the committed profile; pin Safe proxy creation-code hash; simulate each credential-specific proxy constructor to derive runtime hashes. Least operator ambiguity and no new trust input.
2. Keep external JSON but generate it. Rejected: it duplicates repository policy and preserves an impossible shared signer hash.
3. Commit per-wallet generated plans. Rejected: wallet credentials, nonces, fees, and approvals are operational state, not global source policy.

## Design

`security-core` owns a committed policy accessor and committed Delay artifact loader. The artifact resolver no longer accepts caller-provided Delay bytes. PWA infrastructure resolution reads the verified signer factory singleton, builds the pinned signer proxy constructor code for both credentials, simulates creation through read-only `eth_call`, and binds each returned runtime hash to its signer transaction. Final topology verification rechecks both signer runtimes.

The backend removes `reviewedArtifactsPath`; concrete provisioning uses the committed profile and salt `0`. `BACKEND_REVIEWED_ARTIFACTS`, when present, is rejected as retired. External paths remain mandatory for the provisioning review directory, approval, approval digest, provisioning journal, and submission journal.

## Rollback

Revert this change as one commit. Existing external review, approval, and journal data is not modified. No migration deletes files. The retired JSON may remain on disk but is never read.
