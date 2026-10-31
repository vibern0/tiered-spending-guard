import { getAddress, isAddress, keccak256, parseAbi, type Address, type Hex } from "viem";
import CommittedPwaPhaseOneProfile from "../../config/sepolia.pwa-phase-one.json";

export const SEPOLIA_CHAIN_ID = 11155111 as const;
export const SEPOLIA_USDC_ADDRESS = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Address;
export const PWA_RECIPIENT = "0xaD4D5cd2Ec5beCdB9608baD4c36F0dBe8b2492Bc" as Address;
export const REVIEWED_USDC_RUNTIME_CODE_HASH = "0xcd3f29e2ea9c61dadd48bfeaf8b2884b6de9dfee7bf45329452c4c33d0868ceb" as Hex;
export const REVIEWED_USDC_BLOCK_NUMBER = 12_034_092n;
export const REVIEWED_USDC_BLOCK_HASH = "0x5db4ca50de5c2411433fe8ed34a2eb940de48b9607afb97bf6aa962749b68501" as Hex;
export const PWA_IDENTITY_PROVIDERS = Object.freeze([
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://sepolia.gateway.tenderly.co",
] as const);

const ERC20_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
const HASH = /^0x[0-9a-fA-F]{64}$/;
const RUNTIME = /^0x[0-9a-fA-F]+$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

export type ReviewedUsdcIdentity = Readonly<{
  chainId: typeof SEPOLIA_CHAIN_ID;
  token: Address;
  blockNumber: bigint;
  blockHash: Hex;
  confirmations: 6;
  runtimeCodeHash: Hex;
  name: "USDC";
  symbol: "USDC";
  decimals: 6;
  providers: readonly [string, string];
}>;

export type PwaPhaseOneProfile = Readonly<{
  formatVersion: 1;
  chainId: typeof SEPOLIA_CHAIN_ID;
  token: Address;
  runtimeCodeHash: Hex;
  name: "USDC";
  symbol: "USDC";
  decimals: 6;
  secondaryProfile: "contract-only";
  periodSeconds: 86400;
  periodAnchor: bigint;
  limits: Readonly<{
    basePerTransaction: bigint;
    baseDailyLimit: bigint;
    stepUpPerTransaction: bigint;
    instantDailyLimit: bigint;
  }>;
  delay: Readonly<{ cooldownSeconds: 120; expirationSeconds: 600 }>;
  recipient: Address;
  amounts: Readonly<{ base: bigint; stepUp: bigint; delayed: bigint; funding: bigint }>;
  identityReview: Readonly<{
    blockNumber: bigint;
    blockHash: Hex;
    confirmations: 6;
    providers: readonly [string, string];
  }>;
}>;

export type UsdcIdentityClient = Readonly<{
  source: string;
  getChainId: () => Promise<number>;
  getBlockNumber: () => Promise<bigint>;
  getBlock: (input: Readonly<{ blockNumber: bigint }>) => Promise<Readonly<{ number: bigint; hash: Hex | null }>>;
  getCode: (input: Readonly<{ address: Address; blockNumber: bigint }>) => Promise<Hex | undefined>;
  readContract: (input: Readonly<{ address: Address; abi: typeof ERC20_ABI; functionName: "name" | "symbol" | "decimals"; blockNumber: bigint }>) => Promise<unknown>;
}>;

type IdentityFields = Readonly<{ token: unknown; runtimeCodeHash: unknown; name: unknown; symbol: unknown; decimals: unknown }>;

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
};

const exactKeys = (value: Record<string, unknown>, expected: readonly string[], label: string): void => {
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unknown ${label} field: ${key}`);
  for (const key of expected) if (!(key in value)) throw new Error(`missing ${label} field: ${key}`);
};

const decimal = (value: unknown, label: string): bigint => {
  if (typeof value !== "string" || !DECIMAL.test(value)) throw new Error(`${label} must be a canonical decimal string`);
  return BigInt(value);
};

const exactAddress = (value: unknown, expected: Address, label: string): Address => {
  if (typeof value !== "string" || !isAddress(value) || value.toLowerCase() !== expected.toLowerCase()) throw new Error(`${label} does not match the reviewed address`);
  return getAddress(value);
};

const exactHash = (value: unknown, label: string): Hex => {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} must be a 32-byte hash`);
  return value.toLowerCase() as Hex;
};

