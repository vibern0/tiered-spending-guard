# USDC Delayed-Tier Successor Design

**Status:** approved. On 2026-10-31 the user explicitly approved the focused successor described after row 9 stopped.

## Intent

Finish only the missing Sepolia USDC Z-tier expiry and ready-execution evidence. Preserve the existing 13-row delayed-completion attachment byte-for-byte, including row 9 at `signed-simulated` with outer nonce `916`, no transaction hash, and zero broadcasts. No extra USDC, X/Y replay, repair, retry, contract change, signer change, or native-AA work.

## Approaches

1. **Selected: a second append-only Z-only sibling.** Bind the exact progressed predecessor and add five rows for the existing expired queue plus one fresh queue lifecycle.
2. Reuse or reset stopped row 9. Rejected because it violates the one-attempt, no-repair boundary.
3. Replace the original delayed-completion attachment. Rejected because it would rewrite accepted receipts and proofs.

## Immutable Source

- Same Sepolia Safe, guard, Delay, USDC, funder, recipient, primary, and contract secondary.
- Exactly 19 successful live entries before this successor.
- Existing delayed-completion rows 1–8 remain terminal, row 9 remains hashless `signed-simulated`, and rows 10–13 remain `approved` historical bytes.
- Existing confirmed state is Safe nonce `13`, Delay transaction/queue nonces `5/6`, Safe/funder USDC `31,000,000/9,000,000`, with queue nonce `5` expired and active.
- Gross USDC already transferred under X/Y is 20 USDC. The successor may execute exactly 31 USDC once, preserving the aggregate 51-USDC cap. It performs no inward funding.
- Repair authority remains `NONE`; the whole-phase ETH ceiling remains `0.05 ETH`.

## Closed Catalog

Scope: `ordinary-usdc-delayed-tier-successor-v1`. Prefix every ID with `usdc-delayed-successor-`.

1. `skip-expired`: public `skipExpired()` for existing expired queue nonce 5.
2. `expired-execution-rejection`: prove execution of queue nonce 5 rejects; never broadcast.
3. `queue-execute`: queue the exact same 31-USDC transfer using primary plus contract secondary.
4. `queue-execute-early-rejection`: prove early execution rejects; never broadcast.
5. `queue-ready-execute`: after the real 120-second cooldown, publicly execute queue nonce 6.

Three broadcasts, two read-only rejection proofs. Start `13/6/5` when expressed as Safe/Delay-queue/Delay-transaction nonces and finish `14/7/7`. Start Safe/funder USDC `31/9`; finish `0/40`. Live entries finish at 22. Delayed execution must not credit or reset X/Y counters.

## Caps and Timing

- Safe queue gas cap `2,000,000`; each public Delay gas cap `300,000`.
- Maximum fee and priority-fee caps remain `1,000,000` wei/gas.
- New maximum reservation is `2,600,000,000,000` wei; cumulative accounting must remain below the existing `0.05 ETH` phase ceiling and within the existing successor gas allowance.
- One broadcast attempt per financial row; nonce or envelope drift after materialization permanently stops that row.
- Derive the active 86,400-second period and exclusive deadline from fresh canonical chain time. Never refresh an approved deadline.
- Preserve the real 120-second cooldown, six confirmations, canonical receipt inclusion, observer delivery, official acknowledgement, and keyless confirmation requirements.

## Source, Authority, and Execution

Two fixed providers must agree on the exact predecessor bytes and hash, topology, runtime, signers, balances, counters, Safe/Delay nonces, active expired queue, current/pending funder nonce, all known receipts, and selected-block rereads. Stop on mismatch, pending journal state, writer residue, or reorg.

The unsigned proposal has `authorization: NONE`. A new exact approval must bind this user instruction, the five-row catalog, source/certificate/observer/code hashes, 31/51-USDC caps, `2.6e12`-wei reservation, `0.05 ETH` phase ceiling, one-attempt rule, and `repairAuthority: NONE`. Independent artifact review must accept before approval is minted.

Implement a distinct sibling field. The atomic store must reject deletion, header replacement, predecessor mutation, mixed suffixes, status regression, multiple-row progress, and any second successor. Before materialization an agreed fresh outer nonce at or above the certificate minimum is allowed. After materialization, drift freezes the row. Persist a known transaction hash before the sole broadcast. Resume only an exact durable pending hash without keys.

## Completion

Complete only when all five successor rows are terminal, three new canonical receipts extend the exact live suffix, both rejection proofs have zero broadcast, terminal state is `14/7/7`, Safe/funder USDC is `0/40`, gross USDC remains 31 new and 51 aggregate, and required lifecycle alerts are acknowledged. Report every older stopped or untouched row separately. This remains testnet security evidence, not repair, audit, native AA, or production completion.
