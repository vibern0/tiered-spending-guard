import { keccak256, parseAbi, type Address, type Hex } from "viem";
import { assertValidVaultPolicy, type VaultPolicy } from "../config/policy";
import { isVerifiedVaultPrerequisites, policyHash, type VerifiedVaultPrerequisites } from "./build";
import { isOfficialVerifiedDeployments, type VerifiedDeployments } from "../config/deployments";

export type TopologyReadClient = {
  getBytecode(args: { address: Address }): Promise<Hex | undefined>;
  getStorageAt(args: { address: Address; slot: Hex }): Promise<Hex | undefined>;
  readContract(args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
};
export type TopologyInput = Readonly<{ chainId: number; policy: VaultPolicy; safe: Address; guard: Address; delay: Address; deployments: VerifiedDeployments; prerequisites: VerifiedVaultPrerequisites; client: TopologyReadClient }>;
export type TopologyReport = Readonly<{ ok: boolean; failures: readonly string[]; checked: readonly string[] }>;

const ABI = parseAbi([
  "function maintenance() view returns (address)", "function safe() view returns (address)", "function delay() view returns (address)",
  "function masterCopy() view returns (address)", "function VERSION() view returns (string)", "function getOwners() view returns (address[])", "function getThreshold() view returns (uint256)", "function getModulesPaginated(address,uint256) view returns (address[],address)", "function isModuleEnabled(address) view returns (bool)",
  "function config() view returns (address,address,address,address,uint64,uint64)", "function safeContractSecondary() view returns (address,uint8,bool)", "function ecdsaSecondary() view returns (address,uint8,bool)", "function assetPolicy(address) view returns (uint256,uint256,uint256,uint256,uint8)", "function spendState(address) view returns (uint256,uint256,uint256)", "function getPolicyRecipients(address) view returns (address[])", "function getConfiguredTokens() view returns (address[])", "function policyHash() view returns (bytes32)",
  "function owner() view returns (address)", "function avatar() view returns (address)", "function target() view returns (address)", "function txCooldown() view returns (uint256)", "function txExpiration() view returns (uint256)",
]);
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const SENTINEL_MODULES = "0x0000000000000000000000000000000000000001" as Address;
const FALLBACK_HANDLER_SLOT = "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5" as Hex;
const GUARD_SLOT = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8" as Hex;
const MODULE_GUARD_SLOT = "0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947" as Hex;
const same = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b;
const tuple = (value: unknown): readonly unknown[] | undefined => Array.isArray(value) ? value : undefined;
const storageAddress = (word: Hex | undefined): Address | undefined => word ? `0x${word.slice(-40)}` as Address : undefined;
const expectedOwners = (policy: VaultPolicy): readonly Address[] => {
  const safeContractSecondary = policy.secondaries?.find((signer) => signer.kind === "safe-contract" && signer.enabled)?.address;
  const ecdsaSecondary = policy.secondaries?.find((signer) => signer.kind === "ecdsa-extension" && signer.enabled && same(signer.address, policy.ecdsaSecondary))?.address;
  return safeContractSecondary && (policy.secondaryProfile === "contract-only" || ecdsaSecondary) ? [policy.passkey] : [];
};

/** Fetch independently, then evaluate in the original order so report hashes stay stable. */
async function collectTopologyReads(input: TopologyInput): Promise<TopologyReadClient> {
  const contract = (address: Address, functionName: string, args: readonly unknown[] = []) => ({ address, abi: ABI, functionName, args });
  const contracts = [
    contract(input.guard, "maintenance"), contract(input.prerequisites.maintenance.address, "safe"), contract(input.prerequisites.maintenance.address, "delay"),
    ...["masterCopy", "VERSION", "getOwners", "getThreshold"].map(name => contract(input.safe, name)),
    contract(input.safe, "getModulesPaginated", [SENTINEL_MODULES, 10n]),
    ...["config", "safeContractSecondary", "ecdsaSecondary", "policyHash", "getConfiguredTokens"].map(name => contract(input.guard, name)),
    ...input.policy.assets.flatMap(asset => ["assetPolicy", "getPolicyRecipients", "spendState"].map(name => contract(input.guard, name, [asset.token]))),
    ...["owner", "avatar", "target", "txCooldown", "txExpiration"].map(name => contract(input.delay, name)),
    contract(input.delay, "getModulesPaginated", [SENTINEL_MODULES, 10n]),
  ];
  const key = (kind: string, args: unknown) => `${kind}:${JSON.stringify(args, (_k, v) => typeof v === "bigint" ? v.toString() : v)}`;
  const requests = [
    ...[input.safe, input.guard, input.delay, input.prerequisites.maintenance.address].map(address => {
      const args = { address }; return { key: key("code", args), read: () => input.client.getBytecode(args) };
    }),
    ...[FALLBACK_HANDLER_SLOT, GUARD_SLOT, MODULE_GUARD_SLOT].map(slot => {
      const args = { address: input.safe, slot }; return { key: key("storage", args), read: () => input.client.getStorageAt(args) };
    }),
    ...contracts.map(args => ({ key: key("contract", args), read: () => input.client.readContract(args) })),
  ];
  const values = await Promise.allSettled(requests.map(request => Promise.resolve().then(request.read)));
  const results = new Map(requests.map((request, index) => [request.key, values[index]!]));
  const result = async (kind: string, args: unknown): Promise<unknown> => {
    const value = results.get(key(kind, args));
    if (!value) throw new Error("topology read was not collected");
    if (value.status === "rejected") throw value.reason;
    return value.value;
  };
  return {
    getBytecode: args => result("code", args) as Promise<Hex | undefined>,
    getStorageAt: args => result("storage", args) as Promise<Hex | undefined>,
    readContract: args => result("contract", { ...args, args: args.args ?? [] }),
  };
}

export async function verifyTopology(input: TopologyInput): Promise<TopologyReport> {
  const failures: string[] = []; const checked: string[] = [];
  if (!isOfficialVerifiedDeployments(input.deployments)) {
    return { ok: false, failures: ["deployments: official resolver evidence required"], checked };
  }
  if (!isVerifiedVaultPrerequisites(input.prerequisites)) {
    return { ok: false, failures: ["prerequisites: vault component evidence required"], checked };
  }
  if (input.prerequisites.stage !== "after-setup") return { ok: false, failures: ["prerequisites: post-setup evidence required"], checked };
  const check = (name: string, condition: boolean) => { checked.push(name); if (!condition) failures.push(name); };
  try { assertValidVaultPolicy(input.policy); } catch (error) { failures.push("policy: " + (error instanceof Error ? error.message : "invalid")); return { ok: false, failures, checked }; }
  const client = await collectTopologyReads(input);
  check("chain id", input.chainId === input.policy.chainId && input.deployments.chainId === input.chainId); check("safe address", same(input.safe, input.policy.safe)); check("Delay address", same(input.delay, input.policy.delay) && same(input.delay, input.prerequisites.delay.address)); check("guard address", same(input.guard, input.prerequisites.guard.address));
  const code = async (label: string, address: Address, expected: Hex) => { try { const actual = await client.getBytecode({ address }); check(label + " bytecode", !!actual && actual !== "0x"); check(label + " code hash", !!actual && keccak256(actual).toLowerCase() === expected.toLowerCase()); } catch { check(label + " bytecode", false); check(label + " code hash", false); } };
  await code("Safe proxy", input.safe, input.prerequisites.safeProxyRuntimeCodeHash); await code("guard", input.guard, input.prerequisites.guard.runtimeCodeHash); await code("Delay", input.delay, input.prerequisites.delay.runtimeCodeHash);
  const read = async (label: string, address: Address, functionName: string, args: readonly unknown[] = []): Promise<unknown> => { try { return await client.readContract({ address, abi: ABI, functionName, args }); } catch { failures.push(label + " read"); return undefined; } };
  const maintenance = input.prerequisites.maintenance;
  await code("maintenance", maintenance.address, maintenance.runtimeCodeHash);
  check("guard maintenance", same(await read("guard maintenance", input.guard, "maintenance"), maintenance.address));
  check("maintenance Safe", same(await read("maintenance Safe", maintenance.address, "safe"), input.safe));
  check("maintenance Delay", same(await read("maintenance Delay", maintenance.address, "delay"), input.delay));
  const storage = async (label: string, slot: Hex): Promise<Address | undefined> => { try { return storageAddress(await client.getStorageAt({ address: input.safe, slot })); } catch { failures.push(label + " read"); return undefined; } };
  const masterCopy = await read("Safe singleton", input.safe, "masterCopy"); check("Safe proxy singleton", same(masterCopy, input.deployments.dependencies.safeSingleton.address)); check("Safe version", (await read("Safe version", input.safe, "VERSION")) === input.deployments.dependencies.safeSingleton.version);
  const owners = tuple(await read("owners", input.safe, "getOwners")); const expectedSafeOwners = expectedOwners(input.policy); check("owners", !!owners && owners.length === 1 && expectedSafeOwners.length === 1 && owners.every((x, i) => same(x, expectedSafeOwners[i])));
  check("threshold", (await read("threshold", input.safe, "getThreshold")) === 1n); check("fallback handler", same(await storage("fallback handler", FALLBACK_HANDLER_SLOT), ZERO)); check("transaction guard", same(await storage("transaction guard", GUARD_SLOT), input.guard)); check("module guard", same(await storage("module guard", MODULE_GUARD_SLOT), input.guard));
  const modulesPage = tuple(await read("modules", input.safe, "getModulesPaginated", [SENTINEL_MODULES, 10n])); const modules = tuple(modulesPage?.[0]); check("only Delay module", !!modulesPage && modulesPage.length === 2 && !!modules && modules.length === 1 && same(modules[0], input.delay) && same(modulesPage[1], SENTINEL_MODULES));
  const config = tuple(await read("guard config", input.guard, "config")); check("guard config", !!config && same(config[0], input.safe) && same(config[1], input.policy.passkey) && same(config[2], input.policy.ecdsaSecondary) && same(config[3], input.delay) && config[4] === 86400n && config[5] === input.policy.periodAnchor);
  const safeContractSecondary = tuple(await read("safe-contract secondary", input.guard, "safeContractSecondary")); check("safe-contract secondary", !!safeContractSecondary && safeContractSecondary.length === 3 && same(safeContractSecondary[0], input.policy.secondaries?.find((signer) => signer.kind === "safe-contract" && signer.enabled)?.address) && safeContractSecondary[1] === 0 && safeContractSecondary[2] === true);
  const ecdsaSecondary = tuple(await read("ECDSA secondary", input.guard, "ecdsaSecondary")); check("ECDSA secondary", !!ecdsaSecondary && ecdsaSecondary.length === 3 && same(ecdsaSecondary[0], input.policy.ecdsaSecondary) && ecdsaSecondary[1] === 1 && ecdsaSecondary[2] === (input.policy.secondaryProfile !== "contract-only"));
  check("policy hash", (await read("policy hash", input.guard, "policyHash")) === policyHash(input.policy));
  const configuredTokens = tuple(await read("configured assets", input.guard, "getConfiguredTokens")); check("configured assets", !!configuredTokens && configuredTokens.length === input.policy.assets.length && configuredTokens.every((x, i) => same(x, input.policy.assets[i]?.token)));
  for (const asset of input.policy.assets) { const configured = tuple(await read("asset policy " + asset.token, input.guard, "assetPolicy", [asset.token])); check("asset policy " + asset.token, !!configured && configured[0] === asset.basePerTransaction && configured[1] === asset.stepUpPerTransaction && configured[2] === asset.baseDailyLimit && configured[3] === asset.instantDailyLimit && configured.length === 5 && configured[4] === (asset.baseRecipientMode === "any-valid-address" ? 1 : 0)); const recipients = tuple(await read("recipients " + asset.token, input.guard, "getPolicyRecipients", [asset.token])); check("recipients " + asset.token, !!recipients && recipients.length === asset.recipients.length && recipients.every((x, i) => same(x, asset.recipients[i]))); const state = tuple(await read("counter " + asset.token, input.guard, "spendState", [asset.token])); check("counter " + asset.token, !!state && state.length === 3 && typeof state[0] === "bigint" && (state[1] as bigint) <= asset.baseDailyLimit && (state[2] as bigint) <= asset.instantDailyLimit); }
  check("Delay owner", same(await read("Delay owner", input.delay, "owner"), input.safe)); check("Delay avatar", same(await read("Delay avatar", input.delay, "avatar"), input.safe)); check("Delay target", same(await read("Delay target", input.delay, "target"), input.safe)); check("Delay cooldown", (await read("Delay cooldown", input.delay, "txCooldown")) === BigInt(input.policy.cooldownSeconds)); check("Delay expiration", (await read("Delay expiration", input.delay, "txExpiration")) === BigInt(input.policy.expirationSeconds)); const upstreamPage = tuple(await read("Delay upstream module enumeration", input.delay, "getModulesPaginated", [SENTINEL_MODULES, 10n])); const upstream = tuple(upstreamPage?.[0]); check("only Safe upstream module", !!upstreamPage && upstreamPage.length === 2 && !!upstream && upstream.length === 1 && same(upstream[0], input.safe) && same(upstreamPage[1], SENTINEL_MODULES));
  return { ok: failures.length === 0, failures, checked };
}
