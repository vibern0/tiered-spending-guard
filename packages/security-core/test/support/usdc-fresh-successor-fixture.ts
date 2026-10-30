import type { Address, Hex } from "viem";
import type {
  UsdcSuccessorCanonicalState,
  UsdcSuccessorEvidenceProvider,
} from "../../scripts/live/ordinary-scenario-usdc-successor-certificate";
import type { UsdcRecycleContinuationSource } from "../../scripts/live/ordinary-scenario-usdc-recycle-continuation-certificate";
import {
  canonicalRecycleState,
  createUsdcRecycleContinuationSource,
  recycleFixture,
  recycleProvider,
} from "./usdc-recycle-continuation-fixture";

const h = (byte: string): Hex => `0x${byte.repeat(64)}` as Hex;

export const freshHistoricalSnapshot = Object.freeze({
  number: 12_019_465n,
  hash: "0xbf7cbfcf7b46054149edf3a71b9cb26ccdf728ef3db5389af09fc51550a4f754" as Hex,
  timestamp: 1_793_276_400n,
});
export const freshFaucetBlock = Object.freeze({
  number: 12_026_817n,
  hash: "0x8bda9049010367bff921be7b89c281c6f30367af9534743463a61859aefe1d83" as Hex,
  timestamp: 1_793_365_008n,
});
export const freshSnapshot = Object.freeze({
  number: 12_026_824n,
  hash: h("f"),
  timestamp: 1_793_365_092n,
});

const faucetTransaction = Object.freeze({
  type: "eip1559" as const,
  chainId: 11_155_111,
  hash: "0x6230026c81cc67ce4aa3cf713838875c7b1d770cbe0f9b48b7b4b3b49f1a59fa" as Hex,
  from: "0xd844ba11f64d23a7481e24474d2f184e350b9b3d" as Address,
  nonce: 1_059_380,
  to: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238" as Address,
  value: 0n,
  inputHash: "0xb55612dc53b2c541469c774e8e4238a2a94d376826a7d8ebe099e02dd578a53b" as Hex,
  gas: 73_785n,
  maxFeePerGas: 1_000_000_015n,
  maxPriorityFeePerGas: 999_999_985n,
  blockNumber: freshFaucetBlock.number,
  blockHash: freshFaucetBlock.hash,
});
const faucetReceipt = Object.freeze({
  transactionHash: faucetTransaction.hash,
  status: "success" as const,
  blockNumber: freshFaucetBlock.number,
  blockHash: freshFaucetBlock.hash,
  gasUsed: 53_859n,
  effectiveGasPrice: 1_000_000_000n,
});

export type FreshProviderMutation = Readonly<{
  snapshot?: Partial<typeof freshSnapshot>;
  state?: Partial<UsdcSuccessorCanonicalState>;
  faucetTransaction?: Record<string, unknown>;
  faucetReceipt?: Record<string, unknown>;
  faucetLog?: Record<string, unknown>;
  omitFaucetLog?: boolean;
  faucetBlock?: Partial<typeof freshFaucetBlock>;
  faucetPreBalance?: bigint;
  faucetPostBalance?: bigint;
  snapshotNonce?: number;
  latestNonce?: number;
  pendingNonce?: number;
  reorgHash?: Hex;
}>;

const funder = "0xaD4D5cd2Ec5beCdB9608baD4c36F0dBe8b2492Bc" as Address;
const faucet = "0xd844ba11f64d23a7481e24474d2f184e350b9b3d" as Address;
const faucetLog = Object.freeze({
  address: "0x1c7d4b196cb0c7b01d743Fbc6116a902379C7238" as Address,
  transactionHash: faucetTransaction.hash,
  blockNumber: freshFaucetBlock.number,
  blockHash: freshFaucetBlock.hash,
  logIndex: 299,
  removed: false,
  from: faucet,
  to: funder,
  amount: 20_000_000n,
});

async function provider(index: 0 | 1, source: UsdcRecycleContinuationSource, mutation: FreshProviderMutation): Promise<UsdcSuccessorEvidenceProvider & { readFaucetTransferLog(hash: Hex): Promise<typeof faucetLog | undefined> }> {
  const historical = await recycleProvider(index, source, { snapshot: freshHistoricalSnapshot });
  const snapshot = { ...freshSnapshot, ...mutation.snapshot };
  const faucetBlock = { ...freshFaucetBlock, ...mutation.faucetBlock };
  let snapshotReads = 0;
  const current = { ...canonicalRecycleState(source, snapshot), funderUsdcBalance: 40_000_000n, ...mutation.state } as UsdcSuccessorCanonicalState;
  const at = (blockNumber: bigint) => {
    if (blockNumber === snapshot.number) return { ...current, blockNumber, blockHash: snapshot.hash };
    if (blockNumber === faucetBlock.number) return { ...current, blockNumber, blockHash: faucetBlock.hash, funderUsdcBalance: mutation.faucetPostBalance ?? 40_000_000n };
    if (blockNumber === faucetBlock.number - 1n) return { ...current, blockNumber, blockHash: h("e"), funderUsdcBalance: mutation.faucetPreBalance ?? 20_000_000n };
    return undefined;
  };
  return {
    readLatestBlock: async () => ({ number: snapshot.number + 5n, hash: h(index ? "d" : "c"), timestamp: snapshot.timestamp + 60n }),
    readBlock: async number => {
      if (number === snapshot.number) return { ...snapshot, hash: mutation.reorgHash && snapshotReads++ > 0 ? mutation.reorgHash : snapshot.hash };
      if (number === faucetBlock.number) return faucetBlock;
      if (number === faucetBlock.number - 1n) return { number, hash: h("e"), timestamp: faucetBlock.timestamp - 12n };
      return historical.readBlock(number);
    },
    readTransaction: async hash => hash === faucetTransaction.hash ? { ...faucetTransaction, ...mutation.faucetTransaction } as any : historical.readTransaction(hash),
    readReceipt: async hash => hash === faucetTransaction.hash ? { ...faucetReceipt, ...mutation.faucetReceipt } as any : historical.readReceipt(hash),
    readTransactionCount: async (address, block) => address.toLowerCase() === faucet.toLowerCase() ? 1_059_381 : block === snapshot.number ? (mutation.snapshotNonce ?? 870) : block === "latest" ? (mutation.latestNonce ?? mutation.snapshotNonce ?? 870) : block === "pending" ? (mutation.pendingNonce ?? mutation.latestNonce ?? mutation.snapshotNonce ?? 870) : historical.readTransactionCount(address, block),
    readControlledState: async blockNumber => structuredClone(at(blockNumber) ?? await historical.readControlledState(blockNumber)),
    readFaucetTransferLog: async (hash: Hex) => hash === faucetTransaction.hash && !mutation.omitFaucetLog ? { ...faucetLog, ...mutation.faucetLog } : undefined,
  } as UsdcSuccessorEvidenceProvider & { readFaucetTransferLog(hash: Hex): Promise<typeof faucetLog | undefined> };
}

export async function freshProviders(source: UsdcRecycleContinuationSource, left: FreshProviderMutation = {}, right: FreshProviderMutation = {}) {
  return [await provider(0, source, left), await provider(1, source, right)] as const;
}

export async function createFreshSource() {
  return createUsdcRecycleContinuationSource();
}

export const freshPrimary = recycleFixture.primary;
