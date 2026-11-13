import type { Address, Hex } from "viem";

/** Display projection only; this is never a verified execution capability. */
export type HistoryVault = Readonly<{
	chainId: 11155111;
	safe: Address;
	guard: Address;
	delay: Address;
	usdc: Address;
	evidence: Readonly<{ blockNumber: string }>;
}>;

export type HistoryRecord = Readonly<{
	id: string;
	kind: "transfer" | "recipient-addition" | "cancel" | "execute" | "skip" | "unsupported";
	transactionHash: Hex;
	blockNumber: bigint;
	blockHash: Hex;
	logIndex: number;
	timestamp: number;
	direction: "in" | "out" | "self";
	amount: bigint;
	counterparty: Address;
	lane?: "base" | "step-up" | "delayed" | "blocked";
	queueNonce?: bigint;
	queueFingerprint?: Hex;
	readyAt?: number;
	expiresAt?: number;
	status?: "queued" | "executed" | "cancelled" | "expired" | "unresolved";
}>;

export type HistoryPage = Readonly<{
	items: readonly HistoryRecord[];
	nextCursor?: string;
	observedAt: number;
	indexedThrough?: bigint;
}>;

export type HistoryLog = Readonly<{
	address: Address;
	blockNumber: bigint;
	blockHash: Hex;
	transactionHash: Hex;
	logIndex: number;
	topics: readonly Hex[];
	data: Hex;
	removed?: boolean;
}>;

/** Read-only capabilities: no signatures, receipts authority or broadcasting. */
export type HistoryReadClient = Readonly<{
	source: string;
	getChainId(): Promise<number>;
	getBlockNumber(): Promise<bigint>;
	getBlock(input: { blockNumber: bigint }): Promise<{
		number: bigint;
		hash: Hex | null;
		parentHash: Hex;
		timestamp: bigint;
		transactions: readonly { hash: Hex; to: Address | null; input: Hex }[];
	}>;
	getLogs(input: {
		safe: Address;
		token: Address;
		vaults: readonly Address[];
		fromBlock: bigint;
		toBlock: bigint;
	}): Promise<readonly HistoryLog[]>;
	getTransactionReceipt(input: { hash: Hex }): Promise<{
		transactionHash: Hex;
		blockNumber: bigint;
		blockHash: Hex;
		status: "success" | "reverted";
		logs: readonly HistoryLog[];
	} | null>;
	readContract(input: {
		address: Address;
		abi: readonly unknown[];
		functionName: string;
		blockNumber: bigint;
	}): Promise<unknown>;
}>;
