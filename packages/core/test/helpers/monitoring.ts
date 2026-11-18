import type { Address, Hex } from "viem";

export function monitoringLog(
  address: Address,
  chainId: number,
  topics: readonly Hex[],
  data: Hex,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    address,
    chainId,
    blockNumber: 10n,
    blockHash: "0x" as Hex,
    transactionHash: "0x" as Hex,
    logIndex: 0,
    topics: [...topics] as `0x${string}`[],
    data,
    ...overrides,
  };
}
