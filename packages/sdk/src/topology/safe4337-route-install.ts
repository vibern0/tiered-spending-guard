import { encodeFunctionData, isAddress, keccak256, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import { encodeCallOnlyBatch, type UnsignedSetupCall } from "./multisend";
import type { TopologyReadClient, TopologyReport } from "./verify";

export const SAFE_ROUTE_INSTALL_ABI = parseAbi([
  "function disableModule(address prevModule,address module)",
  "function enableModule(address module)",
  "function setFallbackHandler(address handler)",
  "function setModuleGuard(address guard)",
  "function setGuard(address guard)",
  "function multiSend(bytes transactions)",
]);

const SENTINEL_MODULES = "0x0000000000000000000000000000000000000001" as Address;

export type Safe4337RouteInstallInput = Readonly<{
  safe: Address;
  standardModule: Address;
  router: Address;
  delay: Address;
  guard: Address;
  multiSendCallOnly: Address;
}>;

export type UnsignedSafeRouteInstall = Readonly<{ to: Address; value: 0n; data: Hex; operation: 1 }>;

export type Safe4337RouteTopologyInput = Readonly<{
  safe: Address;
  standardModule: Address;
  router: Address;
  delay: Address;
  guard: Address;
  multiSendCallOnly: Address;
  primary: Address;
  entryPoint: Address;
  hashes: Readonly<{ safe: Hex; standardModule: Hex; router: Hex; delay: Hex; guard: Hex }>;
  client: TopologyReadClient;
}>;

const ROUTE_ABI = parseAbi([
  "function VERSION() view returns (string)", "function getOwners() view returns (address[])", "function getThreshold() view returns (uint256)",
  "function getModulesPaginated(address,uint256) view returns (address[],address)",
  "function SAFE() view returns (address)", "function STANDARD_MODULE() view returns (address)", "function ENTRY_POINT() view returns (address)",
  "function SUPPORTED_ENTRYPOINT() view returns (address)",
  "function config() view returns (address,address,address,address,uint64,uint64)", "function aaRouter() view returns (address)", "function expectedRouterRuntimeHash() view returns (bytes32)",
  "function owner() view returns (address)", "function avatar() view returns (address)", "function target() view returns (address)", "function isModuleEnabled(address) view returns (bool)",
]);
const FALLBACK_SLOT = "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5" as Hex;
const GUARD_SLOT = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8" as Hex;
const MODULE_GUARD_SLOT = "0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947" as Hex;
const MULTISEND_CALL_ONLY_RUNTIME_HASH = "0xcdbdcec38d2f1c7d961b0029ff8416b7e86e9974d6f0e9c9580c7d17fcfb6663" as Hex;
const same = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/** Read-only topology gate for a reviewed existing Safe; caller must supply independent runtime anchors. */
export async function verifySafe4337RouteTopology(input: Safe4337RouteTopologyInput, phase: "before" | "after"): Promise<TopologyReport> {
  const failures: string[] = [];
  const checked: string[] = [];
  const check = (name: string, valid: boolean) => { checked.push(name); if (!valid) failures.push(name); };
  const read = async (label: string, address: Address, functionName: string, args: readonly unknown[] = []): Promise<unknown> => {
    try { return await input.client.readContract({ address, abi: ROUTE_ABI, functionName, args }); }
    catch { failures.push(`${label} read`); return undefined; }
  };
  const code = async (name: keyof Safe4337RouteTopologyInput["hashes"], address: Address) => {
    try { const actual = await input.client.getBytecode({ address }); check(`${name} runtime`, !!actual && actual !== "0x" && same(keccak256(actual), input.hashes[name])); }
    catch { check(`${name} runtime`, false); }
  };
  for (const name of ["safe", "standardModule", "router", "delay", "guard"] as const) await code(name, input[name]);
  try { const actual = await input.client.getBytecode({ address: input.multiSendCallOnly }); check("MultiSendCallOnly runtime", !!actual && actual !== "0x" && same(keccak256(actual), MULTISEND_CALL_ONLY_RUNTIME_HASH)); }
  catch { check("MultiSendCallOnly runtime", false); }
  check("Safe 1.5", (await read("Safe version", input.safe, "VERSION")) === "1.5.0");
  const owners = await read("Safe owners", input.safe, "getOwners");
  check("sole passkey owner", Array.isArray(owners) && owners.length === 1 && same(owners[0], input.primary));
  check("Safe threshold", (await read("Safe threshold", input.safe, "getThreshold")) === 1n);
  check("router Safe", same(await read("router Safe", input.router, "SAFE"), input.safe));
  check("router module", same(await read("router module", input.router, "STANDARD_MODULE"), input.standardModule));
  check("router EntryPoint", same(await read("router EntryPoint", input.router, "ENTRY_POINT"), input.entryPoint));
  check("module EntryPoint", same(await read("module EntryPoint", input.standardModule, "SUPPORTED_ENTRYPOINT"), input.entryPoint));
  const config = await read("guard config", input.guard, "config");
  check("guard bindings", Array.isArray(config) && same(config[0], input.safe) && same(config[1], input.primary) && same(config[3], input.delay) && config[4] === 86400n);
  check("guard router", same(await read("guard router", input.guard, "aaRouter"), input.router));
  check("guard router runtime pin", same(await read("guard router runtime pin", input.guard, "expectedRouterRuntimeHash"), input.hashes.router));
  for (const name of ["owner", "avatar", "target"]) check(`Delay ${name}`, same(await read(`Delay ${name}`, input.delay, name), input.safe));
  check("Safe enabled on Delay", (await read("Delay upstream", input.delay, "isModuleEnabled", [input.safe])) === true);
  const expectedModules = phase === "before" ? [input.standardModule] : [input.router, input.delay];
  const modules = await read("Safe modules", input.safe, "getModulesPaginated", [SENTINEL_MODULES, 10n]);
  check("exact enabled modules", Array.isArray(modules) && Array.isArray(modules[0]) && modules[0].length === expectedModules.length && expectedModules.every(address => modules[0].some((actual: unknown) => same(actual, address))) && same(modules[1], SENTINEL_MODULES));
  for (const [name, slot, expected] of [
    ["fallback", FALLBACK_SLOT, phase === "before" ? input.standardModule : input.router],
    ["transaction guard", GUARD_SLOT, phase === "before" ? zeroAddress : input.guard],
    ["module guard", MODULE_GUARD_SLOT, phase === "before" ? zeroAddress : input.guard],
  ] as const) {
    try { const word = await input.client.getStorageAt({ address: input.safe, slot }); check(name, !!word && same(`0x${word.slice(-40)}`, expected)); }
    catch { check(name, false); }
  }
  return { ok: failures.length === 0, failures, checked };
}

/** Build one unsigned Safe transaction for an eligible standard-module-only Safe 1.5. */
export function buildSafe4337RouteInstall(input: Safe4337RouteInstallInput): UnsignedSafeRouteInstall {
  const entries = Object.entries(input) as [keyof Safe4337RouteInstallInput, Address][];
  for (const [name, address] of entries) {
    if (!isAddress(address) || address.toLowerCase() === zeroAddress) throw new Error(`invalid ${name} address`);
  }
  if (new Set(entries.map(([, address]) => address.toLowerCase())).size !== entries.length) throw new Error("route installation addresses must differ");
  const call = (functionName: "disableModule" | "enableModule" | "setFallbackHandler" | "setModuleGuard" | "setGuard", args: readonly unknown[]): UnsignedSetupCall => ({
    to: input.safe,
    value: 0n,
    operation: 0,
    data: encodeFunctionData({ abi: SAFE_ROUTE_INSTALL_ABI, functionName, args: args as never }),
  });
  const calls = [
    call("disableModule", [SENTINEL_MODULES, input.standardModule]),
    call("enableModule", [input.router]),
    call("enableModule", [input.delay]),
    call("setFallbackHandler", [input.router]),
    call("setModuleGuard", [input.guard]),
    call("setGuard", [input.guard]),
  ];
  return { to: input.multiSendCallOnly, value: 0n, operation: 1, data: encodeFunctionData({ abi: SAFE_ROUTE_INSTALL_ABI, functionName: "multiSend", args: [encodeCallOnlyBatch(calls)] }) };
}
