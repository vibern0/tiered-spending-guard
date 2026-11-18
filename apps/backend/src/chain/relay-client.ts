import { createPublicClient, http, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { createReadClient, sanitizeRpc } from "./read-client";

/** Only this adapter adds broadcasting; observers receive separate read capabilities. */
export function createRelayClient(url: string) {
	const base = createReadClient(url, "relay");
	const client = createPublicClient({ chain: sepolia, transport: http(url) });
	/** Applies sanitized errors and bounded read retries to relay observations. */
	const read = <T>(method: string, operation: () => Promise<T>) =>
		sanitizeRpc("relay", method, operation, true);
	/** Projects receipts to the identity, status, and cost fields consumed by backend recovery. */
	const receipt = (r: Awaited<ReturnType<typeof client.getTransactionReceipt>>) => ({
		transactionHash: r.transactionHash,
		status: r.status,
		gasUsed: r.gasUsed,
		effectiveGasPrice: r.effectiveGasPrice,
		blockNumber: r.blockNumber,
		blockHash: r.blockHash,
	});
	return {
		...base,
		/** Broadcasts an already signed transaction and sanitizes failures without retrying the write. */
		sendRawTransaction: ({ serializedTransaction }: { serializedTransaction: Hex }) =>
			sanitizeRpc("relay", "sendRawTransaction", () =>
				client.sendRawTransaction({ serializedTransaction }),
			),
		/** Requires both EIP-1559 fee components before returning a relay fee estimate. */
		estimateFeesPerGas: () =>
			read("estimateFeesPerGas", async () => {
				const fees = await client.estimateFeesPerGas({ type: "eip1559" });
				if (fees.maxFeePerGas === undefined || fees.maxPriorityFeePerGas === undefined) {
					throw new Error("fees unavailable");
				}
				return {
					maxFeePerGas: fees.maxFeePerGas,
					maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
				};
			}),
		/** Reads a mined receipt and returns the backend recovery projection. */
		getTransactionReceipt: ({ hash }: { hash: Hex }) =>
			read("getTransactionReceipt", async () =>
				receipt(await client.getTransactionReceipt({ hash })),
			),
		/** Waits for the requested confirmation depth before returning receipt evidence. */
		waitForTransactionReceipt: ({
			hash,
			confirmations,
		}: {
			hash: Hex;
			confirmations: number;
		}) =>
			read("waitForTransactionReceipt", async () =>
				receipt(await client.waitForTransactionReceipt({ hash, confirmations })),
			),
	};
}
