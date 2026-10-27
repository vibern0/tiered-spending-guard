import { expect } from "chai";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256 } from "viem";
import { assertOrdinaryScenarioReviewCliEnvironment, writeOrdinaryScenarioReviewPackage } from "../../../scripts/live/ordinary-scenario-review-cli";

describe("ordinary scenario review read-only CLI package", () => {
  it("rejects RPC credentials and arbitrary observer paths before adapter work", () => {
    for (const key of ["SEPOLIA_RPC_URL", "SEPOLIA_ARCHIVE_RPC_URL", "ORDINARY_SCENARIO_OBSERVER", "PRIVATE_KEY", "VAULT_FUNDING_KEY_PATH", "LIVE_SUBMIT"]) {
      expect(() => assertOrdinaryScenarioReviewCliEnvironment({ [key]: "forbidden" })).to.throw("rejects override or authority input");
    }
    expect(() => assertOrdinaryScenarioReviewCliEnvironment({ ORDINARY_SCENARIO_OUTPUT: "/tmp/public-output" })).to.not.throw();
  });
  it("writes only the deterministic public report and manifest and refuses overwrite", () => {
    const directory = mkdtempSync(join(tmpdir(), "ordinary-scenario-review-"));
    rmSync(directory, { recursive: true });
    const report = { report: { status: "BLOCKED", signed: false, broadcast: false, liveEstimated: false }, rendered: "{\"status\":\"BLOCKED\"}\n", packageHash: keccak256("0x1234") } as never;
    const written = writeOrdinaryScenarioReviewPackage(report, directory);
    expect(written.files).to.deep.equal(["ordinary-scenario-review.json", "public-manifest.json"]);
    expect(JSON.parse(readFileSync(join(directory, "ordinary-scenario-review.json"), "utf8"))).to.deep.equal({ status: "BLOCKED" });
    const manifest = JSON.parse(readFileSync(join(directory, "public-manifest.json"), "utf8"));
    expect(manifest).to.deep.include({ status: "BLOCKED", signed: false, broadcast: false, liveEstimated: false, packageHash: report.packageHash });
    expect(() => writeOrdinaryScenarioReviewPackage(report, directory)).to.throw("must not already exist");
    rmSync(directory, { recursive: true });
  });
});
