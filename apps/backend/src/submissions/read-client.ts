import { createPublicClient, parseAbiItem, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { createReadClient, sanitizeRpc } from "../chain/read-client";
import { batchedReadTransport } from "../chain/batched-transport";

const ADDED = parseAbiItem(
	"event TransactionAdded(uint256 indexed queueNonce,bytes32 indexed txHash,address to,uint256 value,bytes data,uint8 operation)",
);
/** These capabilities are private to the backend; observer adapters below expose reads only. */
export function createSubmissionReadClient(
	url: string,
	label: string,
	options: Readonly<{ fetchFn?: typeof fetch }> = {},
) {
	const base = createReadClient(url, label, { batch: true, fetchFn: options.fetchFn });
	const client = createPublicClient({
		chain: sepolia,
		transport: batchedReadTransport(url, options.fetchFn),
	});
	/** Route RPC operations through sanitized error handling without exposing provider URLs. */
	const read = <T>(method: string, operation: () => Promise<T>) =>
		sanitizeRpc(label, method, operation, true);
	return Object.freeze({
		...base,
		source: label.replaceAll(" ", "-"),
		/** Simulate a call through the fixed backend provider without signing or sending a transaction. */
		call: (args: {
			data: Hex;
			to?: Address;
			account?: Address;
			value?: bigint;
			blockNumber?: bigint;
		}) => read("call", () => client.call(args)),
		/** Read strictly decoded Delay queue events within the caller-supplied block range. */
		getLogs: (args: {
			address: Address;
			fromBlock: bigint;
			toBlock: bigint;
			args: { queueNonce: bigint };
		}) => read("getLogs", () => client.getLogs({ ...args, event: ADDED, strict: true })),
		/** Return normalized public receipt evidence, or null while the exact transaction remains unmined. */
		getTransactionReceipt: ({ hash: transactionHash }: { hash: Hex }) =>
			read("getTransactionReceipt", async () => {
				try {
					const r = await client.getTransactionReceipt({ hash: transactionHash });
					return {
						transactionHash: r.transactionHash,
						status: r.status,
						gasUsed: r.gasUsed,
						effectiveGasPrice: r.effectiveGasPrice,
						blockNumber: r.blockNumber,
						blockHash: r.blockHash,
						logs: r.logs.map((log) => ({
							address: log.address,
							blockNumber: log.blockNumber,
							blockHash: log.blockHash,
							transactionHash: log.transactionHash,
							logIndex: log.logIndex,
							topics: log.topics,
							data: log.data,
							removed: log.removed,
						})),
					};
				} catch (error) {
					if (
						error instanceof Error &&
						error.name === "TransactionReceiptNotFoundError"
					) {
						return null;
					}
					throw error;
				}
			}),
	});
}
