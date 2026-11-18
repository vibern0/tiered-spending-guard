import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox-viem";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { task } from "hardhat/config";
import { TASK_CLEAN, TASK_COMPILE } from "hardhat/builtin-tasks/task-names";

const { generateResources, invalidateResources } = require("./scripts/sdk-resources.cjs");
const sdkRoot = join(__dirname, "../sdk");

// Compiler output is the sole build bridge to SDK public data; never publish coverage bytecode.
task(TASK_CLEAN).setAction(async (args, environment, runSuper) => {
  if (process.env.SOLIDITY_COVERAGE !== "true") invalidateResources(sdkRoot);
  return runSuper(args);
});
task(TASK_COMPILE).setAction(async (args, environment, runSuper) => {
  const coverage = process.env.SOLIDITY_COVERAGE === "true";
  if (!coverage) invalidateResources(sdkRoot);
  const result = await runSuper(args);
  if (!coverage) generateResources(__dirname, sdkRoot);
  return result;
});

// solidity-coverage cleans generated artifacts between test batches. Keep the
// pinned imported Safe artifacts available for viem's deployment helper.
const requireFromConfig = createRequire(__filename);
const safeSmartAccountRoot = dirname(requireFromConfig.resolve("@safe-global/safe-smart-account/package.json"));

for (const [name, source] of [
  ["Safe", "Safe.sol/Safe.json"],
  ["SafeProxy", "proxies/SafeProxy.sol/SafeProxy.json"],
] as const) {
  const target = join(__dirname, "artifacts/@safe-global/safe-smart-account/contracts", source);
  const dependency = join(safeSmartAccountRoot, "build/artifacts/contracts", source);
  if (!existsSync(target)) {
    if (!existsSync(dependency)) throw new Error(`missing pinned ${name} artifact: ${dependency}`);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(dependency, target);
  }
}

const config: HardhatUserConfig = {
  paths: {
    sources: "./contracts",
    tests: "./test",
  },
  solidity: {
    version: "0.8.24",
    settings: {
      evmVersion: "cancun",
      viaIR: true,
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
};

export default config;
