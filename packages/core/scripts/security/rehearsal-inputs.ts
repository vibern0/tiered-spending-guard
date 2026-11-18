const forbidden = /(?:CHAIN_ID|RPC(?:_URL)?|PRIVATE|SECRET|MNEMONIC|SEED|WALLET|PROVIDER|BROADCAST|DEPLOY|SIGNING|RELAYER|FORK)/i;
const selectors = ["HARDHAT_NETWORK", "NETWORK", "NETWORK_NAME", "REHEARSAL_NETWORK"];

export function validateRehearsalInputs(env: NodeJS.ProcessEnv, args: readonly string[]): void {
  const invalidSelectors = selectors.filter((name) => env[name] !== undefined && env[name] !== "hardhat");
  const forbiddenInputs = Object.keys(env).filter((name) => forbidden.test(name));
  const networkArgs: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--network") networkArgs.push(args[i + 1] ?? "");
    else if (args[i].startsWith("--network=")) networkArgs.push(args[i].slice("--network=".length));
  }
  if (invalidSelectors.length || networkArgs.some((network) => network !== "hardhat")) throw new Error("fail closed: rehearsal only supports the hardhat network");
  if (forbiddenInputs.length) throw new Error(`fail closed: rehearsal refuses credential/provider/broadcast environment variables: ${forbiddenInputs.join(", ")}`);
}
