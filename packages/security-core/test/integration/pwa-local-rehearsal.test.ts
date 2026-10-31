import { expect } from "chai";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";
import {
  LOCAL_PWA_ACTION_IDS,
  createLocalPwaApprovalForTestsOnly,
  createLocalPwaJournalStore,
  createLocalPwaReview,
  executeLocalPwaAction,
  writeLocalPwaReviewPackage,
  type LocalPwaActionAdapter,
} from "../../scripts/pwa/rehearse-local";
import { PWA_RECIPIENT, SEPOLIA_USDC_ADDRESS } from "../../src/pwa/profile";

const h = (value: number) => `0x${value.toString(16).padStart(64, "0")}` as Hex;
const a = (value: number) => `0x${value.toString(16).padStart(40, "0")}` as `0x${string}`;

function review() {
  return createLocalPwaReview({
    formatVersion: 1,
    profileId: "local",
    chainId: 11155111,
    safe: a(1), guard: a(2), delay: a(3), usdc: SEPOLIA_USDC_ADDRESS, recipient: PWA_RECIPIENT,
    primaryCredentialHash: h(4), secondaryCredentialHash: h(5), deploymentsHash: h(6), policyHash: h(7), topologyReportHash: h(8),
    observer: { processId: "pwa-local-observer", executableHash: h(9), sources: ["provider-a", "provider-b"], confirmations: 6 },
    deadline: "2026-11-01T12:00:00.000Z",
  });
}

describe("gated localhost PWA rehearsal", () => {
  it("emits one deterministic unsigned nine-step review with exact principal, caps, and terminal state", () => {
    const first = review();
    const second = review();
    expect(first).to.deep.equal(second);
    expect(first.authorization).to.equal("NONE");
    expect(first.actions.map((action) => action.id)).to.deep.equal(LOCAL_PWA_ACTION_IDS);
    expect(first.principal).to.equal("8000000");
    expect(first.expectedTerminal).to.deep.include({ safeUsdcBalance: "1000000", queueDepth: "0", baseSpent: "1000000", instantSpent: "3000000" });
    expect(first.actions.find((action) => action.id === "early-reject")!.broadcast).to.equal(false);
    expect(first.actions.filter((action) => action.broadcast).every((action) => BigInt(action.maxGas) > 0n)).to.equal(true);
  });

  it("writes a public review package without authority and refuses overwrite", () => {
    const root = mkdtempSync(join(tmpdir(), "pwa-local-review-"));
    const output = join(root, "review");
    try {
      const manifest = writeLocalPwaReviewPackage(review(), output);
      expect(manifest.reviewHash).to.equal(review().reviewHash);
      expect(JSON.parse(readFileSync(join(output, "review.json"), "utf8"))).to.deep.equal(review());
      expect(() => writeLocalPwaReviewPackage(review(), output)).to.throw(/exist|output/i);
      expect(readFileSync(join(output, "manifest.json"), "utf8")).not.to.match(/private|signature|assertion|rpc/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("persists one exact pending hash before one broadcast and requires observer evidence", async () => {
    process.env.NODE_ENV = "test";
    const root = mkdtempSync(join(tmpdir(), "pwa-local-submit-"));
    const journalPath = join(root, "journal.json");
    const plan = review();
    const approval = createLocalPwaApprovalForTestsOnly(plan, "provision", h(10));
    const observed: string[] = [];
    const adapter: LocalPwaActionAdapter = Object.freeze({
      async prepare(action) { return { transactionHash: h(11), attemptHash: h(12), actionId: action.id }; },
      async broadcast(prepared) {
        const persisted = JSON.parse(readFileSync(journalPath, "utf8"));
        observed.push(persisted.actions[0].status, prepared.transactionHash);
        return { status: "success", transactionHash: prepared.transactionHash, blockNumber: "100", blockHash: h(13), observerRecordHash: h(14) };
      },
      async proveRejection() { throw new Error("not a proof action"); },
    });
    const store = createLocalPwaJournalStore(journalPath, plan);
    try {
      const result = await executeLocalPwaAction({ mode: "submit-one", review: plan, approval, store, adapter, liveSubmit: "YES", now: new Date("2026-11-01T10:00:00.000Z") });
      expect(result).to.deep.include({ actionId: "provision", status: "confirmed" });
      expect(observed).to.deep.equal(["pending", h(11)]);
      expect(store.load().actions[0]).to.deep.include({ status: "confirmed", observerRecordHash: h(14) });
      await expect(executeLocalPwaAction({ mode: "submit-one", review: plan, approval, store, adapter, liveSubmit: "YES", now: new Date("2026-11-01T10:00:00.000Z") })).to.be.rejectedWith(/next action|approval/i);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); delete process.env.NODE_ENV; }
  });

  it("keeps resume keyless and cannot sign or rebroadcast a durable pending hash", async () => {
    process.env.NODE_ENV = "test";
    const root = mkdtempSync(join(tmpdir(), "pwa-local-resume-"));
    const plan = review();
    const store = createLocalPwaJournalStore(join(root, "journal.json"), plan);
    const approval = createLocalPwaApprovalForTestsOnly(plan, "provision", h(10));
    const pending: LocalPwaActionAdapter = Object.freeze({
      async prepare(action) { return { transactionHash: h(11), attemptHash: h(12), actionId: action.id }; },
      async broadcast() { throw new Error("uncertain broadcast"); },
      async proveRejection() { throw new Error("not used"); },
    });
    try {
      await expect(executeLocalPwaAction({ mode: "submit-one", review: plan, approval, store, adapter: pending, liveSubmit: "YES", now: new Date("2026-11-01T10:00:00.000Z") })).to.be.rejectedWith(/uncertain/i);
      expect(store.load().actions[0]).to.deep.include({ status: "pending", transactionHash: h(11) });
      const result = await executeLocalPwaAction({ mode: "resume-one", review: plan, store, adapter: Object.freeze({
        async reconcile(hash) { expect(hash).to.equal(h(11)); return { status: "success", transactionHash: hash, blockNumber: "101", blockHash: h(15), observerRecordHash: h(16) }; },
      }), now: new Date("2026-11-01T10:01:00.000Z") });
      expect(result).to.deep.include({ actionId: "provision", status: "confirmed" });
      await expect(executeLocalPwaAction({ mode: "resume-one", review: plan, store, adapter: Object.freeze({ reconcile: async () => null, broadcast: async () => undefined }) as never, now: new Date("2026-11-01T10:01:00.000Z") })).to.be.rejectedWith(/resume|capability/i);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); delete process.env.NODE_ENV; }
  });
});
