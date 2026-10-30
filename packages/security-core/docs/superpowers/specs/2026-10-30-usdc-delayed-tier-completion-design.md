# USDC Delayed-Tier Completion Design

**Status:** selected. User said “Great, do that” after the exact narrow Z-only scope, duration, and unchanged limits were explained.

## Intent

Finish only live USDC delayed-tier evidence on the existing Sepolia Safe. X base and Y contract-secondary receipts already exist. Preserve every stopped row. No X/Y replay, Solidity, signer, policy, repair, EOA, WalletConnect, ERC-4337, mainnet, or production work.

## Approaches

1. **Selected: append-only delayed-completion sibling.** Freeze the current 15-live-entry journal and stopped fresh row. Attach one closed Z-only catalog.
2. Reset/reuse the stopped fresh row. Rejected: violates monotonic one-attempt storage.
3. Deploy another Safe. Rejected: unnecessary topology, gas, and evidence.

## Immutable source

- Existing Safe/guard/Delay/token/signers unchanged.
- Journal SHA-256 after the stopped attempt: `0x22c3171640cb450024ba6d4964b67ed6e761e75573ac451dffdd3342d6cee07a`.
- Exactly 15 successful live entries.
- Fresh sibling row 1 is `signed-simulated`, outer nonce `905`, without intent hash, transaction hash, receipt, or live entry. Rows 2–18 remain `approved`.
- No repair attachment. Repair authority stays `NONE`.
- Prior gross USDC outflow: 20 USDC. New cap: 31 USDC. Aggregate cap: 51 USDC. Inward funding: 31 USDC. Native principal: zero.

## Closed catalog

Scope: `ordinary-usdc-delayed-tier-completion-v1`. Prefix every ID with `usdc-delayed-completion-`.

1. `prefund-all`: fund Safe with 31 USDC.
2. `direct-above-y-rejection`: exact 31-USDC direct Safe transfer rejects.
3. `queue-cancel`: queue exact 31-USDC transfer with primary plus contract secondary.
4. `queue-cancel-early-rejection`.
5. `queue-cancel-action`.
6. `queue-cancelled-execution-rejection`.
7. `queue-expiry`: queue same transfer.
8. `queue-expiry-early-rejection`.
9. `queue-expiry-skip` after 120+600 seconds.
10. `queue-expired-execution-rejection`.
11. `queue-execute`: queue same transfer.
12. `queue-execute-early-rejection`.
13. `queue-ready-execute` after 120 seconds.

Seven broadcasts: one funding, four Safe, two public Delay. Six proofs never broadcast. Start Safe/Delay `10/4/4`; finish `14/7/7`. Start Safe/funder USDC `0/40`; finish `0/40`. Live entries finish at 22. Raw USDC counters remain the exact pre-action tuple; delayed execution never credits or resets X/Y.

## Caps and time

- Funding gas `740292`; Safe gas `2000000`; public Delay gas `300000`.
- Max fee and priority fee `1000000` wei/gas.
- Exact reservation: `9340292000000` wei.
- Maximum cumulative outlay: `140501418272986` wei, below `0.05 ETH`.
- One broadcast attempt per financial row.
- Schedule: review 600, execution 1800, confirmations 180, delivery 60, acknowledgement 180, keyless confirmation 180 seconds.
- Required observer lifetime/admission: 3600 seconds. Groups 1–2: 300; 3–6: 600; 7–10: 1200; 11–13: 600; reconciliation margin: 300.
- Derive the active 86,400-second period and deadline from fresh canonical time. Never refresh an approved deadline.

## Source, authority, and execution

Two fixed providers must agree on canonical topology, runtimes, balances, counters, Safe/Delay nonces, empty queue, current/pending outer nonce, the 15 receipts, faucet receipt, and stopped-row bytes. Re-read the selected block hash. Stop on pending journal state, writer residue, mismatch, or reorg.

Proposal has `authorization: NONE`. Exact approval binds the user’s Z-only instruction, 31/51 USDC limits, observer, certificate, catalog, caps, code head, and `repairAuthority: NONE`.

Add exactly one append-only sibling. Freeze all predecessor headers, rows, receipts, and live entries. Before materialization, accept an agreed current outer nonce at or above the certificate minimum. After materialization, drift permanently stops the selected row. Persist the outer hash before one broadcast. Resume only an exact durable pending hash without keys.

Each queue requires primary plus contract secondary. Cancellation uses the same pair. Skip and ready execution are public Delay calls. Require real cooldown/expiry, six confirmations, canonical receipt/effect, stock watcher delivery, and official acknowledgement for lifecycle alerts.

## Completion

Complete only when all 13 rows are terminal, seven new receipts extend the exact live suffix, gross/inward/gas accounting matches, three queue lifecycles are independently evidenced, terminal state is `14/7/7`, Safe USDC is zero, and funder USDC is 40. Report old stopped rows separately. This is testnet evidence, not repair, native-AA, audit, or production completion.
