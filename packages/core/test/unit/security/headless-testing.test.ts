import { expect } from "chai";
import { readFileSync } from "node:fs";

describe("headless security testing scripts", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };

  it("cleans stale artifacts before compiling", () => {
    expect(pkg.scripts.build).to.equal("hardhat clean && hardhat compile");
  });

  it("exposes one no-UI test gate for the security core", () => {
    expect(pkg.scripts["test:headless"]).to.equal("tsx scripts/headless-test.ts");
  });
});
