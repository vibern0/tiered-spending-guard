import {
  getAddress,
  isAddress,
  keccak256,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

export const SEPOLIA_CHAIN_ID = 11155111 as const;
export const CIRCLE_USDC_SEPOLIA = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Address;
export const REVIEWED_USDC_RUNTIME_CODE_HASH = "0xcd3f29e2ea9c61dadd48bfeaf8b2884b6de9dfee7bf45329452c4c33d0868ceb" as Hex;

const ZERO = zeroAddress;
const SENTINEL_MODULES = "0x0000000000000000000000000000000000000001" as Address;
const FALLBACK_HANDLER_SLOT = "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5" as Hex;
const GUARD_SLOT = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8" as Hex;
const MODULE_GUARD_SLOT = "0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947" as Hex;

const ERC20_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
]);

const SAFE_ABI = parseAbi([
  "function nonce() view returns (uint256)",
  "function getModulesPaginated(address,uint256) view returns (address[] modules,address next)",
]);

const GUARD_ABI = parseAbi([
  "function config() view returns (address safe,address passkey,address ecdsaSecondary,address delay,uint64 periodSeconds,uint64 periodAnchor)",
  "function frozen() view returns (bool)",
  "function getConfiguredTokens() view returns (address[])",
  "function assetPolicy(address) view returns (uint256 basePerTransaction,uint256 stepUpPerTransaction,uint256 baseDailyLimit,uint256 instantDailyLimit)",
  "function getPolicyRecipients(address) view returns (address[])",
  "function spendState(address) view returns (uint256 window,uint256 baseSpent,uint256 instantSpent)",
]);

const DELAY_ABI = parseAbi([
  "function owner() view returns (address)",
  "function avatar() view returns (address)",
  "function target() view returns (address)",
  "function txCooldown() view returns (uint256)",
  "function txExpiration() view returns (uint256)",
  "function txNonce() view returns (uint256)",
  "function queueNonce() view returns (uint256)",
  "function getTxHash(uint256) view returns (bytes32)",
  "function getTxCreatedAt(uint256) view returns (uint256)",
]);

const sameAddress = (left: string | undefined, right: string): boolean => Boolean(left && left.toLowerCase() === right.toLowerCase());

export type VaultConfig = Readonly<{
  chainId: typeof SEPOLIA_CHAIN_ID;
  safe: Address;
  guard: Address;
  delay: Address;
  usdc: Address;
  /** Reviewed Sepolia USDC candidates; an omitted candidate set is unhealthy. */
  usdcCandidates: readonly Address[];
  fromBlock?: bigint;
}>;

export type UsdcMetadata = Readonly<{
  address: Address;
  runtimeCodeHash: Hex;
  name: "USDC";
  symbol: "USDC";
  decimals: 6;
}>;

export type HealthFailure = Readonly<{
  code: string;
  message: string;
  blocking: true;
}>;

export class VaultHealthError extends Error {
  readonly code: string;
  readonly blocking = true as const;

  constructor(code: string, message: string) {
    super(message);
    this.name = "VaultHealthError";
    this.code = code;
  }
}

export type VaultAssetPolicy = Readonly<{
  token: Address;
  basePerTransaction: bigint;
  stepUpPerTransaction: bigint;
  baseDailyLimit: bigint;
  instantDailyLimit: bigint;
  recipients: readonly Address[];
}>;

export type VaultSpendState = Readonly<{
  window: bigint;
  baseSpent: bigint;
  instantSpent: bigint;
}>;

export type VaultQueueItem = Readonly<{
  queueNonce: bigint;
  txHash: Hex;
  createdAt: bigint;
  status: "pending" | "cancelled" | "unknown";
}>;

export type VaultTopology = Readonly<{
  guard: Address;
  moduleGuard: Address;
  modules: readonly Address[];
  fallbackHandler: Address;
  delay: Readonly<{ address: Address; owner: Address; avatar: Address; target: Address; cooldownSeconds: bigint; expirationSeconds: bigint }>;
  frozen: boolean;
}>;

export type VaultSnapshot = Readonly<{
  chainId: typeof SEPOLIA_CHAIN_ID;
  safe: Address;
  usdc?: UsdcMetadata;
  nativeBalance?: bigint;
  usdcBalance?: bigint;
  safeNonce?: bigint;
  topology?: VaultTopology;
  policy?: VaultAssetPolicy;
  spendState?: VaultSpendState;
  queueItems: readonly VaultQueueItem[];
  health: readonly HealthFailure[];
  writable: boolean;
  observedBlock?: bigint;
}>;

type ChainReader = Pick<PublicClient, "getChainId" | "getBytecode" | "getBalance" | "getStorageAt" | "readContract"> &
  Partial<Pick<PublicClient, "getBlockNumber">>;

