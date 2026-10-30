import { expect } from "chai";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseUsdcDelayedCompletionCommand, parseUsdcDelayedCompletionPendingReconciliation } from "../../../scripts/live/ordinary-scenario-usdc-delayed-completion-cli";

describe("ordinary USDC delayed-completion CLI", function () {
  it("admits only review, submit-one, and resume-one", function () {
    expect(parseUsdcDelayedCompletionCommand(["review"])).to.equal("review");
    expect(parseUsdcDelayedCompletionCommand(["submit-one"])).to.equal("submit-one");
    expect(parseUsdcDelayedCompletionCommand(["resume-one"])).to.equal("resume-one");
    expect(() => parseUsdcDelayedCompletionCommand(["submit-all"])).to.throw(/command|usage/i);
  });

  it("keeps the atomic writer lease until delayed execution settles", function () {
    const source = readFileSync(join(__dirname, "../../../scripts/live/ordinary-scenario-usdc-delayed-completion-cli.ts"), "utf8");
    expect(source).to.match(/return await executeUsdcDelayedCompletionAction\(/);
  });

  it("binds descendant keyless reconciliation to one exact pending delayed envelope", function () {
    const hash = `0x${"1".repeat(64)}`, transactionHash = `0x${"2".repeat(64)}`;
    const value = { usdcDelayedCompletion: { actions: [{ id: "usdc-delayed-completion-prefund-all", status: "outer-pending", outerNonce: 906, intentHash: hash, transactionHash }] }, liveJournal: { entries: [{ id: "usdc-delayed-completion-prefund-all", status: "pending", nonce: 906, intentHash: hash, transactionHash }] } };
    expect(parseUsdcDelayedCompletionPendingReconciliation(JSON.stringify(value))).to.deep.equal({ outerNonce: 906 });
    value.liveJournal.entries[0]!.transactionHash = hash;
    expect(() => parseUsdcDelayedCompletionPendingReconciliation(JSON.stringify(value))).to.throw(/exactly bound/i);
  });
});
