import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { SubmissionJournal } from "../src/journal";
import { PwaSubmissionService, type BackendPreparedSubmission } from "../src/vault";

const HASH = `0x${"aa".repeat(32)}` as Hex;
const OUTER = `0x${"bb".repeat(32)}` as Hex;
const BLOCK = `0x${"cc".repeat(32)}` as Hex;

function prepared(
  requiredApprovals: readonly ("primary" | "secondary")[] = ["primary"],
): BackendPreparedSubmission {
  return Object.freeze({
    id: "request-1",
    requestHash: HASH,
    safeTxHash: HASH,
    kind: requiredApprovals.length === 1 ? "base-transfer" : "step-up-transfer",
    requiredApprovals,
    publicRequest: Object.freeze({
      kind: "transfer",
      recipient: "0x1111111111111111111111111111111111111111",
      amount: "1000000",
      idempotencyKey: "request-1",
    }),
  });
}

function service(overrides: Partial<ConstructorParameters<typeof PwaSubmissionService>[0]> = {}) {
  return new PwaSubmissionService({
    journal: new SubmissionJournal(),
    verifyApproval: vi.fn(async (role) => ({
      role,
      payload: (role === "primary" ? "0x11" : "0x22") as Hex,
    })),
    revalidate: vi.fn().mockResolvedValue(undefined),
    deriveOuterHash: vi.fn().mockResolvedValue(OUTER),
    broadcast: vi.fn().mockResolvedValue(OUTER),
    reconcile: vi.fn().mockResolvedValue({
      status: "confirmed",
      transactionHash: OUTER,
      blockNumber: 12n,
      blockHash: BLOCK,
    }),
    ...overrides,
  });
}

