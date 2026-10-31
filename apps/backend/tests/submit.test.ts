import type { Address, Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { SubmissionJournal } from "../src/journal";
import { prepareUsdcTransfer, SafeSubmissionService } from "../src/vault";

const SAFE = "0x1111111111111111111111111111111111111111" as Address;
const GUARD = "0x2222222222222222222222222222222222222222" as Address;
const USDC = "0x3333333333333333333333333333333333333333" as Address;
const RECIPIENT = "0x4444444444444444444444444444444444444444" as Address;
const HASH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
const PRIMARY = `0x${"11".repeat(65)}` as Hex;
const SECONDARY = `0x${"22".repeat(65)}` as Hex;

async function request(amount: bigint) {
  return prepareUsdcTransfer({
    chainId: 11155111, safe: SAFE, guard: GUARD, usdc: USDC, configuredUsdc: USDC, recipient: RECIPIENT, amount, nonce: 3n,
    deploymentHash: HASH, policyHash: HASH, idempotencyKey: (`0x${amount.toString(16).padStart(64, "0")}`) as Hex,
    signatures: PRIMARY, expectedSpend: { window: 0n, baseSpent: 0n, instantSpent: 0n }, allowedRecipients: [RECIPIENT],
  });
}

function service(overrides: Partial<ConstructorParameters<typeof SafeSubmissionService>[0]> = {}) {
  return new SafeSubmissionService({
    journal: new SubmissionJournal(), limits: { baseDailyLimit: 250_000_000n, instantDailyLimit: 1_000_000_000n },
    verifySignature: vi.fn().mockResolvedValue(true), broadcast: vi.fn().mockResolvedValue(`0x${"bb".repeat(32)}` as Hex),
    ...overrides,
  });
}

describe("bounded Safe submissions", () => {
  it("submits a base-tier transfer with the primary signature only", async () => {
    const submitter = service(); const prepared = await request(100_000_000n); submitter.prepare(prepared);

    const result = await submitter.submitPrimary(prepared.idempotencyKey, PRIMARY);

    expect(result.state).toBe("confirmed");
    expect(result.requiredApprovals).toBe("primary");
    expect(submitter.broadcast).toHaveBeenCalledTimes(1);
  });

  it("requires the primary before secondary and combines both for step-up", async () => {
    const submitter = service(); const prepared = await request(300_000_000n); submitter.prepare(prepared);

    await expect(submitter.submitSecondary(prepared.idempotencyKey, SECONDARY)).rejects.toThrow(/primary/i);
    await expect(submitter.submitPrimary(prepared.idempotencyKey, PRIMARY)).resolves.toMatchObject({ state: "awaiting_secondary", requiredApprovals: "secondary" });
    await expect(submitter.submitSecondary(prepared.idempotencyKey, SECONDARY)).resolves.toMatchObject({ state: "confirmed", requiredApprovals: "secondary" });
    expect(submitter.broadcast).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid exact-digest signature before broadcast", async () => {
    const verifySignature = vi.fn().mockResolvedValue(false); const submitter = service({ verifySignature }); const prepared = await request(100_000_000n); submitter.prepare(prepared);

    await expect(submitter.submitPrimary(prepared.idempotencyKey, PRIMARY)).rejects.toThrow(/signature/i);
    expect(submitter.broadcast).not.toHaveBeenCalled();
    expect(verifySignature).toHaveBeenCalledWith("primary", expect.objectContaining({ safeTxHash: prepared.safeTxHash }), PRIMARY);
  });

  it("reconciles an uncertain broadcast before allowing another attempt", async () => {
    const broadcast = vi.fn().mockRejectedValue(new Error("connection lost"));
    const reconcile = vi.fn().mockResolvedValue({ status: "confirmed" as const, transactionHash: `0x${"cc".repeat(32)}` as Hex });
    const submitter = service({ broadcast, reconcile }); const prepared = await request(100_000_000n); submitter.prepare(prepared);

    await expect(submitter.submitPrimary(prepared.idempotencyKey, PRIMARY)).rejects.toThrow(/connection lost/);
    await expect(submitter.submitPrimary(prepared.idempotencyKey, PRIMARY)).resolves.toMatchObject({ state: "confirmed", transactionHash: `0x${"cc".repeat(32)}` });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith(prepared);
  });
});
