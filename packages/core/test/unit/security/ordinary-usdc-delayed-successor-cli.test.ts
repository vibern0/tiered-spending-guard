import { expect } from "chai";
import {
  createUsdcDelayedSuccessorObserverBinding,
  parseUsdcDelayedSuccessorCommand,
  parseUsdcDelayedSuccessorPendingReconciliation,
} from "../../../scripts/live/ordinary-scenario-usdc-delayed-successor-cli";

describe("ordinary USDC delayed-tier successor CLI", function () {
  it("admits only review, submit-one, and resume-one", function () {
    expect(parseUsdcDelayedSuccessorCommand(["review"])).to.equal("review");
    expect(parseUsdcDelayedSuccessorCommand(["submit-one"])).to.equal("submit-one");
    expect(parseUsdcDelayedSuccessorCommand(["resume-one"])).to.equal("resume-one");
    expect(() => parseUsdcDelayedSuccessorCommand(["submit-all"])).to.throw(/command|usage/i);
  });

  it("binds keyless reconciliation to one exact successor envelope", function () {
    const intentHash = `0x${"1".repeat(64)}`, transactionHash = `0x${"2".repeat(64)}`;
    const value = { usdcDelayedSuccessor: { actions: [{ id: "usdc-delayed-successor-skip-expired", status: "outer-pending", outerNonce: 917, intentHash, transactionHash }] }, liveJournal: { entries: [{ id: "usdc-delayed-successor-skip-expired", status: "pending", nonce: 917, intentHash, transactionHash }] } };
    expect(parseUsdcDelayedSuccessorPendingReconciliation(JSON.stringify(value))).to.deep.equal({ outerNonce: 917 });
    value.liveJournal.entries[0]!.transactionHash = intentHash;
    expect(() => parseUsdcDelayedSuccessorPendingReconciliation(JSON.stringify(value))).to.throw(/exactly bound/i);
  });

  it("requires a fresh 1800-second observer window", function () {
    const endpointHash = `0x${"1".repeat(64)}`;
    const startup = `${JSON.stringify({ schemaVersion: 1, scope: "USDC_DELAYED_SUCCESSOR_OBSERVER_STARTUP_V1", signing: false, broadcast: false, publicId: `temporary-test-receiver:${endpointHash}`, endpointHash, startedAt: "2026-10-31T09:00:00.000Z", expiresAt: "2026-10-31T11:00:00.000Z" })}\n`;
    const startupEvidenceHash = `0x${require("node:crypto").createHash("sha256").update(startup).digest("hex")}`;
    const probe = `${JSON.stringify({ schemaVersion: 1, scope: "USDC_DELAYED_SUCCESSOR_OBSERVER_PROBE_V1", signing: false, broadcast: false, delivery: "DELIVERED", acknowledgement: "ACKNOWLEDGED", publicId: `temporary-test-receiver:${endpointHash}`, endpointHash, startupEvidenceHash, probedAt: "2026-10-31T09:01:00.000Z", expiresAt: "2026-10-31T11:00:00.000Z" })}\n`;
    expect(createUsdcDelayedSuccessorObserverBinding(startup, probe, new Date("2026-10-31T09:02:00.000Z"))).to.include({ endpointHash, requiredThrough: "1793439060" });
    expect(() => createUsdcDelayedSuccessorObserverBinding(startup, probe, new Date("2026-10-31T10:40:01.000Z"))).to.throw(/TTL|coverage/i);
  });
});
