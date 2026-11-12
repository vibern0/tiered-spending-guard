import type {
	HistoricalPwaReadClient,
	PwaProvisioningQuoteClient,
	PwaProvisioningRecoveryClient,
} from "@tiered-spending-guard/security-core/pwa";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { batchedReadTransport } from "./batched-transport";

type PublicClient = ReturnType<typeof createPublicClient>;

const RPC_READ_METHODS = new Set([
	"getChainId",
	"getBlockNumber",
	"getBlock",
	"getTransactionCount",
	"estimateGas",
	"estimateMaxPriorityFeePerGas",
	"getCode",
	"getStorageAt",
	"call",
	"getTransaction",
	"getTransactionReceipt",
	"getBalance",
	"estimateFeesPerGas",
	"waitForTransactionReceipt",
]);

function rpcCauses(error: unknown): readonly Error[] {
	const seen = new Set<Error>();
	let current = error;
	while (current instanceof Error && seen.size < 6 && !seen.has(current)) {
		seen.add(current);
		current = current.cause;
	}
	return [...seen];
}

export async function sanitizeRpc<T>(
	label: string,
	method: string,
	operation: () => Promise<T>,
	retryReadNotFound = false,
): Promise<T> {
	let failure: unknown;
	try {
		return await operation();
	} catch (error) {
		failure = error;
	}
	const readOnly =
		RPC_READ_METHODS.has(method) || /^readContract:[A-Za-z][A-Za-z0-9_]*$/.test(method);
	for (let retry = 0; retryReadNotFound && readOnly; retry++) {
		const causes = rpcCauses(failure);
		const reverted = causes.some((cause) =>
			/^(ExecutionRevertedError|ContractFunctionRevertedError)$/.test(cause.name),
		);
		const missingHistoricalState =
			method === "getTransactionCount" &&
			causes.some(
				(cause) =>
					/^(InvalidInputRpcError|RpcRequestError)$/.test(cause.name) &&
					(cause as Error & { code?: unknown }).code === -32000 &&
					/historical state [0-9a-f]{64} is not available/i.test(cause.message),
			);
		const transientHttpFailure = causes.some(
			(cause) =>
				cause.name === "HttpRequestError" &&
				[408, 425, 429, 500, 502, 503, 504].includes(
					(cause as Error & { status?: number }).status ?? 0,
				),
		);
		const limit = missingHistoricalState
			? 3
			: transientHttpFailure
				? 4
				: causes.some((cause) => cause.name === "ResourceNotFoundRpcError")
					? 1
					: 0;
		if (reverted || retry >= limit) break;
		await new Promise<void>((resolve) =>
			setTimeout(resolve, transientHttpFailure ? 1_000 * 2 ** retry : 500),
		);
		try {
			return await operation();
		} catch (error) {
			failure = error;
		}
	}
	const category =
		rpcCauses(failure)
			.map((cause) => {
				const name = cause.name.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "Error";
				const code = (cause as Error & { code?: unknown }).code;
				return `${name}${typeof code === "number" && Number.isSafeInteger(code) ? `:${code}` : ""}`;
			})
			.join(" > ") || "UnknownError";
	throw new Error(`${label} Sepolia RPC request failed (${method}; ${category})`);
}

function recoveryTransaction(transaction: Awaited<ReturnType<PublicClient["getTransaction"]>>) {
	if (
		transaction.type !== "eip1559" ||
		transaction.chainId === undefined ||
		transaction.maxFeePerGas === undefined ||
		transaction.maxPriorityFeePerGas === undefined
	)
		throw new Error("non-EIP-1559 transaction");
	return {
		hash: transaction.hash,
		chainId: transaction.chainId,
		type: "eip1559" as const,
		from: transaction.from,
		to: transaction.to,
		nonce: transaction.nonce,
		value: transaction.value,
		input: transaction.input,
		gas: transaction.gas,
		maxFeePerGas: transaction.maxFeePerGas,
		maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
	};
}

