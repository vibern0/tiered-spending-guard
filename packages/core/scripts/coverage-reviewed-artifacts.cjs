const { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");

const REVIEWED_ARTIFACTS = Object.freeze([
  ["TieredSpendingGuard.json", "contracts/TieredSpendingGuard.sol/TieredSpendingGuard.json"],
  ["SafeAtomicSetupHelper.json", "contracts/SafeAtomicSetupHelper.sol/SafeAtomicSetupHelper.json"],
  ["GuardReplacementMaintenance.json", "contracts/GuardReplacementMaintenance.sol/GuardReplacementMaintenance.json"],
]);

function copyReviewedArtifacts(fromDirectory, toDirectory, flatten) {
  for (const [name, relativePath] of REVIEWED_ARTIFACTS) {
    const source = join(fromDirectory, flatten ? name : relativePath);
    JSON.parse(readFileSync(source, "utf8"));
    const destination = join(toDirectory, flatten ? relativePath : name);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
}

function createCoverageArtifactHooks(processReference = process) {
  let snapshotDirectory;
  let artifactsDirectory;

  const restore = () => {
    if (!snapshotDirectory || !artifactsDirectory) return;
    const snapshot = snapshotDirectory;
    copyReviewedArtifacts(snapshot, artifactsDirectory, true);
    delete processReference.env.SECURITY_CORE_REVIEWED_ARTIFACT_SNAPSHOT;
    rmSync(snapshot, { recursive: true, force: true });
    snapshotDirectory = undefined;
    artifactsDirectory = undefined;
  };

  processReference.once("exit", () => {
    try { restore(); }
    catch (error) {
      processReference.exitCode = 1;
      processReference.stderr?.write(`failed to restore reviewed coverage artifacts: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  });

  return {
    onPreCompile(config) {
      if (snapshotDirectory) throw new Error("reviewed coverage artifact snapshot is already active");
      artifactsDirectory = config.artifactsDir;
      snapshotDirectory = mkdtempSync(join(tmpdir(), "security-core-reviewed-artifacts-"));
      try {
        copyReviewedArtifacts(artifactsDirectory, snapshotDirectory, false);
        processReference.env.SECURITY_CORE_REVIEWED_ARTIFACT_SNAPSHOT = snapshotDirectory;
      } catch (error) {
        delete processReference.env.SECURITY_CORE_REVIEWED_ARTIFACT_SNAPSHOT;
        rmSync(snapshotDirectory, { recursive: true, force: true });
        snapshotDirectory = undefined;
        artifactsDirectory = undefined;
        throw error;
      }
    },
    onTestsComplete() { restore(); },
    onIstanbulComplete() { restore(); },
  };
}

module.exports = { createCoverageArtifactHooks };
