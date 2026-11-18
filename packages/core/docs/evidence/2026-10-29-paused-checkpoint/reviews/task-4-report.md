# Task 4 implementer report

Status: DONE

## Implemented

- Added the closed `review` / `submit-one` / `resume-one` recycle continuation CLI and all requested exports.
- Reused the genuine predecessor loader, opaque certificate/proposal/approval capabilities, canonical provider adapter, shared state reader, default execution context, action selector/executor, and atomic store.
- Added the root-approved narrow descendant-journal snapshot adoption path. The historical helper now invokes the recycle continuation's closed pinned decoder itself before restoring the historical snapshot; byte equality and the fixed prefix are also rechecked. The old generic loader and old CLI behavior remain unchanged.
- Added two fixed no-transport-retry Sepolia public clients for this CLI. Each client has one shared retry budget for explicit-block `getCode` / viem `getBytecode` JSON-RPC `-32001`: identical arguments, same client, 250 ms, once.
- Added exact vetted public runtime and Zodiac Delay source fixtures. Their raw SHA-256 values, every runtime keccak, and credential-shaped-content exclusions are asserted in tests. The Delay fixture is 404,484 bytes because the production parser requires the exact pinned source digest.
- Added one offline production-composition regression through the actual CLI, real atomic store, actual `createOrdinaryScenarioStateReader`, actual reconstruction/profile/topology verification, and actual `createOrdinaryScenarioExecutionContext`. Both provider retry budgets are exercised, one action is materially frozen and simulated, exactly one fixed-funder signing callback is reached, the missing real key fails closed, broadcast remains zero, and the old stopped row/live prefix remain unchanged.
- Kept the separate fresh-process atomic attachment regression and exact observer ISO forwarding regression.
- Added an actual viem `custom` transport regression for wrapped `-32001`, including identical `eth_getCode` params.
- Updated the call graph and testnet runbook in the first Task 4 commit.
- No network, private file, real key, Sepolia signing, broadcast, authoritative journal, machine approval, or external message was used.

## TDD evidence

### RED

Command:

```sh
cd packages/security-core && npx hardhat test test/unit/security/ordinary-usdc-recycle-continuation-cli.test.ts
```

Result: exit 1. Hardhat failed with `Cannot find module '../../../scripts/live/ordinary-scenario-usdc-recycle-continuation-cli'`, the expected missing production interface.

During GREEN integration, the fresh-process regression first failed with `hashless source journal shape mismatch`. Root approved the narrow read-only amendment.

The first actual-default composition attempt reached `journal identity mismatch` when an ephemeral signer was used. This proved the real submission primitive cryptographically binds the journal to the fixed Sepolia funder. Root ruled that the offline test must stop at one controlled sign callback with zero broadcast rather than fabricate a key or matching raw transaction.

### GREEN

Focused command:

```sh
cd packages/security-core && npx hardhat test test/unit/security/ordinary-usdc-recycle-continuation-cli.test.ts
```

Result: exit 0, `15 passing (586ms)`.

Affected command:

```sh
cd packages/security-core && npx hardhat test test/unit/security/ordinary-usdc-recycle-continuation-cli.test.ts test/unit/security/ordinary-usdc-recycle-continuation-certificate.test.ts test/unit/security/ordinary-usdc-successor-cli.test.ts test/unit/security/ordinary-scenario-hashless-continuation-cli.test.ts test/unit/security/ordinary-usdc-recycle-continuation-executor.test.ts test/unit/security/ordinary-usdc-successor-executor.test.ts test/unit/security/live-submission.test.ts test/integration/ordinary-scenario-adapter.test.ts && git diff --check
```

Result: exit 0, `74 passing (4s)`; `git diff --check` clean.

The named local integration proof is `ordinary scenario adapter against real local Safe/WebAuthn`, including exact signed calldata and six-block confirmation. The named submission proof is `bounded Sepolia submission journal / persists the locally computed transaction hash before broadcasting`. Together they prove the unchanged submission primitive's genuine one-sign/one-broadcast durability ordering in the local 31337 environment; the offline production-composition regression proves the fixed Sepolia CLI reaches that same primitive and fails closed without the reviewed funder key.

`npx tsc --noEmit` exits 2 on repository baseline diagnostics. Filtering its output produced no diagnostic for the Task 4 CLI, certificate modules, or test.

## Files changed

First commit:
- `packages/security-core/scripts/live/ordinary-scenario-usdc-recycle-continuation-cli.ts`
- `packages/security-core/test/unit/security/ordinary-usdc-recycle-continuation-cli.test.ts`
- `packages/security-core/scripts/live/ordinary-scenario-usdc-successor-cli.ts`
- `packages/security-core/scripts/live/ordinary-scenario-hashless-certificate.ts`
- `packages/security-core/docs/security/call-graph.md`
- `packages/security-core/docs/security/testnet-runbook.md`

Pre-review completion commit:
- `packages/security-core/scripts/live/ordinary-scenario-hashless-certificate.ts`
- `packages/security-core/scripts/live/ordinary-scenario-usdc-recycle-continuation-certificate.ts`
- `packages/security-core/test/unit/security/ordinary-usdc-recycle-continuation-cli.test.ts`
- `packages/security-core/test/fixtures/ordinary-usdc-recycle-continuation-runtimes.public.json`
- `packages/security-core/test/fixtures/ordinary-usdc-recycle-continuation-delay-mastercopies.public.json`

## Self-review

- Review remains `authorization: NONE`; no observer override or private boundary is exposed.
- Submit requires exact `LIVE_SUBMIT=YES`, exact approval, same source/journal path, public preflight, no pending row, and an awaited store lease.
- Resume rejects credentials and requires one pending hash only in the new sibling.
- Source comparison occurs under lease before the CLI's own save; fresh reopening does not compare against stale original bytes.
- The strict descendant adoption helper executes the closed recycle codec before adding the historical snapshot. A same-file/same-object unknown field is rejected.
- Each provider consumes one bounded pinned-code retry; the actual default regression observes exactly two controlled failures total.
- The actual default regression uses genuine opaque public providers and exact vetted bytecode/artifact bytes. It injects only read-only RPC facts and the outer live callbacks, never a replacement reader, context, certificate brand, or reconstructed profile.
- One new materialization and simulation persist before the sole sign callback. The absent fixed-funder key stops with zero broadcast and no live-journal suffix. Old USDC successor row 3 remains `signed-simulated`.
- The root-owned plan and spec amendments were not staged or committed.

## Commits

- `d3db6882c14802c69f2f7f7db0f430d4e7789d02 feat: expose bounded USDC recycle CLI`
- `224873f test: prove recycle CLI production composition`

## Limitation

A successful fixed-funder Sepolia broadcast is intentionally ROOT LIVE only after code and exact-artifact review/approval. Offline evidence does not claim a successful production CLI broadcast; it proves the real production path reaches the cryptographic signing gate and refuses to fabricate authority.