const read = async <T>(client: ChainReader, address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []): Promise<T> =>
  (await client.readContract({ address, abi, functionName, args })) as T;

const addressFromStorage = (word: Hex | undefined): Address => {
  if (!word || word.length !== 66) throw new VaultHealthError("rpc-inconsistent", "Safe storage response is malformed");
  return getAddress(`0x${word.slice(-40)}`);
};

const health = (error: unknown): HealthFailure => {
  if (error instanceof VaultHealthError) return { code: error.code, message: error.message, blocking: true };
  return { code: "rpc-inconsistent", message: error instanceof Error ? error.message : "Chain read failed", blocking: true };
};

export async function validateUsdc(client: PublicClient, candidate: Address): Promise<UsdcMetadata> {
  if (!isAddress(candidate) || candidate === ZERO || !sameAddress(candidate, CIRCLE_USDC_SEPOLIA)) throw new VaultHealthError("usdc-address-invalid", "USDC candidate is not the reviewed Circle Sepolia contract");
  const reader = client as unknown as ChainReader;
  const runtime = await reader.getBytecode({ address: candidate });
  if (!runtime || runtime === "0x") throw new VaultHealthError("usdc-runtime-missing", "USDC candidate has no runtime bytecode");
  const runtimeCodeHash = keccak256(runtime);
  if (runtimeCodeHash !== REVIEWED_USDC_RUNTIME_CODE_HASH) throw new VaultHealthError("usdc-runtime-mismatch", "USDC runtime does not match the reviewed two-provider artifact");
  const [name, symbol, decimals] = await Promise.all([
    read<string>(reader, candidate, ERC20_ABI, "name"),
    read<string>(reader, candidate, ERC20_ABI, "symbol"),
    read<number>(reader, candidate, ERC20_ABI, "decimals"),
  ]);
  if (name !== "USDC" || symbol !== "USDC" || decimals !== 6) {
    throw new VaultHealthError("usdc-metadata-mismatch", "USDC metadata does not match reviewed Circle USDC metadata");
  }
  return { address: getAddress(candidate), runtimeCodeHash, name, symbol, decimals };
}

function emptySnapshot(config: VaultConfig, failure: HealthFailure): VaultSnapshot {
  return { chainId: config.chainId, safe: config.safe, queueItems: [], health: [failure], writable: false };
}