export function createReadClient(
	url: string,
	label: string,
	options: Readonly<{ batch?: boolean; fetchFn?: typeof fetch; source?: string }> = {},
): Omit<
	HistoricalPwaReadClient & PwaProvisioningQuoteClient & PwaProvisioningRecoveryClient,
	"getBlock"
> &
	Readonly<{
		getBlock(input: { blockNumber: bigint }): Promise<{
			number: bigint;
			hash: Hex | null;
			timestamp: bigint;
			baseFeePerGas: bigint | null;
			gasLimit: bigint;
		}>;
	}> {
	const client = createPublicClient({
		chain: sepolia,
		transport: options.batch ? batchedReadTransport(url, options.fetchFn) : http(url),
	}) as PublicClient;
	const read = <T>(method: string, operation: () => Promise<T>) =>
		sanitizeRpc(label, method, operation, true);
	return Object.freeze({
		source: options.source ?? url,
		getChainId: () => read("getChainId", () => client.getChainId()),
		getBlockNumber: () => read("getBlockNumber", () => client.getBlockNumber()),
		getBlock: ({ blockNumber }: { blockNumber: bigint }) =>
			read("getBlock", async () => {
				const block = await client.getBlock({ blockNumber });
				return {
					number: block.number,
					hash: block.hash,
					timestamp: block.timestamp,
					baseFeePerGas: block.baseFeePerGas,
					gasLimit: block.gasLimit,
				};
			}),
		getBlockWithTransactions: ({ blockNumber }: { blockNumber: bigint }) =>
			read("getBlock", async () => {
				const block = await client.getBlock({ blockNumber, includeTransactions: true });
				return {
					number: block.number,
					hash: block.hash,
					transactions: block.transactions
						.filter((transaction) => transaction.type === "eip1559")
						.map(recoveryTransaction),
				};
			}),
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
				client.getTransactionCount({
					address,
					...(blockNumber === undefined
						? { blockTag: blockTag ?? "latest" }
						: { blockNumber }),
				}),
			),
		estimateGas: ({
			account,
			to,
			data,
			value,
			blockNumber,
		}: {
			account: Address;
			to?: Address;
			data: Hex;
			value: bigint;
			blockNumber: bigint;
		}) =>
			read("estimateGas", () =>
				client.estimateGas({ account, ...(to ? { to } : {}), data, value, blockNumber }),
			),
		getMaxPriorityFeePerGas: () =>
			read("estimateMaxPriorityFeePerGas", () => client.estimateMaxPriorityFeePerGas()),
		getBytecode: ({ address, blockNumber }: { address: Address; blockNumber?: bigint }) =>
			read("getCode", () =>
				client.getCode({ address, ...(blockNumber === undefined ? {} : { blockNumber }) }),
			),
		getStorageAt: (args: { address: Address; slot: Hex; blockNumber?: bigint }) =>
			read("getStorageAt", () => client.getStorageAt(args)),
		readContract: (args: {
			address: Address;
			abi: readonly unknown[];
			functionName: string;
			args?: readonly unknown[];
			blockNumber?: bigint;
		}) => read(`readContract:${args.functionName}`, () => client.readContract(args as never)),
		call: ({ data }: { data: Hex }) => read("call", () => client.call({ data })),
		getTransaction: ({ hash }: { hash: Hex }) =>
			read("getTransaction", async () => {
				try {
					return recoveryTransaction(await client.getTransaction({ hash }));
				} catch (error) {
					if (error instanceof Error && error.name === "TransactionNotFoundError")
						return null;
					throw error;
				}
			}),
		getTransactionReceipt: ({ hash }: { hash: Hex }) =>
			read("getTransactionReceipt", async () => {
				try {
					const receipt = await client.getTransactionReceipt({ hash });
					return {
						transactionHash: receipt.transactionHash,
						status: receipt.status,
						gasUsed: receipt.gasUsed,
						effectiveGasPrice: receipt.effectiveGasPrice,
						blockNumber: receipt.blockNumber,
						blockHash: receipt.blockHash,
					};
				} catch (error) {
					if (error instanceof Error && error.name === "TransactionReceiptNotFoundError")
						return null;
					throw error;
				}
			}),
	});
}
