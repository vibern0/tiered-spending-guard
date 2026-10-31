import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { SubmissionJournal } from "../src/journal";
import { PwaSubmissionService, type BackendPreparedSubmission } from "../src/vault";

const HASH = `0x${"aa".repeat(32)}` as Hex;
const OUTER = `0x${"bb".repeat(32)}` as Hex;
const BLOCK = `0x${"cc".repeat(32)}` as Hex;

function prepared(requiredApprovals: readonly ("primary" | "secondary")[] = ["primary"]): BackendPreparedSubmission {
  return Object.freeze({ id: "request-1", requestHash: HASH, safeTxHash: HASH, kind: requiredApprovals.length === 1 ? "base-transfer" : "step-up-transfer", requiredApprovals, publicRequest: Object.freeze({ kind: "transfer", recipient: "0x1111111111111111111111111111111111111111", amount: "1000000", idempotencyKey: "request-1" }) });
}

function service(overrides: Partial<ConstructorParameters<typeof PwaSubmissionService>[0]> = {}) {
  return new PwaSubmissionService({
    journal: new SubmissionJournal(),
    verifyApproval: vi.fn(async (role) => ({ role, payload: (role === "primary" ? "0x11" : "0x22") as Hex })),
    revalidate: vi.fn().mockResolvedValue(undefined), deriveOuterHash: vi.fn().mockResolvedValue(OUTER), broadcast: vi.fn().mockResolvedValue(OUTER),
    reconcile: vi.fn().mockResolvedValue({ status: "confirmed", transactionHash: OUTER, blockNumber: 12n, blockHash: BLOCK }), ...overrides,
  });
}

describe("durable PWA submissions", () => {
  it("requires primary before secondary and stores approval presence only", async () => {
    const runtime = service(); runtime.prepare(prepared(["primary", "secondary"]));
    await expect(runtime.submit("request-1", { role: "secondary", assertion: { id: "s" } })).rejects.toThrow(/primary/i);
    await expect(runtime.submit("request-1", { role: "primary", assertion: { id: "p" } })).resolves.toMatchObject({ state: "awaiting-secondary" });
    await expect(runtime.submit("request-1", { role: "secondary", assertion: { id: "s" } })).resolves.toMatchObject({ state: "confirmed", transactionHash: OUTER });
    expect(runtime.broadcast).toHaveBeenCalledTimes(1);
    await expect(runtime.status("request-1")).resolves.toMatchObject({ approvals: { primary: true, secondary: true } });
  });

  it("persists the locally derived outer hash before an uncertain send and reconciles without rebroadcast", async () => {
    const broadcast = vi.fn().mockRejectedValue(new Error("provider timeout includes https://secret.invalid/key"));
    const runtime = service({ broadcast }); runtime.prepare(prepared());
    await expect(runtime.submit("request-1", { role: "primary", assertion: { id: "p" } })).rejects.toThrow(/submission became uncertain/i);
    expect(runtime.journal.get("request-1")).toMatchObject({ state: "uncertain", outerTransactionHash: OUTER });
    await expect(runtime.status("request-1")).resolves.toMatchObject({ state: "confirmed", transactionHash: OUTER });
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("single-flights double-clicks and blocks stale state both before signing and broadcast", async () => {
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const revalidate = vi.fn().mockResolvedValueOnce(undefined).mockImplementationOnce(() => gate);
    const runtime = service({ revalidate }); runtime.prepare(prepared());
    const first = runtime.submit("request-1", { role: "primary", assertion: { id: "p" } });
    const duplicate = runtime.submit("request-1", { role: "primary", assertion: { id: "p" } }); release();
    await expect(first).resolves.toMatchObject({ state: "confirmed" }); await expect(duplicate).resolves.toMatchObject({ state: "confirmed" });
    expect(runtime.broadcast).toHaveBeenCalledTimes(1); expect(revalidate).toHaveBeenCalledTimes(2);
    const stale = service({ revalidate: vi.fn().mockRejectedValue(new Error("Safe nonce changed")) }); stale.prepare(prepared());
    await expect(stale.submit("request-1", { role: "primary", assertion: { id: "p" } })).rejects.toThrow(/nonce/i); expect(stale.broadcast).not.toHaveBeenCalled();

    const drift = service({ revalidate: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("policy changed before broadcast")) }); drift.prepare(prepared());
    await expect(drift.submit("request-1", { role: "primary", assertion: { id: "p" } })).rejects.toThrow(/policy/i); expect(drift.broadcast).not.toHaveBeenCalled();
  });

  it.each(["Safe nonce", "policy hash", "queue head", "canonical time", "runtime code"])("blocks stale %s before the passkey prompt", async (field) => {
    const verifyApproval = vi.fn(); const runtime = service({ revalidate: vi.fn().mockRejectedValue(new Error(`${field} changed`)), verifyApproval }); runtime.prepare(prepared());
    await expect(runtime.submit("request-1", { role: "primary", assertion: { id: "p" } })).rejects.toThrow(/changed/); expect(verifyApproval).not.toHaveBeenCalled(); expect(runtime.broadcast).not.toHaveBeenCalled();
  });

  it("allows role none only for permissionless ready/expired lifecycle intents", async () => {
    const runtime = service(); runtime.prepare(Object.freeze({ ...prepared([]), kind: "execute-ready", requiredApprovals: [] }));
    await expect(runtime.submit("request-1", { role: "none" })).resolves.toMatchObject({ state: "confirmed" });
    const signed = service(); signed.prepare(prepared()); await expect(signed.submit("request-1", { role: "none" })).rejects.toThrow(/permissionless/i);
  });
});