export async function readVaultSnapshot(client: PublicClient, config: VaultConfig): Promise<VaultSnapshot> {
  const reader = client as unknown as ChainReader;
  if (config.chainId !== SEPOLIA_CHAIN_ID) return emptySnapshot(config, { code: "unsupported-chain", message: "Only Ethereum Sepolia is supported", blocking: true });

  try {
    const chainId = await reader.getChainId();
    if (chainId !== config.chainId) throw new VaultHealthError("wrong-chain", `Connected chain is ${chainId}, expected ${config.chainId}`);
    if (config.usdcCandidates.length === 0 || !config.usdcCandidates.some((candidate) => sameAddress(candidate, config.usdc))) {
      throw new VaultHealthError("usdc-address-unapproved", "USDC address is not in the reviewed candidate set");
    }
    const usdc = await validateUsdc(client, config.usdc);
    const [nativeBalance, usdcBalance, safeNonce, guardSlot, moduleGuardSlot, fallbackSlot, modulesPage, guardConfig, frozen, configuredTokens, delayOwner, delayAvatar, delayTarget, cooldownSeconds, expirationSeconds, txNonce, queueNonce, observedBlock] = await Promise.all([
      reader.getBalance({ address: config.safe }),
      read<bigint>(reader, config.usdc, ERC20_ABI, "balanceOf", [config.safe]),
      read<bigint>(reader, config.safe, SAFE_ABI, "nonce"),
      reader.getStorageAt({ address: config.safe, slot: GUARD_SLOT }),
      reader.getStorageAt({ address: config.safe, slot: MODULE_GUARD_SLOT }),
      reader.getStorageAt({ address: config.safe, slot: FALLBACK_HANDLER_SLOT }),
      read<readonly [readonly Address[], Address]>(reader, config.safe, SAFE_ABI, "getModulesPaginated", [SENTINEL_MODULES, 10n]),
      read<readonly [Address, Address, Address, Address, bigint, bigint]>(reader, config.guard, GUARD_ABI, "config"),
      read<boolean>(reader, config.guard, GUARD_ABI, "frozen"),
      read<readonly Address[]>(reader, config.guard, GUARD_ABI, "getConfiguredTokens"),
      read<Address>(reader, config.delay, DELAY_ABI, "owner"),
      read<Address>(reader, config.delay, DELAY_ABI, "avatar"),
      read<Address>(reader, config.delay, DELAY_ABI, "target"),
      read<bigint>(reader, config.delay, DELAY_ABI, "txCooldown"),
      read<bigint>(reader, config.delay, DELAY_ABI, "txExpiration"),
      read<bigint>(reader, config.delay, DELAY_ABI, "txNonce"),
      read<bigint>(reader, config.delay, DELAY_ABI, "queueNonce"),
      reader.getBlockNumber?.(),
    ]);

    const guard = addressFromStorage(guardSlot);
    const moduleGuard = addressFromStorage(moduleGuardSlot);
    const fallbackHandler = addressFromStorage(fallbackSlot);
    const modules = modulesPage[0];
    const failures: HealthFailure[] = [];
    if (!sameAddress(guard, config.guard)) failures.push({ code: "guard-drift", message: "Safe transaction guard does not match the configured guard", blocking: true });
    if (!sameAddress(moduleGuard, config.guard)) failures.push({ code: "module-guard-drift", message: "Safe module guard does not match the configured guard", blocking: true });
    if (fallbackHandler !== ZERO) failures.push({ code: "fallback-handler-enabled", message: "Safe fallback handler must remain disabled", blocking: true });
    if (modules.length !== 1 || !sameAddress(modules[0], config.delay) || modulesPage[1] !== SENTINEL_MODULES) failures.push({ code: "module-topology-drift", message: "Configured Delay is not the only enabled Safe module", blocking: true });
    if (!sameAddress(guardConfig[0], config.safe) || !sameAddress(guardConfig[3], config.delay) || guardConfig[4] !== 86400n) failures.push({ code: "guard-config-drift", message: "Guard configuration does not match this Safe or its daily period", blocking: true });
    if (!sameAddress(delayOwner, config.safe) || !sameAddress(delayAvatar, config.safe) || !sameAddress(delayTarget, config.safe)) failures.push({ code: "delay-topology-drift", message: "Delay owner, avatar, or target does not match the Safe", blocking: true });
    if (configuredTokens.length === 0 || !configuredTokens.some((token) => sameAddress(token, config.usdc))) failures.push({ code: "usdc-policy-missing", message: "USDC is not configured in the guard policy", blocking: true });

    let policy: VaultAssetPolicy | undefined;
    let spendState: VaultSpendState | undefined;
    if (configuredTokens.some((token) => sameAddress(token, config.usdc))) {
      const [asset, recipients, spend] = await Promise.all([
        read<readonly [bigint, bigint, bigint, bigint]>(reader, config.guard, GUARD_ABI, "assetPolicy", [config.usdc]),
        read<readonly Address[]>(reader, config.guard, GUARD_ABI, "getPolicyRecipients", [config.usdc]),
        read<readonly [bigint, bigint, bigint]>(reader, config.guard, GUARD_ABI, "spendState", [config.usdc]),
      ]);
      policy = { token: usdc.address, basePerTransaction: asset[0], stepUpPerTransaction: asset[1], baseDailyLimit: asset[2], instantDailyLimit: asset[3], recipients };
      spendState = { window: spend[0], baseSpent: spend[1], instantSpent: spend[2] };
    }

    const queueItems: VaultQueueItem[] = [];
    const maxQueueReads = 128n;
    const end = queueNonce < txNonce + maxQueueReads ? queueNonce : txNonce + maxQueueReads;
    for (let nonce = txNonce; nonce < end; nonce += 1n) {
      const [txHash, createdAt] = await Promise.all([
        read<Hex>(reader, config.delay, DELAY_ABI, "getTxHash", [nonce]),
        read<bigint>(reader, config.delay, DELAY_ABI, "getTxCreatedAt", [nonce]),
      ]);
      queueItems.push({ queueNonce: nonce, txHash, createdAt, status: "pending" });
    }

    return {
      chainId: config.chainId,
      safe: config.safe,
      usdc,
      nativeBalance,
      usdcBalance,
      safeNonce: typeof safeNonce === "bigint" ? safeNonce : BigInt(safeNonce),
      topology: { guard, moduleGuard, modules, fallbackHandler, delay: { address: config.delay, owner: delayOwner, avatar: delayAvatar, target: delayTarget, cooldownSeconds, expirationSeconds }, frozen },
      ...(policy === undefined ? {} : { policy }),
      ...(spendState === undefined ? {} : { spendState }),
      queueItems,
      health: failures,
      writable: failures.length === 0,
      ...(observedBlock === undefined ? {} : { observedBlock }),
    };
  } catch (error) {
    return emptySnapshot(config, health(error));
  }
}
