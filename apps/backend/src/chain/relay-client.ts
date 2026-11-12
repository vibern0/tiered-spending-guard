import { createPublicClient, http, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { sanitizeRpc } from "./read-client";

export function createRelayClient(url: string) {
	const publicClient = createPublicClient({ chain: sepolia, transport: http(url) });
	const read = <T>(method: string, operation: () => Promise<T>) =>
		sanitizeRpc("relay", method, operation, true);
	return {
		getBytecode: ({ address, blockNumber }: { address: Address; blockNumber?: bigint }) =>
			read("getCode", () =>
				publicClient.getCode({
					address,
					...(blockNumber === undefined ? {} : { blockNumber }),
				}),
			),
		getTransactionCount: ({
			address,
			blockNumber,
			blockTag,
		}: {
			address: Address;
			blockNumber?: bigint;
			blockTag?: "latest" | "pending";
		}) =>
			read("getTransactionCount", () =>
				publicClient.getTransactionCount({
					address,
					...(blockNumber === undefined
						? { blockTag: blockTag ?? "latest" }
						: { blockNumber }),
				}),
			),
		readContract: (args: {
			address: Address;
			abi: readonly unknown[];
			functionName: string;
			args?: readonly unknown[];
			blockNumber?: bigint;
		}) =>
			read(`readContract:${args.functionName}`, () =>
				publicClient.readContract(args as never),
			),
		call: (args: { data: Hex }) => read("call", () => publicClient.call(args)),
		getStorageAt: (args: { address: Address; slot: Hex; blockNumber?: bigint }) =>
			read("getStorageAt", () => publicClient.getStorageAt(args)),
		getChainId: () => read("getChainId", () => publicClient.getChainId()),
		getBalance: ({ address }: { address: Address }) =>
			read("getBalance", () => publicClient.getBalance({ address })),
		sendRawTransaction: ({ serializedTransaction }: { serializedTransaction: Hex }) =>
			sanitizeRpc("relay", "sendRawTransaction", () =>
				publicClient.sendRawTransaction({ serializedTransaction }),
			),
		estimateGas: (args: { account: Address; to?: Address; data: Hex; value: bigint }) =>
			read("estimateGas", () => publicClient.estimateGas(args)),
		estimateFeesPerGas: async () =>
			read("estimateFeesPerGas", async () => {
				const fees = await publicClient.estimateFeesPerGas({ type: "eip1559" });
				if (fees.maxFeePerGas === undefined || fees.maxPriorityFeePerGas === undefined)
					throw new Error("fees unavailable");
				return {
					maxFeePerGas: fees.maxFeePerGas,
					maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
				};
			}),
		getBlockNumber: () => read("getBlockNumber", () => publicClient.getBlockNumber()),
		getBlock: ({ blockNumber }: { blockNumber: bigint }) =>
			read("getBlock", async () => {
				const block = await publicClient.getBlock({ blockNumber });
				return {
					number: block.number,
					hash: block.hash,
					timestamp: block.timestamp,
					baseFeePerGas: block.baseFeePerGas,
					gasLimit: block.gasLimit,
				};
			}),
		getTransactionReceipt: async ({ hash }: { hash: Hex }) =>
			read("getTransactionReceipt", async () => {
				const receipt = await publicClient.getTransactionReceipt({ hash });
				return {
					transactionHash: receipt.transactionHash,
					status: receipt.status,
					gasUsed: receipt.gasUsed,
					effectiveGasPrice: receipt.effectiveGasPrice,
					blockNumber: receipt.blockNumber,
					blockHash: receipt.blockHash,
				};
			}),
		waitForTransactionReceipt: async ({
			hash,
			confirmations,
		}: {
			hash: Hex;
			confirmations: number;
		}) =>
			read("waitForTransactionReceipt", async () => {
				const receipt = await publicClient.waitForTransactionReceipt({
					hash,
					confirmations,
				});
				return {
					transactionHash: receipt.transactionHash,
					status: receipt.status,
					gasUsed: receipt.gasUsed,
					effectiveGasPrice: receipt.effectiveGasPrice,
					blockNumber: receipt.blockNumber,
					blockHash: receipt.blockHash,
				};
			}),
	};
}
