import { spawnSync } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const commands: readonly [string, readonly string[]][] = [
  [npm, ["run", "build"]],
  [npm, ["run", "test:unit"]],
  [npm, ["run", "test:integration"]],
  [npm, ["run", "test:invariant"]],
];

for (const [command, args] of commands) {
  const result = spawnSync(command, args, { stdio: "inherit", env: { ...process.env, HARDHAT_NETWORK: "hardhat" } });
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (result.error) throw result.error;
}
