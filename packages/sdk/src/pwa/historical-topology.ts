import { isAddressEqual, keccak256, parseAbi, type Address, type Hex } from "viem";
import { verifyOfficialDeploymentDependencies, type DeploymentInfrastructureRegistry } from "../config/deployments";
import type { PwaProvisioningPlan, PwaProvisioningTransaction } from "./provisioning";
import type { PwaProvisioningRecoveryClient } from "./provisioning-recovery";

export type HistoricalPwaReadClient = PwaProvisioningRecoveryClient & Readonly<{
  getBytecode(input: { address: Address; blockNumber?: bigint }): Promise<Hex | undefined>;
  getStorageAt(input: { address: Address; slot: Hex; blockNumber?: bigint }): Promise<Hex | undefined>;
  readContract(input: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }): Promise<unknown>;
}>;

type HistoricalAsset = Readonly<{ token: Address; basePerTransaction: string; stepUpPerTransaction: string; baseDailyLimit: string; instantDailyLimit: string; recipients: readonly Address[] }>;
export type HistoricalReview = Readonly<{
  chainId: 11155111;
  deployer: Address;
  planHash: Hex;
  addresses: Pick<PwaProvisioningPlan, "safe" | "guard" | "delay" | "primaryPasskey" | "secondaryPasskey" | "usdc">;
  transactions: readonly PwaProvisioningTransaction[];
  policy: Readonly<{ owners: readonly Address[]; safeContractSecondary: Address; ecdsaSecondary: Address; periodAnchor: string; policyHash: Hex; assets: readonly HistoricalAsset[]; delay: Readonly<{ cooldownSeconds: number; expirationSeconds: number }> }>;
}>;

export type PwaHistoricalVault = Readonly<HistoricalReview["addresses"] & {
  credentials?: Readonly<{ primary: { x: bigint; y: bigint }; secondary: { x: bigint; y: bigint } }>;
  mode: "read-only";
  profileVersion: "sepolia-pwa-phase-one-allowlisted-v1";
  chainId: 11155111;
  policy: Readonly<{ recipientMode: "all-lanes-allowlisted"; assets: readonly HistoricalAsset[] }>;
  evidence: Readonly<{ originalPackageHash: Hex; packageHash: Hex; planHash: Hex; policyHash: Hex; setupTransactionHash: Hex; topologyReportHash: Hex; blockNumber: string; blockHash: Hex }>;
}>;

const ABI = parseAbi([
  "function maintenance() view returns (address)", "function safe() view returns (address)", "function delay() view returns (address)",
  "function masterCopy() view returns (address)", "function VERSION() view returns (string)", "function getOwners() view returns (address[])", "function getThreshold() view returns (uint256)", "function getModulesPaginated(address,uint256) view returns (address[],address)",
  "function config() view returns (address,address,address,address,uint64,uint64)", "function safeContractSecondary() view returns (address,uint8,bool)", "function ecdsaSecondary() view returns (address,uint8,bool)",
  "function assetPolicy(address) view returns (uint256,uint256,uint256,uint256)", "function spendState(address) view returns (uint256,uint256,uint256)", "function getPolicyRecipients(address) view returns (address[])", "function getConfiguredTokens() view returns (address[])", "function policyHash() view returns (bytes32)",
  "function owner() view returns (address)", "function avatar() view returns (address)", "function target() view returns (address)", "function txCooldown() view returns (uint256)", "function txExpiration() view returns (uint256)",
  "function getSigner(uint256,uint256,uint176) view returns (address)",
]);
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const SENTINEL = "0x0000000000000000000000000000000000000001" as Address;
const FALLBACK_SLOT = "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5" as Hex;
const GUARD_SLOT = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8" as Hex;
const MODULE_GUARD_SLOT = "0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947" as Hex;
const same = (left: unknown, right: unknown) => typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
function check(ok: unknown, label: string): asserts ok { if (!ok) throw new Error(`fail closed: historical PWA topology ${label}`); }
function tuple(value: unknown, length?: number): readonly unknown[] { check(Array.isArray(value) && (length === undefined || value.length === length), "malformed tuple"); return value; }

