import type { Address, Hex } from "viem";

type BlockRead = Readonly<{ address: Address; blockNumber?: bigint }>;
export type PinnedReadClient = Readonly<{
  getBytecode(args: BlockRead): Promise<Hex | undefined>;
  getStorageAt(args: BlockRead & Readonly<{ slot: Hex }>): Promise<Hex | undefined>;
  readContract(args: BlockRead & Readonly<{ abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }>): Promise<unknown>;
  getTransactionCount(args: BlockRead & Readonly<{ blockTag?: "latest" | "pending" }>): Promise<number | bigint>;
}>;

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint") return { bigint: item.toString() };
    if (item && typeof item === "object" && !Array.isArray(item)) return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
    return item;
  });
}

/** One provider, one collection, explicit block only. Never retain this scope across verification boundaries. */
export function createPinnedReadScope<T extends PinnedReadClient>(client: T, blockNumber: bigint): T {
  const pending = new Map<string, Promise<unknown>>();
  const read = <R>(method: string, args: BlockRead, operation: () => Promise<R>): Promise<R> => {
    if (args.blockNumber !== blockNumber || blockNumber < 0n) return operation();
    const key = `${method}:${canonical(args)}`;
    const previous = pending.get(key);
    if (previous) return previous as Promise<R>;
    const result = Promise.resolve().then(operation);
    pending.set(key, result);
    void result.catch(() => { if (pending.get(key) === result) pending.delete(key); });
    return result;
  };
  return Object.freeze({
    ...client,
    getBytecode: (args: Parameters<T["getBytecode"]>[0]) => read("getBytecode", args, () => client.getBytecode(args)),
    getStorageAt: (args: Parameters<T["getStorageAt"]>[0]) => read("getStorageAt", args, () => client.getStorageAt(args)),
    getTransactionCount: (args: Parameters<T["getTransactionCount"]>[0]) => read("getTransactionCount", args, () => client.getTransactionCount(args)),
    readContract: (args: Parameters<T["readContract"]>[0]) => {
      // Other functions in a caller's ABI do not change this call's decoding. Keep
      // this function's complete ABI (including output names/types) in the key.
      const abi = args.abi.filter(item => item && typeof item === "object" && "type" in item && item.type === "function" && "name" in item && item.name === args.functionName);
      return read("readContract", { ...args, abi } as typeof args, () => client.readContract(args));
    },
  }) as T;
}