export function validateUsdc(value: IdentityFields): void {
  exactAddress(value.token, SEPOLIA_USDC_ADDRESS, "USDC token");
  const runtimeCodeHash = exactHash(value.runtimeCodeHash, "USDC runtime code hash");
  if (runtimeCodeHash !== REVIEWED_USDC_RUNTIME_CODE_HASH) throw new Error("USDC runtime code hash does not match the reviewed artifact");
  if (value.name !== "USDC" || value.symbol !== "USDC" || value.decimals !== 6) throw new Error("USDC metadata does not match the reviewed Sepolia deployment");
}

export function loadPwaPhaseOneProfile(value: unknown): PwaPhaseOneProfile {
  const input = object(value, "profile");
  exactKeys(input, ["formatVersion", "chainId", "token", "runtimeCodeHash", "name", "symbol", "decimals", "secondaryProfile", "periodSeconds", "periodAnchor", "limits", "delay", "recipient", "amounts", "identityReview"], "profile");
  if (input.formatVersion !== 1) throw new Error("unsupported profile formatVersion");
  if (input.chainId !== SEPOLIA_CHAIN_ID) throw new Error("PWA profile supports only Ethereum Sepolia");
  validateUsdc(input as unknown as IdentityFields);
  if (input.secondaryProfile !== "contract-only") throw new Error("PWA profile must use contract-only secondary authorization");
  if (input.periodSeconds !== 86400) throw new Error("PWA profile requires the canonical daily period");
  const periodAnchor = decimal(input.periodAnchor, "periodAnchor");
  if (periodAnchor !== 0n) throw new Error("PWA profile requires Unix epoch-aligned periods");

  const limitsInput = object(input.limits, "limits");
  exactKeys(limitsInput, ["basePerTransaction", "baseDailyLimit", "stepUpPerTransaction", "instantDailyLimit"], "limits");
  const limits = Object.freeze({
    basePerTransaction: decimal(limitsInput.basePerTransaction, "basePerTransaction"),
    baseDailyLimit: decimal(limitsInput.baseDailyLimit, "baseDailyLimit"),
    stepUpPerTransaction: decimal(limitsInput.stepUpPerTransaction, "stepUpPerTransaction"),
    instantDailyLimit: decimal(limitsInput.instantDailyLimit, "instantDailyLimit"),
  });
  if (limits.basePerTransaction !== 1_000_000n || limits.baseDailyLimit !== 1_000_000n) throw new Error("PWA profile does not match canonical X limits");
  if (limits.stepUpPerTransaction !== 3_000_000n || limits.instantDailyLimit !== 3_000_000n) throw new Error("PWA profile does not match canonical Y limits");

  const delayInput = object(input.delay, "delay");
  exactKeys(delayInput, ["cooldownSeconds", "expirationSeconds"], "delay");
  if (delayInput.cooldownSeconds !== 120 || delayInput.expirationSeconds !== 600) throw new Error("PWA profile does not match canonical delay");

  const amountsInput = object(input.amounts, "amounts");
  exactKeys(amountsInput, ["base", "stepUp", "delayed", "funding"], "amounts");
  const amounts = Object.freeze({
    base: decimal(amountsInput.base, "base amount"),
    stepUp: decimal(amountsInput.stepUp, "step-up amount"),
    delayed: decimal(amountsInput.delayed, "delayed amount"),
    funding: decimal(amountsInput.funding, "funding amount"),
  });
  if (amounts.base !== 1_000_000n || amounts.stepUp !== 2_000_000n || amounts.delayed !== 4_000_000n || amounts.funding !== 8_000_000n) throw new Error("PWA rehearsal amounts do not match the canonical profile");

  const reviewInput = object(input.identityReview, "identityReview");
  exactKeys(reviewInput, ["blockNumber", "blockHash", "confirmations", "providers"], "identityReview");
  const providers = reviewInput.providers;
  if (!Array.isArray(providers) || providers.length !== 2 || providers[0] !== PWA_IDENTITY_PROVIDERS[0] || providers[1] !== PWA_IDENTITY_PROVIDERS[1]) throw new Error("identityReview must use the two reviewed providers");
  if (reviewInput.confirmations !== 6) throw new Error("identityReview requires six confirmations");
  const identityReview = Object.freeze({
    blockNumber: decimal(reviewInput.blockNumber, "identityReview blockNumber"),
    blockHash: exactHash(reviewInput.blockHash, "identityReview blockHash"),
    confirmations: 6 as const,
    providers: PWA_IDENTITY_PROVIDERS,
  });
  if (identityReview.blockNumber !== REVIEWED_USDC_BLOCK_NUMBER || identityReview.blockHash !== REVIEWED_USDC_BLOCK_HASH) throw new Error("identityReview does not match the committed two-provider artifact");

  return Object.freeze({
    formatVersion: 1 as const,
    chainId: SEPOLIA_CHAIN_ID,
    token: SEPOLIA_USDC_ADDRESS,
    runtimeCodeHash: REVIEWED_USDC_RUNTIME_CODE_HASH,
    name: "USDC" as const,
    symbol: "USDC" as const,
    decimals: 6 as const,
    secondaryProfile: "contract-only" as const,
    periodSeconds: 86400 as const,
    periodAnchor,
    limits,
    delay: Object.freeze({ cooldownSeconds: 120 as const, expirationSeconds: 600 as const }),
    recipient: exactAddress(input.recipient, PWA_RECIPIENT, "recipient"),
    amounts,
    identityReview,
  });
}

