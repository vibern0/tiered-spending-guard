import { expect } from "chai";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const { createCoverageArtifactHooks } = require("../../../scripts/coverage-reviewed-artifacts.cjs") as {
  createCoverageArtifactHooks(processReference?: any): {
    onPreCompile(config: { artifactsDir: string }): void;
    onTestsComplete(): void;
    onIstanbulComplete(): void;
  };
};

const artifacts = [
  ["TieredSpendingGuard.json", "contracts/TieredSpendingGuard.sol/TieredSpendingGuard.json"],
  ["SafeAtomicSetupHelper.json", "contracts/SafeAtomicSetupHelper.sol/SafeAtomicSetupHelper.json"],
  ["GuardReplacementMaintenance.json", "contracts/GuardReplacementMaintenance.sol/GuardReplacementMaintenance.json"],
] as const;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "coverage-reviewed-artifact-test-"));
  const artifactDirectory = join(directory, "artifacts");
  for (const [name, relative] of artifacts) {
    const path = join(artifactDirectory, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ contractName: name, bytecode: "0x6000" })}\n`);
  }
  let exitHandler: (() => void) | undefined;
  const processReference = { env: {} as Record<string, string>, once: (event: string, handler: () => void) => { expect(event).to.equal("exit"); exitHandler = handler; }, stderr: { write: () => undefined }, exitCode: undefined as number | undefined };
  const hooks = createCoverageArtifactHooks(processReference);
  const originals = new Map(artifacts.map(([, relative]) => [relative, readFileSync(join(artifactDirectory, relative), "utf8")]));
  const mutate = () => artifacts.forEach(([, relative]) => writeFileSync(join(artifactDirectory, relative), "instrumented\n"));
  const assertRestored = () => {
    for (const [, relative] of artifacts) expect(readFileSync(join(artifactDirectory, relative), "utf8")).to.equal(originals.get(relative));
    expect(processReference.env).not.to.have.property("SECURITY_CORE_REVIEWED_ARTIFACT_SNAPSHOT");
  };
  return { directory, artifactDirectory, hooks, processReference, exit: () => exitHandler!(), mutate, assertRestored };
}

describe("coverage reviewed artifact lifecycle", function () {
  it("restores normal artifacts immediately after tests and keeps later cleanup idempotent", function () {
    const value = fixture();
    try {
      value.hooks.onPreCompile({ artifactsDir: value.artifactDirectory });
      const snapshot = value.processReference.env.SECURITY_CORE_REVIEWED_ARTIFACT_SNAPSHOT;
      expect(snapshot).to.be.a("string"); expect(existsSync(snapshot)).to.equal(true);
      value.mutate(); value.hooks.onTestsComplete(); value.assertRestored();
      expect(existsSync(snapshot)).to.equal(false);
      value.hooks.onIstanbulComplete(); value.exit(); value.assertRestored();
    } finally { rmSync(value.directory, { recursive: true, force: true }); }
  });

  it("restores normal artifacts through the synchronous exit failure path", function () {
    const value = fixture();
    try {
      value.hooks.onPreCompile({ artifactsDir: value.artifactDirectory });
      const snapshot = value.processReference.env.SECURITY_CORE_REVIEWED_ARTIFACT_SNAPSHOT;
      value.mutate(); value.exit(); value.assertRestored();
      expect(existsSync(snapshot)).to.equal(false); expect(value.processReference.exitCode).to.equal(undefined);
    } finally { rmSync(value.directory, { recursive: true, force: true }); }
  });

  it("retains the only snapshot after a restore failure and permits an exact retry", function () {
    const value = fixture();
    try {
      value.hooks.onPreCompile({ artifactsDir: value.artifactDirectory });
      const snapshot = value.processReference.env.SECURITY_CORE_REVIEWED_ARTIFACT_SNAPSHOT;
      value.mutate();
      const blocked = join(value.artifactDirectory, artifacts[0][1]);
      rmSync(blocked); mkdirSync(blocked);
      expect(() => value.hooks.onTestsComplete()).to.throw();
      expect(existsSync(snapshot)).to.equal(true);
      expect(value.processReference.env.SECURITY_CORE_REVIEWED_ARTIFACT_SNAPSHOT).to.equal(snapshot);
      rmSync(blocked, { recursive: true, force: true });
      value.hooks.onIstanbulComplete(); value.assertRestored();
      expect(existsSync(snapshot)).to.equal(false);
    } finally { rmSync(value.directory, { recursive: true, force: true }); }
  });
});
