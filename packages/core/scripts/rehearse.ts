import { execFileSync } from "node:child_process";
import { validateRehearsalInputs } from "./security/rehearsal-inputs";

const rehearsalForbidden = /(?:SIGNATURE|PASSKEY|PIN|RECOVERY)/i;

export function validateRehearsalLaunchInputs(env: NodeJS.ProcessEnv, args: readonly string[]): void {
  validateRehearsalInputs(env, args);
  const forbiddenInputs = Object.keys(env).filter((name) => rehearsalForbidden.test(name));
  if (forbiddenInputs.length) throw new Error(`fail closed: rehearsal refuses credential/provider/broadcast environment variables: ${forbiddenInputs.join(", ")}`);
}

function main(): void {
  validateRehearsalLaunchInputs(process.env, process.argv.slice(2));
  const safeEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    NODE_PATH: process.env.NODE_PATH,
    FORCE_COLOR: process.env.FORCE_COLOR,
    REHEARSAL_LOCAL: "1",
  };
  execFileSync("npx", ["hardhat", "test", "test/integration/rehearsal.test.ts"], { stdio: "inherit", env: safeEnv });
  console.log(JSON.stringify({ network: "hardhat-local", chainId: 31337, signed: false, broadcast: false, timeControlled: true, evidence: "testnet prototype only" }));
}

if (require.main === module) main();
