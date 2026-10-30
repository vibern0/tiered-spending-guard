import { expect } from "chai";
import { parseUsdcDelayedCompletionCommand } from "../../../scripts/live/ordinary-scenario-usdc-delayed-completion-cli";

describe("ordinary USDC delayed-completion CLI", function () {
  it("admits only review, submit-one, and resume-one", function () {
    expect(parseUsdcDelayedCompletionCommand(["review"])).to.equal("review");
    expect(parseUsdcDelayedCompletionCommand(["submit-one"])).to.equal("submit-one");
    expect(parseUsdcDelayedCompletionCommand(["resume-one"])).to.equal("resume-one");
    expect(() => parseUsdcDelayedCompletionCommand(["submit-all"])).to.throw(/command|usage/i);
  });
});