/** Read-only old-ABI verification. It issues no current topology/provisioning capability. */
export async function verifyHistoricalPwaTopology(input: Readonly<{
  review: HistoricalReview;
  client: HistoricalPwaReadClient;
  blockNumber: bigint;
  credentials: Readonly<{ primary: { x: bigint; y: bigint }; secondary: { x: bigint; y: bigint } }>;
  registry?: DeploymentInfrastructureRegistry;
}>): Promise<readonly Readonly<{ window: string; baseSpent: string; instantSpent: string }>[]> {
  const { review, client, blockNumber } = input;
  const { safe, guard, delay, primaryPasskey, secondaryPasskey } = review.addresses;
  const read = (address: Address, functionName: string, args: readonly unknown[] = []) => client.readContract({ address, abi: ABI, functionName, args, blockNumber });
  const dependencies = await verifyOfficialDeploymentDependencies({ getBytecode: ({ address }) => client.getBytecode({ address, blockNumber }) }, review.chainId, input.registry);
  for (const transaction of review.transactions) {
    const runtime = await client.getBytecode({ address: transaction.expectedCreatedAddress, blockNumber });
    check(runtime && runtime !== "0x" && same(keccak256(runtime), transaction.expectedRuntimeCodeHash), `runtime ${transaction.id}`);
  }
  for (const [index, credential, signer] of [[0, input.credentials.primary, primaryPasskey], [1, input.credentials.secondary, secondaryPasskey]] as const) {
    check(same(review.transactions[index]!.to, dependencies.passkeySignerFactory.address), "signer factory destination");
    check(same(await read(dependencies.passkeySignerFactory.address, "getSigner", [credential.x, credential.y, BigInt(dependencies.passkeySignerVerifier.address)]), signer), "signer factory binding");
  }
  check(same(await read(safe, "masterCopy"), dependencies.safeSingleton.address), "Safe singleton");
  check(await read(safe, "VERSION") === dependencies.safeSingleton.version, "Safe version");
  const owners = tuple(await read(safe, "getOwners"), 1);
  check(same(owners[0], primaryPasskey) && review.policy.owners.length === 1 && same(review.policy.owners[0], primaryPasskey), "primary owner");
  check(await read(safe, "getThreshold") === 1n, "threshold");
  for (const [slot, expected] of [[FALLBACK_SLOT, ZERO], [GUARD_SLOT, guard], [MODULE_GUARD_SLOT, guard]] as const) {
    const value = await client.getStorageAt({ address: safe, slot, blockNumber });
    check(value && /^0x[0-9a-fA-F]{64}$/.test(value) && same(`0x${value.slice(-40)}`, expected), "Safe guard/fallback storage");
  }
  for (const [address, expected] of [[safe, delay], [delay, safe]] as const) {
    const page = tuple(await read(address, "getModulesPaginated", [SENTINEL, 10n]), 2);
    check(same(tuple(page[0], 1)[0], expected) && same(page[1], SENTINEL), "only reviewed module");
  }
  const maintenance = review.transactions[5]!.expectedCreatedAddress;
  check(same(await read(guard, "maintenance"), maintenance) && same(await read(maintenance, "safe"), safe) && same(await read(maintenance, "delay"), delay), "maintenance binding");
  const config = tuple(await read(guard, "config"), 6);
  check(same(config[0], safe) && same(config[1], primaryPasskey) && same(config[2], ZERO) && same(config[3], delay) && config[4] === 86400n && config[5] === BigInt(review.policy.periodAnchor), "guard config");
  const secondary = tuple(await read(guard, "safeContractSecondary"), 3);
  const ecdsa = tuple(await read(guard, "ecdsaSecondary"), 3);
  check(same(secondary[0], secondaryPasskey) && secondary[1] === 0 && secondary[2] === true && same(review.policy.safeContractSecondary, secondaryPasskey), "contract secondary");
  check(same(ecdsa[0], ZERO) && ecdsa[1] === 1 && ecdsa[2] === false && same(review.policy.ecdsaSecondary, ZERO), "disabled ECDSA secondary");
  check(same(await read(guard, "policyHash"), review.policy.policyHash), "historical policy hash");
  const tokens = tuple(await read(guard, "getConfiguredTokens"), review.policy.assets.length);
  const states = [];
  for (const [index, asset] of review.policy.assets.entries()) {
    check(!("baseRecipientMode" in asset) && same(tokens[index], asset.token), "historical asset identity");
    const configured = tuple(await read(guard, "assetPolicy", [asset.token]), 4);
    const limits = [asset.basePerTransaction, asset.stepUpPerTransaction, asset.baseDailyLimit, asset.instantDailyLimit].map(BigInt);
    check(configured.every((value, i) => value === limits[i]), "asset limits");
    const recipients = tuple(await read(guard, "getPolicyRecipients", [asset.token]), asset.recipients.length);
    check(recipients.every((recipient, i) => same(recipient, asset.recipients[i])), "allowlisted recipients");
    const state = tuple(await read(guard, "spendState", [asset.token]), 3);
    check(state.every(value => typeof value === "bigint" && value >= 0n) && (state[1] as bigint) <= limits[2]! && (state[2] as bigint) <= limits[3]! && (state[1] as bigint) <= (state[2] as bigint), "spending counters");
    states.push(Object.freeze({ window: String(state[0]), baseSpent: String(state[1]), instantSpent: String(state[2]) }));
  }
  for (const functionName of ["owner", "avatar", "target"]) check(same(await read(delay, functionName), safe), `Delay ${functionName}`);
  check(await read(delay, "txCooldown") === BigInt(review.policy.delay.cooldownSeconds) && await read(delay, "txExpiration") === BigInt(review.policy.delay.expirationSeconds), "Delay timing");
  return Object.freeze(states);
}