describe("durable PWA submissions", () => {
  it("returns the same terminal receipt to concurrent status polls without rebroadcast", async () => {
    const journal = new SubmissionJournal();
    journal.prepare("request-1", HASH);
    journal.markSubmitting("request-1", OUTER);
    const reconcile = vi.fn(async () => ({
      status: "confirmed" as const,
      transactionHash: OUTER,
      blockNumber: 12n,
      blockHash: BLOCK,
    }));
    const runtime = service({ journal, reconcile });
    const results = await Promise.all([runtime.status("request-1"), runtime.status("request-1")]);
    expect(results).toEqual([
      expect.objectContaining({
        state: "confirmed",
        receipt: { transactionHash: OUTER, blockNumber: 12n, blockHash: BLOCK },
      }),
      expect.objectContaining({
        state: "confirmed",
        receipt: { transactionHash: OUTER, blockNumber: 12n, blockHash: BLOCK },
      }),
    ]);
    expect(runtime.broadcast).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("returns one confirmed view when immediate submission and a status poll reconcile together", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const reconcile = vi.fn(async () => {
      entered();
      await gate;
      return {
        status: "confirmed" as const,
        transactionHash: OUTER,
        blockNumber: 12n,
        blockHash: BLOCK,
      };
    });
    const runtime = service({ reconcile });
    runtime.prepare(prepared());
    const submission = runtime.submit("request-1", { role: "primary", assertion: {} });
    await started;
    const polled = runtime.status("request-1");
    release();
    const results = await Promise.all([submission, polled]);
    expect(results.map((result) => result.state)).toEqual(["confirmed", "confirmed"]);
    expect(runtime.journal.get("request-1")?.state).toBe("confirmed");
    expect(runtime.broadcast).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("retries a failed shared status flight without changing its durable pending evidence", async () => {
    const journal = new SubmissionJournal();
    journal.prepare("request-1", HASH);
    journal.markSubmitting("request-1", OUTER);
    journal.markUncertain("request-1");
    const reconcile = vi
      .fn()
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValue({
        status: "reverted",
        transactionHash: OUTER,
        blockNumber: 12n,
        blockHash: BLOCK,
      });
    const runtime = service({ journal, reconcile });
    const failed = await Promise.allSettled([
      runtime.status("request-1"),
      runtime.status("request-1"),
    ]);
    expect(failed.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(journal.get("request-1")).toMatchObject({
      state: "uncertain",
      outerTransactionHash: OUTER,
    });
    await expect(runtime.status("request-1")).resolves.toMatchObject({ state: "reverted" });
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(runtime.broadcast).not.toHaveBeenCalled();
  });

  it.each([
    { first: "confirmed" as const, second: "reverted" as const, block: BLOCK },
    { first: "reverted" as const, second: "confirmed" as const, block: BLOCK },
    { first: "confirmed" as const, second: "confirmed" as const, block: HASH },
  ])(
    "never replaces a terminal $first receipt with conflicting $second evidence",
    async ({ first, second, block }) => {
      const journal = new SubmissionJournal();
      journal.prepare("request-1", HASH);
      journal.markSubmitting("request-1", OUTER);
      let calls = 0;
      const options = {
        journal,
        reconcile: async () => ({
          status: calls++ === 0 ? first : second,
          transactionHash: OUTER,
          blockNumber: 12n,
          blockHash: calls === 1 ? BLOCK : block,
        }),
      };
      // Distinct services model independent processes sharing the durable journal.
      const results = await Promise.allSettled([
        service(options).status("request-1"),
        service(options).status("request-1"),
      ]);
      expect(results[0]).toMatchObject({ status: "fulfilled", value: { state: first } });
      expect(results[1]).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({
          message: expect.stringMatching(/receipt.*conflict|conflict.*receipt/i),
        }),
      });
      expect(journal.get("request-1")).toMatchObject({
        state: first,
        receipt: { blockNumber: 12n, blockHash: BLOCK },
      });
    },
  );

  it("requires exact ordered primary and secondary approvals for recipient additions", async () => {
    for (const requiredApprovals of [[], ["primary"], ["secondary", "primary"]] as const) {
      const runtime = service();
      expect(() =>
        runtime.prepare({ ...prepared(), kind: "add-recipient", requiredApprovals }),
      ).toThrow(/approval roles/i);
    }
    expect(() =>
      service().prepare({
        ...prepared(["primary", "secondary"]),
        kind: "add-recipient",
        safeTxHash: undefined,
      }),
    ).toThrow(/exact Safe transaction hash/i);
    const runtime = service();
    runtime.prepare({
      ...prepared(["primary", "secondary"]),
      kind: "add-recipient",
      publicRequest: {
        kind: "add-recipient",
        recipient: "0x1111111111111111111111111111111111111111",
        idempotencyKey: "request-1",
      },
    });
    await expect(runtime.submit("request-1", { role: "none" })).rejects.toThrow(/permissionless/i);
    await expect(runtime.submit("request-1", { role: "secondary", assertion: {} })).rejects.toThrow(
      /primary/i,
    );
    await expect(
      runtime.submit("request-1", { role: "primary", assertion: {} }),
    ).resolves.toMatchObject({ state: "awaiting-secondary", kind: "add-recipient" });
    await expect(
      runtime.submit("request-1", { role: "secondary", assertion: {} }),
    ).resolves.toMatchObject({ state: "confirmed", kind: "add-recipient" });
    expect(runtime.broadcast).toHaveBeenCalledTimes(1);
  });
  it("requires primary before secondary and stores approval presence only", async () => {
    const runtime = service();
    runtime.prepare(prepared(["primary", "secondary"]));
    await expect(
      runtime.submit("request-1", {
        role: "secondary",
        assertion: { id: "s" },
      }),
    ).rejects.toThrow(/primary/i);
    await expect(
      runtime.submit("request-1", { role: "primary", assertion: { id: "p" } }),
    ).resolves.toMatchObject({ state: "awaiting-secondary" });
    await expect(
      runtime.submit("request-1", {
        role: "secondary",
        assertion: { id: "s" },
      }),
    ).resolves.toMatchObject({ state: "confirmed", transactionHash: OUTER });
    expect(runtime.broadcast).toHaveBeenCalledTimes(1);
    await expect(runtime.status("request-1")).resolves.toMatchObject({
      approvals: { primary: true, secondary: true },
    });
  });

  it("persists the locally derived outer hash before an uncertain send and reconciles without rebroadcast", async () => {
    const broadcast = vi
      .fn()
      .mockRejectedValue(new Error("provider timeout includes https://secret.invalid/key"));
    const runtime = service({ broadcast });
    runtime.prepare(prepared());
    await expect(
      runtime.submit("request-1", { role: "primary", assertion: { id: "p" } }),
    ).rejects.toThrow(/submission became uncertain/i);
    expect(runtime.journal.get("request-1")).toMatchObject({
      state: "uncertain",
      outerTransactionHash: OUTER,
    });
    await expect(runtime.status("request-1")).resolves.toMatchObject({
      state: "confirmed",
      transactionHash: OUTER,
    });
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("single-flights double-clicks and blocks stale state both before signing and broadcast", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const revalidate = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => gate);
    const runtime = service({ revalidate });
    runtime.prepare(prepared());
    const first = runtime.submit("request-1", {
      role: "primary",
      assertion: { id: "p" },
    });
    const duplicate = runtime.submit("request-1", {
      role: "primary",
      assertion: { id: "p" },
    });
    release();
    await expect(first).resolves.toMatchObject({ state: "confirmed" });
    await expect(duplicate).resolves.toMatchObject({ state: "confirmed" });
    expect(runtime.broadcast).toHaveBeenCalledTimes(1);
    expect(revalidate).toHaveBeenCalledTimes(2);
    const stale = service({
      revalidate: vi.fn().mockRejectedValue(new Error("Safe nonce changed")),
    });
    stale.prepare(prepared());
    await expect(
      stale.submit("request-1", { role: "primary", assertion: { id: "p" } }),
    ).rejects.toThrow(/nonce/i);
    expect(stale.broadcast).not.toHaveBeenCalled();
    expect(stale.journal.get("request-1")?.state).toBe("superseded");

    const drift = service({
      revalidate: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("policy changed before broadcast")),
    });
    drift.prepare(prepared());
    await expect(
      drift.submit("request-1", { role: "primary", assertion: { id: "p" } }),
    ).rejects.toThrow(/policy/i);
    expect(drift.broadcast).not.toHaveBeenCalled();
    await expect(
      drift.submit("request-1", {
        role: "primary",
        assertion: { id: "retry" },
      }),
    ).resolves.toMatchObject({ state: "superseded" });
    expect(drift.journal.get("request-1")).toMatchObject({
      state: "superseded",
      approvals: { primary: true },
    });
    expect(drift.broadcast).not.toHaveBeenCalled();
  });

  it("supersedes a request whose outer hash can no longer be derived", async () => {
    const runtime = service({
      deriveOuterHash: vi.fn().mockRejectedValue(new Error("relay nonce changed")),
    });
    runtime.prepare(prepared());
    await expect(
      runtime.submit("request-1", { role: "primary", assertion: { id: "p" } }),
    ).rejects.toThrow(/relay nonce/i);
    await expect(runtime.status("request-1")).resolves.toMatchObject({
      state: "superseded",
    });
    expect(runtime.broadcast).not.toHaveBeenCalled();
  });

  it("discards a signed envelope and releases its runtime lease when durable hash persistence fails", async () => {
    const journal = new SubmissionJournal();
    const discard = vi.fn(async () => undefined);
    const runtime = service({ journal, discard });
    runtime.prepare(prepared());
    vi.spyOn(journal, "markSubmitting").mockImplementation(() => {
      throw new Error("durable write failed");
    });
    await expect(runtime.submit("request-1", { role: "primary", assertion: {} })).rejects.toThrow(
      /durable write failed/,
    );
    expect(discard).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "request-1" }));
    expect(runtime.broadcast).not.toHaveBeenCalled();
    expect(journal.get("request-1")?.state).toBe("superseded");
    await expect(
      runtime.submit("request-1", { role: "primary", assertion: {} }),
    ).resolves.toMatchObject({ state: "superseded" });
  });

  it("discards runtime signing state if outer hash derivation returns an invalid hash", async () => {
    const discard = vi.fn(async () => undefined);
    const runtime = service({ deriveOuterHash: vi.fn().mockResolvedValue("0x1234"), discard });
    runtime.prepare(prepared());
    await expect(runtime.submit("request-1", { role: "primary", assertion: {} })).rejects.toThrow(
      /derived outer transaction hash/,
    );
    expect(discard).toHaveBeenCalledTimes(1);
    expect(runtime.broadcast).not.toHaveBeenCalled();
    expect(runtime.journal.get("request-1")?.state).toBe("superseded");
  });

  it.each(["Safe nonce", "policy hash", "queue head", "canonical time", "runtime code"])(
    "blocks stale %s before the passkey prompt",
    async (field) => {
      const verifyApproval = vi.fn();
      const runtime = service({
        revalidate: vi.fn().mockRejectedValue(new Error(`${field} changed`)),
        verifyApproval,
      });
      runtime.prepare(prepared());
      await expect(
        runtime.submit("request-1", { role: "primary", assertion: { id: "p" } }),
      ).rejects.toThrow(/changed/);
      expect(verifyApproval).not.toHaveBeenCalled();
      expect(runtime.broadcast).not.toHaveBeenCalled();
    },
  );

  it("allows role none only for permissionless ready/expired lifecycle intents", async () => {
    const runtime = service();
    runtime.prepare(
      Object.freeze({
        ...prepared([]),
        kind: "execute-ready",
        requiredApprovals: [],
      }),
    );
    await expect(runtime.submit("request-1", { role: "none" })).resolves.toMatchObject({
      state: "confirmed",
    });
    const signed = service();
    signed.prepare(prepared());
    await expect(signed.submit("request-1", { role: "none" })).rejects.toThrow(/permissionless/i);
  });
});