/** Returns the only deployment policy accepted by the supported PWA backend. */
export function loadCommittedPwaPhaseOneProfile(): PwaPhaseOneProfile {
  return loadPwaPhaseOneProfile(CommittedPwaPhaseOneProfile);
}

const readIdentity = async (client: UsdcIdentityClient, blockNumber: bigint) => {
  const [chainId, head, block, runtime, name, symbol, decimals] = await Promise.all([
    client.getChainId(),
    client.getBlockNumber(),
    client.getBlock({ blockNumber }),
    client.getCode({ address: SEPOLIA_USDC_ADDRESS, blockNumber }),
    client.readContract({ address: SEPOLIA_USDC_ADDRESS, abi: ERC20_ABI, functionName: "name", blockNumber }),
    client.readContract({ address: SEPOLIA_USDC_ADDRESS, abi: ERC20_ABI, functionName: "symbol", blockNumber }),
    client.readContract({ address: SEPOLIA_USDC_ADDRESS, abi: ERC20_ABI, functionName: "decimals", blockNumber }),
  ]);
  if (chainId !== SEPOLIA_CHAIN_ID) throw new Error(`${client.source} is not Ethereum Sepolia`);
  if (head < blockNumber + 5n) throw new Error(`${client.source} has fewer than six confirmations`);
  if (block.number !== blockNumber || !block.hash || !HASH.test(block.hash)) throw new Error(`${client.source} returned an invalid pinned block`);
  if (!runtime || runtime === "0x" || !RUNTIME.test(runtime)) throw new Error(`${client.source} returned empty USDC runtime`);
  if (name !== "USDC" || symbol !== "USDC" || decimals !== 6) throw new Error(`${client.source} returned unexpected USDC metadata`);
  return Object.freeze({ blockHash: block.hash, runtime, runtimeCodeHash: keccak256(runtime), name, symbol, decimals });
};

export async function captureUsdcIdentity(clientA: UsdcIdentityClient, clientB: UsdcIdentityClient, blockNumber: bigint): Promise<ReviewedUsdcIdentity> {
  if (blockNumber <= 0n) throw new Error("blockNumber must be positive");
  if (clientA.source === clientB.source || !clientA.source.startsWith("https://") || !clientB.source.startsWith("https://")) throw new Error("two distinct HTTPS providers are required");
  const [a, b] = await Promise.all([readIdentity(clientA, blockNumber), readIdentity(clientB, blockNumber)]);
  if (a.blockHash.toLowerCase() !== b.blockHash.toLowerCase()) throw new Error("USDC identity block hash disagreement");
  if (a.runtime !== b.runtime || a.runtimeCodeHash !== b.runtimeCodeHash) throw new Error("USDC identity runtime disagreement");
  if (a.name !== b.name || a.symbol !== b.symbol || a.decimals !== b.decimals) throw new Error("USDC identity metadata disagreement");
  const [recheckA, recheckB] = await Promise.all([clientA.getBlock({ blockNumber }), clientB.getBlock({ blockNumber })]);
  if (recheckA.hash?.toLowerCase() !== a.blockHash.toLowerCase() || recheckB.hash?.toLowerCase() !== a.blockHash.toLowerCase()) throw new Error("USDC identity reorg detected");
  return Object.freeze({
    chainId: SEPOLIA_CHAIN_ID,
    token: SEPOLIA_USDC_ADDRESS,
    blockNumber,
    blockHash: a.blockHash,
    confirmations: 6 as const,
    runtimeCodeHash: a.runtimeCodeHash,
    name: "USDC" as const,
    symbol: "USDC" as const,
    decimals: 6 as const,
    providers: Object.freeze([clientA.source, clientB.source]) as readonly [string, string],
  });
}
