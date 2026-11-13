import { createPublicClient, http, parseAbiItem } from "viem";
import { sepolia } from "viem/chains";
import { sanitizeRpc } from "../chain/read-client";
import type { HistoryReadClient } from "./types";

/** A separate read-only adapter; no relay account or write transport is accepted. */
export function createHistoryReadClient(url: string, source: string): HistoryReadClient {
	const client = createPublicClient({ chain: sepolia, transport: http(url) });
	const read = <T>(method: string, action: () => Promise<T>) =>
		sanitizeRpc(source, method, action);
	const transfer = parseAbiItem(
		"event Transfer(address indexed from,address indexed to,uint256 value)",
	);
	const normalize = (logs: Awaited<ReturnType<typeof client.getLogs>>) =>
		logs.map((log) => {
			if (
				log.blockNumber === null ||
				log.blockHash === null ||
				log.transactionHash === null ||
				log.logIndex === null
			)
				throw new Error("unmined history log");
			return {
				address: log.address,
				blockNumber: log.blockNumber,
				blockHash: log.blockHash,
				transactionHash: log.transactionHash,
				logIndex: log.logIndex,
				topics: log.topics,
				data: log.data,
				removed: log.removed,
			};
		});
	return Object.freeze({
		source,
		getChainId: () => read("getChainId", () => client.getChainId()),
		getBlockNumber: () => read("getBlockNumber", () => client.getBlockNumber()),
		getBlock: (input) =>
			read("getBlock", async () => {
				const block = await client.getBlock({ ...input, includeTransactions: true });
				return {
					number: block.number,
					hash: block.hash,
					parentHash: block.parentHash,
					timestamp: block.timestamp,
					transactions: block.transactions.map((t) => ({
						hash: t.hash,
						to: t.to,
						input: t.input,
					})),
				};
			}),
		getLogs: (input) =>
			read("getLogs", async () => {
				const range = { fromBlock: input.fromBlock, toBlock: input.toBlock };
				const groups = await Promise.all([
					client.getLogs({
						...range,
						address: input.token,
						event: transfer,
						args: { from: input.safe },
					}),
					client.getLogs({
						...range,
						address: input.token,
						event: transfer,
						args: { to: input.safe },
					}),
					client.getLogs({ ...range, address: [...input.vaults] }),
				]);
				const unique = new Map<string, ReturnType<typeof normalize>[number]>();
				for (const log of groups.flatMap(normalize)) {
					const key = `${log.blockNumber}:${log.logIndex}`;
					const prior = unique.get(key);
					if (
						prior &&
						(prior.transactionHash !== log.transactionHash ||
							prior.blockHash !== log.blockHash ||
							prior.address !== log.address ||
							prior.data !== log.data ||
							prior.topics.join() !== log.topics.join())
					)
						throw new Error("conflicting history log queries");
					unique.set(key, log);
				}
				return [...unique.values()];
			}),
		getTransactionReceipt: (input) =>
			read("getTransactionReceipt", async () => {
				const r = await client.getTransactionReceipt(input);
				return {
					transactionHash: r.transactionHash,
					blockNumber: r.blockNumber,
					blockHash: r.blockHash,
					status: r.status,
					logs: normalize(r.logs),
				};
			}),
		readContract: (input) =>
			read(`readContract:${input.functionName}`, () => client.readContract(input as never)),
	} satisfies HistoryReadClient);
}
