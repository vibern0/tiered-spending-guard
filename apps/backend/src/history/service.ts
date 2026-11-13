import { DatabaseSync } from "node:sqlite";
import {
	decodeEventLog,
	decodeFunctionData,
	encodeFunctionData,
	encodePacked,
	keccak256,
	parseAbi,
	type Address,
	type Hex,
} from "viem";
import * as coreNamespace from "@tiered-spending-guard/security-core/pwa";
import type {
	HistoryLog,
	HistoryPage,
	HistoryReadClient,
	HistoryRecord,
	HistoryVault,
} from "./types";
const core =
	(coreNamespace as typeof coreNamespace & { default?: typeof coreNamespace }).default ??
	coreNamespace;
const { decodePwaRecipientRepair } = core;

const ABI = parseAbi([
	"event Transfer(address indexed from,address indexed to,uint256 value)",
	"event TransferAuthorized(uint8 tier,address token,address recipient,uint256 amount,uint256 baseSpent,uint256 instantSpent,uint256 window)",
	"event TransactionAdded(uint256 indexed queueNonce,bytes32 indexed txHash,address to,uint256 value,bytes data,uint8 operation)",
	"event TxNonceSet(uint256 nonce)",
	"event ExecutionSuccess(bytes32 indexed txHash,uint256 payment)",
	"event ExecutionFailure(bytes32 indexed txHash,uint256 payment)",
	"event ExecutionFromModuleSuccess(address indexed module)",
	"function transfer(address,uint256) returns (bool)",
	"function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) returns (bool)",
	"function executeNextTx(address,uint256,bytes,uint8)",
	"function skipExpired()",
	"function setTxNonce(uint256)",
	"function txCooldown() view returns (uint256)",
	"function txExpiration() view returns (uint256)",
	"function txNonce() view returns (uint256)",
	"function queueNonce() view returns (uint256)",
]);
const same = (a: string | null, b: string) => a?.toLowerCase() === b.toLowerCase();
const json = (v: unknown): string =>
	JSON.stringify(v, (_, x) => (typeof x === "bigint" ? `${x}n` : x));
const parse = <T>(v: string): T =>
	JSON.parse(v, (_, x) =>
		typeof x === "string" && /^(0|[1-9][0-9]*)n$/.test(x) ? BigInt(x.slice(0, -1)) : x,
	) as T;
const integer = (n: bigint): number => {
	const v = Number(n);
	if (!Number.isSafeInteger(v) || v < 0) throw new Error("invalid history block/time");
	return v;
};
const identity = (id: string) => {
	if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new Error("invalid history account");
};
function decoded(log: HistoryLog) {
	try {
		return decodeEventLog({
			abi: ABI,
			data: log.data,
			topics: [...log.topics] as [Hex, ...Hex[]],
			strict: true,
		});
	} catch {
		return undefined;
	}
}
function call(input: Hex) {
	try {
		const d = decodeFunctionData({ abi: ABI, data: input });
		if (
			!same(
				encodeFunctionData({
					abi: ABI,
					functionName: d.functionName,
					args: d.args as never,
				}),
				input,
			)
		)
			return undefined;
		return d;
	} catch {
		return undefined;
	}
}
function fingerprint(to: Address, value: bigint, data: Hex, operation: number) {
	return keccak256(
		encodePacked(["address", "uint256", "bytes", "uint8"], [to, value, data, operation]),
	);
}
type CursorRow = {
	binding: string;
	block: number;
	hash: string;
	observed: number;
	timestamp: number;
	head: string;
	tail: string;
};
type Stored = { payload: string };
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const cacheFields = new Set([
	"id",
	"kind",
	"transactionHash",
	"blockNumber",
	"blockHash",
	"logIndex",
	"timestamp",
	"direction",
	"amount",
	"counterparty",
	"lane",
	"queueNonce",
	"queueFingerprint",
	"readyAt",
	"expiresAt",
	"status",
]);
function readCheckpoint(row: CursorRow | undefined): CursorRow | undefined {
	if (!row) return undefined;
	let binding: unknown;
	try {
		binding = parse(row.binding);
	} catch {
		throw new Error("invalid history cache checkpoint");
	}
	if (
		!Number.isSafeInteger(row.block) ||
		row.block < 0 ||
		!Number.isSafeInteger(row.observed) ||
		row.observed < 0 ||
		!Number.isSafeInteger(row.timestamp) ||
		row.timestamp < 0 ||
		!hashPattern.test(row.hash) ||
		typeof row.binding !== "string" ||
		row.binding.length > 2048 ||
		!/^(0|[1-9][0-9]{0,77})$/.test(row.head) ||
		!/^(0|[1-9][0-9]{0,77})$/.test(row.tail) ||
		BigInt(row.head) > BigInt(row.tail) ||
		BigInt(row.tail) >= 1n << 256n ||
		!Array.isArray(binding) ||
		binding.length !== 6 ||
		binding[0] !== 11155111 ||
		binding.slice(1, 5).some((v) => typeof v !== "string" || !addressPattern.test(v)) ||
		typeof binding[5] !== "bigint" ||
		binding[5] < 0n ||
		binding[5] > BigInt(row.block) ||
		json(binding) !== row.binding
	)
		throw new Error("invalid history cache checkpoint");
	return row;
}
function cached(payload: string): HistoryRecord {
	try {
		const r = parse<HistoryRecord>(payload);
		const positive = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
		const uint = (v: unknown) => typeof v === "bigint" && v >= 0n && v < 1n << 256n;
		if (
			!r ||
			typeof r !== "object" ||
			Object.keys(r).some((k) => !cacheFields.has(k)) ||
			!hashPattern.test(r.transactionHash) ||
			!hashPattern.test(r.blockHash) ||
			!addressPattern.test(r.counterparty) ||
			!uint(r.blockNumber) ||
			r.blockNumber > BigInt(Number.MAX_SAFE_INTEGER) ||
			!uint(r.amount) ||
			!Number.isSafeInteger(r.logIndex) ||
			r.logIndex < -1000 ||
			!positive(r.timestamp) ||
			r.id !== `${r.transactionHash.toLowerCase()}:${r.logIndex}` ||
			![
				"transfer",
				"recipient-addition",
				"cancel",
				"execute",
				"skip",
				"unsupported",
			].includes(r.kind) ||
			!["in", "out", "self"].includes(r.direction) ||
			(r.lane !== undefined && !["base", "step-up", "delayed", "blocked"].includes(r.lane)) ||
			(r.status !== undefined &&
				!["queued", "executed", "cancelled", "expired", "unresolved"].includes(r.status)) ||
			(r.queueNonce !== undefined && !uint(r.queueNonce)) ||
			(r.queueFingerprint !== undefined && !hashPattern.test(r.queueFingerprint)) ||
			(r.readyAt !== undefined && !positive(r.readyAt)) ||
			(r.expiresAt !== undefined && !positive(r.expiresAt))
		)
			throw new Error();
		return r;
	} catch {
		throw new Error("invalid history cache record");
	}
}

/** Rebuildable display cache. This connection never touches account or execution-authority tables. */
export class VaultHistory {
	private readonly db: DatabaseSync;
	private readonly clients: readonly [HistoryReadClient, HistoryReadClient];
	private readonly maxBlocks: number;
	private readonly now: () => number;
	private readonly busy = new Set<string>();
	constructor(options: {
		databasePath: string;
		clients: readonly [HistoryReadClient, HistoryReadClient];
		maxBlocks?: number;
		now?: () => number;
	}) {
		if (!options.clients[0].source || options.clients[0].source === options.clients[1].source)
			throw new Error("independent history readers required");
		this.clients = options.clients;
		this.maxBlocks = options.maxBlocks ?? 32;
		this.now = options.now ?? Date.now;
		if (!Number.isInteger(this.maxBlocks) || this.maxBlocks < 1 || this.maxBlocks > 200)
			throw new Error("invalid history scan bound");
		this.db = new DatabaseSync(options.databasePath);
		this.db
			.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;
      CREATE TABLE IF NOT EXISTS history_cursors (account TEXT PRIMARY KEY,binding TEXT NOT NULL,block INTEGER NOT NULL,hash TEXT NOT NULL,observed INTEGER NOT NULL,timestamp INTEGER NOT NULL,head TEXT NOT NULL,tail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history_records (account TEXT NOT NULL,id TEXT NOT NULL,block INTEGER NOT NULL,idx INTEGER NOT NULL,queue TEXT,proposal INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(account,id));
      CREATE INDEX IF NOT EXISTS history_page ON history_records(account,block DESC,idx DESC,id DESC);
      CREATE INDEX IF NOT EXISTS history_queue ON history_records(account,queue,proposal);`);
	}
	close(): void {
		this.db.close();
	}
	private async agree<T>(read: (client: HistoryReadClient) => Promise<T>): Promise<T> {
		const [a, b] = await Promise.all(this.clients.map(read));
		if (json(a) !== json(b)) throw new Error("history readers disagree");
		return a;
	}
	private async block(number: bigint) {
		const block = await this.agree((c) => c.getBlock({ blockNumber: number }));
		if (
			block.number !== number ||
			!block.hash ||
			!/^0x[0-9a-fA-F]{64}$/.test(block.hash) ||
			!/^0x[0-9a-fA-F]{64}$/.test(block.parentHash) ||
			block.timestamp < 0n ||
			!Array.isArray(block.transactions)
		)
			throw new Error("invalid history canonical block");
		const hashes = new Set<string>();
		for (const tx of block.transactions) {
			if (!/^0x[0-9a-fA-F]{64}$/.test(tx.hash) || hashes.has(tx.hash.toLowerCase()))
				throw new Error("duplicate or malformed history transaction identity");
			hashes.add(tx.hash.toLowerCase());
		}
		return block as typeof block & { hash: Hex };
	}
	async scan(accountId: string, vault: HistoryVault): Promise<void> {
		identity(accountId);
		if (this.busy.has(accountId)) return;
		this.busy.add(accountId);
		try {
			await this.scanRange(accountId, vault);
		} finally {
			this.busy.delete(accountId);
		}
	}
	private async scanRange(accountId: string, vault: HistoryVault): Promise<void> {
		if (!/^(0|[1-9][0-9]*)$/.test(vault.evidence.blockNumber))
			throw new Error("verified setup block required for history");
		const setup = BigInt(vault.evidence.blockNumber);
		const binding = json([
			vault.chainId,
			vault.safe.toLowerCase(),
			vault.usdc.toLowerCase(),
			vault.guard.toLowerCase(),
			vault.delay.toLowerCase(),
			setup,
		]);
		let cursor = readCheckpoint(
			this.db.prepare("SELECT * FROM history_cursors WHERE account=?").get(accountId) as
				CursorRow | undefined,
		);
		if (cursor && cursor.binding !== binding) throw new Error("history vault identity changed");
		if ((await this.agree((c) => c.getChainId())) !== vault.chainId)
			throw new Error("history chain mismatch");
		const heads = await Promise.all(this.clients.map((c) => c.getBlockNumber()));
		const confirmed = (heads[0]! < heads[1]! ? heads[0]! : heads[1]!) - 5n;
		if (cursor) {
			if (confirmed < BigInt(cursor.block)) throw new Error("history reader head regressed");
			const checkpoint = await this.block(BigInt(cursor.block));
			if (!same(checkpoint.hash, cursor.hash)) {
				// A deep reorg invalidates only this rebuildable account cache. Replay is still bounded.
				this.db.exec("BEGIN IMMEDIATE");
				try {
					this.db.prepare("DELETE FROM history_records WHERE account=?").run(accountId);
					this.db.prepare("DELETE FROM history_cursors WHERE account=?").run(accountId);
					this.db.exec("COMMIT");
				} catch (e) {
					this.db.exec("ROLLBACK");
					throw e;
				}
				cursor = undefined;
			}
		}
		const from = cursor ? BigInt(cursor.block) + 1n : setup;
		if (confirmed < from) return;
		const to =
			confirmed < from + BigInt(this.maxBlocks) - 1n
				? confirmed
				: from + BigInt(this.maxBlocks) - 1n;
		const addresses = [vault.usdc, vault.safe, vault.guard, vault.delay];
		const relevant = (log: HistoryLog): boolean => {
			if (same(log.address, vault.usdc)) {
				const event = decoded(log);
				return (
					event?.eventName === "Transfer" &&
					(same(event.args.from, vault.safe) || same(event.args.to, vault.safe))
				);
			}
			return addresses.slice(1).some((a) => same(a, log.address));
		};
		const logs = await this.agree(async (c) =>
			(
				await c.getLogs({
					safe: vault.safe,
					token: vault.usdc,
					vaults: addresses.slice(1),
					fromBlock: from,
					toBlock: to,
				})
			)
				.filter(relevant)
				.slice()
				.sort((a, b) =>
					a.blockNumber === b.blockNumber
						? a.logIndex - b.logIndex
						: a.blockNumber < b.blockNumber
							? -1
							: 1,
				),
		);
		if (logs.length > 10_000) throw new Error("history log range too large");
		const keys = new Set<string>();
		for (const log of logs) {
			const key = `${log.blockNumber}:${log.logIndex}`;
			if (
				log.removed ||
				log.blockNumber < from ||
				log.blockNumber > to ||
				!Number.isSafeInteger(log.logIndex) ||
				log.logIndex < 0 ||
				keys.has(key) ||
				!addresses.some((a) => same(a, log.address))
			)
				throw new Error("invalid history log identity");
			keys.add(key);
		}
		const changes = new Map<string, HistoryRecord>();
		let head = BigInt(cursor?.head ?? "0"),
			tail = BigInt(cursor?.tail ?? "0");
		const put = (record: HistoryRecord) => changes.set(record.id, record);
		const queued = (nonce: bigint): HistoryRecord | undefined => {
			for (const r of changes.values())
				if (r.queueNonce === nonce && r.readyAt !== undefined) return r;
			const row = this.db
				.prepare(
					"SELECT payload FROM history_records WHERE account=? AND queue=? AND proposal=1",
				)
				.get(accountId, String(nonce)) as Stored | undefined;
			return row ? cached(row.payload) : undefined;
		};
		const advance = (
			nonce: bigint,
			status: "executed" | "cancelled" | "expired" | "unresolved",
		) => {
			if (nonce < head || nonce > tail || nonce - head > 1000n)
				throw new Error("invalid history queue transition");
			while (head < nonce) {
				const r = queued(head);
				if (!r) throw new Error("history queue archive missing");
				put({ ...r, status });
				head++;
			}
		};
		let finalBlock: Awaited<ReturnType<VaultHistory["block"]>> | undefined;
		let parentHash = cursor?.hash;
		const rangeTransactions = new Set<string>();
		for (let number = from; number <= to; number++) {
			const headBeforeBlock = head;
			const b = await this.block(number);
			if (parentHash && !same(b.parentHash, parentHash))
				throw new Error("history range parent mismatch");
			parentHash = b.hash;
			finalBlock = b;
			const blockLogs = logs.filter((l) => l.blockNumber === number);
			const blockTransactions = new Set(b.transactions.map((t) => t.hash.toLowerCase()));
			for (const hash of blockTransactions) {
				if (rangeTransactions.has(hash))
					throw new Error("history transaction repeated across blocks");
				rangeTransactions.add(hash);
			}
			for (const l of blockLogs)
				if (
					!same(l.blockHash, b.hash) ||
					!blockTransactions.has(l.transactionHash.toLowerCase())
				)
					throw new Error("history log block/transaction membership mismatch");
			const timing = async (name: string) => {
				const v = await this.agree((c) =>
					c.readContract({
						address: vault.delay,
						abi: ABI,
						functionName: name,
						blockNumber: number,
					}),
				);
				if (typeof v !== "bigint" || v < 0n) throw new Error("invalid history queue state");
				return v;
			};
			const hasProposal = blockLogs.some(
				(log) =>
					same(log.address, vault.delay) &&
					decoded(log)?.eventName === "TransactionAdded",
			);
			const cooldown = hasProposal ? await timing("txCooldown") : 0n,
				expiration = hasProposal ? await timing("txExpiration") : 0n;
			const base = (l: Pick<HistoryLog, "transactionHash" | "logIndex">): HistoryRecord => ({
				id: `${l.transactionHash.toLowerCase()}:${l.logIndex}`,
				kind: "unsupported",
				transactionHash: l.transactionHash,
				blockNumber: number,
				blockHash: b.hash,
				logIndex: l.logIndex,
				timestamp: integer(b.timestamp),
				direction: "self",
				amount: 0n,
				counterparty: vault.safe,
			});
			// Replay transaction order. Eventless public skips are visible only as direct Delay calls.
			const txs = b.transactions.filter(
				(t) =>
					same(t.to, vault.safe) ||
					same(t.to, vault.delay) ||
					blockLogs.some((l) => same(l.transactionHash, t.hash)),
			);
			const txHashes = [
				...new Set([...txs.map((t) => t.hash), ...blockLogs.map((l) => l.transactionHash)]),
			];
			for (const txHash of txHashes) {
				const related = blockLogs.filter((l) => same(l.transactionHash, txHash));
				const transaction = txs.find((t) => same(t.hash, txHash));
				let lifecycle =
					transaction && same(transaction.to, vault.delay)
						? call(transaction.input)
						: undefined;
				if (transaction && same(transaction.to, vault.safe)) {
					const outer = call(transaction.input);
					const success = related.some(
						(l) =>
							same(l.address, vault.safe) &&
							decoded(l)?.eventName === "ExecutionSuccess",
					);
					if (
						success &&
						outer?.functionName === "execTransaction" &&
						same(outer.args[0], vault.delay) &&
						outer.args[1] === 0n &&
						outer.args[3] === 0
					)
						lifecycle = call(outer.args[2]);
				}
				const isLifecycle =
					lifecycle &&
					["skipExpired", "executeNextTx", "setTxNonce"].includes(lifecycle.functionName);
				const receipt =
					related.length || isLifecycle
						? await this.agree((c) => c.getTransactionReceipt({ hash: txHash }))
						: undefined;
				if (related.length || isLifecycle) {
					if (
						!receipt ||
						!same(receipt.transactionHash, txHash) ||
						receipt.blockNumber !== number ||
						!same(receipt.blockHash, b.hash)
					)
						throw new Error("history receipt block/transaction mismatch");
					const receiptLogs = receipt.logs
						.filter(relevant)
						.slice()
						.sort((a, b) => a.logIndex - b.logIndex);
					if (
						receiptLogs.some(
							(l) =>
								l.removed ||
								!same(l.transactionHash, txHash) ||
								l.blockNumber !== number ||
								!same(l.blockHash, b.hash),
						) ||
						json(receiptLogs) !== json(related)
					)
						throw new Error("history receipt log membership mismatch");
					if (related.length && receipt.status !== "success")
						throw new Error("reverted history receipt contains logs");
				}
				let directExecuted = false;
				if (
					lifecycle &&
					["skipExpired", "executeNextTx", "setTxNonce"].includes(lifecycle.functionName)
				) {
					if (receipt?.status === "success") {
						const item = queued(head);
						if (lifecycle.functionName === "skipExpired") {
							let skipped = 0;
							while (head < tail) {
								const q = queued(head);
								if (!q) throw new Error("history queue archive missing");
								if (
									q.expiresAt === undefined ||
									integer(b.timestamp) <= q.expiresAt
								)
									break;
								put({
									...base({ transactionHash: txHash, logIndex: -1 - skipped }),
									kind: "skip",
									queueNonce: head,
									queueFingerprint: q.queueFingerprint,
									status: "expired",
									counterparty: q.counterparty,
								});
								advance(head + 1n, "expired");
								if (++skipped > 1000)
									throw new Error("history skip bound exceeded");
							}
						} else if (lifecycle.functionName === "executeNextTx") {
							if (
								!item ||
								!same(
									fingerprint(
										lifecycle.args[0],
										lifecycle.args[1],
										lifecycle.args[2],
										lifecycle.args[3],
									),
									item.queueFingerprint!,
								)
							)
								throw new Error("history execution queue mismatch");
							put({
								...base({ transactionHash: txHash, logIndex: -1 }),
								kind: "execute",
								queueNonce: head,
								queueFingerprint: item.queueFingerprint,
								status: "executed",
								counterparty: item.counterparty,
								lane: "delayed",
							});
							advance(head + 1n, "executed");
							directExecuted = true;
						} else {
							const event = related.find(
								(l) =>
									same(l.address, vault.delay) &&
									decoded(l)?.eventName === "TxNonceSet",
							);
							if (
								!event ||
								(decoded(event)!.args as { nonce: bigint }).nonce !==
									lifecycle.args[0]
							)
								throw new Error("history cancellation event mismatch");
							put({
								...base(event),
								kind: "cancel",
								queueNonce: head,
								queueFingerprint: item?.queueFingerprint,
								status: "cancelled",
								counterparty: item?.counterparty ?? vault.safe,
							});
							advance(lifecycle.args[0], "cancelled");
						}
					}
				}
				let previousModuleIndex = -1;
				for (const log of related) {
					const event = decoded(log);
					if (same(log.address, vault.usdc)) {
						if (event?.eventName !== "Transfer") continue;
						const { from: sender, to: recipient, value } = event.args;
						if (!same(sender, vault.safe) && !same(recipient, vault.safe)) continue;
						const auth = related
							.map((l) => (same(l.address, vault.guard) ? decoded(l) : undefined))
							.find(
								(e) =>
									e?.eventName === "TransferAuthorized" &&
									same(e.args.token, vault.usdc) &&
									same(e.args.recipient, recipient) &&
									e.args.amount === value,
							);
						const tier =
							auth?.eventName === "TransferAuthorized" ? auth.args.tier : undefined;
						put({
							...base(log),
							kind: "transfer",
							direction: same(sender, vault.safe)
								? same(recipient, vault.safe)
									? "self"
									: "out"
								: "in",
							amount: value,
							counterparty: same(sender, vault.safe) ? recipient : sender,
							...(tier === 0
								? { lane: "base" as const }
								: tier === 1
									? { lane: "step-up" as const }
									: lifecycle?.functionName === "executeNextTx"
										? { lane: "delayed" as const, status: "executed" as const }
										: {}),
						});
					} else if (
						same(log.address, vault.delay) &&
						event?.eventName === "TransactionAdded"
					) {
						const q = event.args;
						if (
							q.queueNonce !== tail ||
							!same(fingerprint(q.to, q.value, q.data, q.operation), q.txHash)
						)
							throw new Error("history queue fingerprint/nonce mismatch");
						let kind: HistoryRecord["kind"] = "unsupported",
							amount = 0n,
							counterparty = vault.safe;
						const transfer = call(q.data);
						if (
							same(q.to, vault.usdc) &&
							q.value === 0n &&
							q.operation === 0 &&
							transfer?.functionName === "transfer"
						) {
							kind = "transfer";
							counterparty = transfer.args[0];
							amount = transfer.args[1];
						} else if (same(q.to, vault.guard) && q.value === 0n && q.operation === 0) {
							try {
								counterparty = decodePwaRecipientRepair(q.data).recipient;
								kind = "recipient-addition";
							} catch {
								/* Unknown maintenance stays unsupported. */
							}
						}
						put({
							...base(log),
							kind,
							amount,
							counterparty,
							direction: "out",
							lane: "delayed",
							queueNonce: q.queueNonce,
							queueFingerprint: q.txHash,
							readyAt: integer(b.timestamp + cooldown),
							...(expiration === 0n
								? {}
								: { expiresAt: integer(b.timestamp + cooldown + expiration) }),
							status: "queued",
						});
						tail++;
					} else if (
						same(log.address, vault.guard) &&
						event?.eventName === "TransferAuthorized"
					) {
						if (
							!related.some(
								(l) =>
									same(l.address, vault.usdc) &&
									decoded(l)?.eventName === "Transfer",
							)
						)
							put(base(log));
					} else if (
						same(log.address, vault.safe) &&
						event?.eventName === "ExecutionFromModuleSuccess" &&
						same(event.args.module, vault.delay)
					) {
						if (directExecuted) continue;
						// Delay has no execution event. Its exact Safe module-success log proves a
						// permissionless execution even when an outside contract wraps the call.
						while (head < tail) {
							const old = queued(head);
							if (
								!old ||
								old.expiresAt === undefined ||
								integer(b.timestamp) <= old.expiresAt
							)
								break;
							advance(head + 1n, "expired");
						}
						const item = queued(head);
						const transfer =
							item?.kind === "transfer"
								? related
										.slice()
										.reverse()
										.find((l) => {
											const e = decoded(l);
											return (
												l.logIndex > previousModuleIndex &&
												l.logIndex < log.logIndex &&
												same(l.address, vault.usdc) &&
												e?.eventName === "Transfer" &&
												same(e.args.from, vault.safe) &&
												same(e.args.to, item.counterparty) &&
												e.args.value === item.amount
											);
										})
								: undefined;
						const supported =
							item &&
							item.readyAt !== undefined &&
							integer(b.timestamp) >= item.readyAt &&
							(item.kind === "recipient-addition" || transfer);
						put({
							...base(log),
							kind: supported ? "execute" : "unsupported",
							queueNonce: head,
							queueFingerprint: item?.queueFingerprint,
							status: supported ? "executed" : "unresolved",
							counterparty: item?.counterparty ?? vault.safe,
							lane: supported ? "delayed" : "blocked",
						});
						if (item) advance(head + 1n, supported ? "executed" : "unresolved");
						if (supported && transfer) {
							const id = base(transfer).id;
							const r = changes.get(id);
							if (r) put({ ...r, lane: "delayed", status: "executed" });
						}
						previousModuleIndex = log.logIndex;
					} else if (
						same(log.address, vault.delay) &&
						event?.eventName === "TxNonceSet"
					) {
						if (!changes.has(base(log).id)) {
							const item = queued(head);
							put({
								...base(log),
								kind: "cancel",
								queueNonce: head,
								queueFingerprint: item?.queueFingerprint,
								status: "cancelled",
								counterparty: item?.counterparty ?? vault.safe,
							});
							advance(event.args.nonce, "cancelled");
						}
					} else if (!event) {
						put(base(log));
					}
				}
			}
			if (tail > head || head !== headBeforeBlock) {
				const canonical = await timing("txNonce");
				if (canonical < head || canonical > tail || canonical - head > 1000n)
					throw new Error("history queue replay/state mismatch");
				while (head < canonical) {
					const item = queued(head);
					if (!item) throw new Error("history queue archive missing");
					// A head observation cannot supply a transaction identity. Retire expired
					// entries or expose an unresolved outcome on their original proposal only.
					advance(
						head + 1n,
						item.expiresAt !== undefined && integer(b.timestamp) > item.expiresAt
							? "expired"
							: "unresolved",
					);
				}
			}
		}
		if (!finalBlock) return;
		for (const [name, expected] of [
			["txNonce", head],
			["queueNonce", tail],
		] as const) {
			if (
				(await this.agree((c) =>
					c.readContract({
						address: vault.delay,
						abi: ABI,
						functionName: name,
						blockNumber: to,
					}),
				)) !== expected
			)
				throw new Error("history queue replay/state mismatch");
		}
		// Re-read both range anchors after RPC work before committing a confirmed cursor.
		if (!same((await this.block(to)).hash, finalBlock.hash))
			throw new Error("history range changed during scan");
		if (cursor && !same((await this.block(BigInt(cursor.block))).hash, cursor.hash))
			throw new Error("history checkpoint changed during scan");
		this.db.exec("BEGIN IMMEDIATE");
		try {
			if (!cursor)
				this.db.prepare("DELETE FROM history_records WHERE account=?").run(accountId);
			const write = this.db.prepare(
				"INSERT OR REPLACE INTO history_records(account,id,block,idx,queue,proposal,payload) VALUES(?,?,?,?,?,?,?)",
			);
			for (const r of changes.values())
				write.run(
					accountId,
					r.id,
					integer(r.blockNumber),
					r.logIndex,
					r.queueNonce === undefined ? null : String(r.queueNonce),
					r.readyAt === undefined ? 0 : 1,
					json(r),
				);
			this.db
				.prepare(
					"INSERT OR REPLACE INTO history_cursors(account,binding,block,hash,observed,timestamp,head,tail) VALUES(?,?,?,?,?,?,?,?)",
				)
				.run(
					accountId,
					binding,
					integer(to),
					finalBlock.hash,
					Math.floor(this.now() / 1000),
					integer(finalBlock.timestamp),
					String(head),
					String(tail),
				);
			this.db.exec("COMMIT");
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw e;
		}
	}
	page(accountId: string, input: { cursor?: string; limit?: number } = {}): HistoryPage {
		identity(accountId);
		const limit = input.limit ?? 25;
		if (!Number.isInteger(limit) || limit < 1 || limit > 100)
			throw new Error("invalid history page limit");
		const checkpoint = readCheckpoint(
			this.db.prepare("SELECT * FROM history_cursors WHERE account=?").get(accountId) as
				CursorRow | undefined,
		);
		if (!checkpoint) {
			if (input.cursor !== undefined) throw new Error("invalid history cursor");
			return { items: [], observedAt: 0 };
		}
		let before: { block: number; idx: number; id: string } | undefined;
		if (input.cursor !== undefined) {
			if (input.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(input.cursor))
				throw new Error("invalid history cursor");
			try {
				const c = JSON.parse(Buffer.from(input.cursor, "base64url").toString()) as {
					account: string;
					binding: string;
					block: number;
					idx: number;
					id: string;
					hash: Hex;
				};
				if (
					c.account !== accountId ||
					c.binding !== checkpoint.binding ||
					!Number.isSafeInteger(c.block) ||
					c.block < 0 ||
					!Number.isSafeInteger(c.idx) ||
					typeof c.id !== "string" ||
					c.id.length > 128 ||
					typeof c.hash !== "string"
				)
					throw new Error();
				const retained = this.db
					.prepare(
						"SELECT payload FROM history_records WHERE account=? AND id=? AND block=? AND idx=?",
					)
					.get(accountId, c.id, c.block, c.idx) as Stored | undefined;
				if (!retained || !same(cached(retained.payload).blockHash, c.hash))
					throw new Error();
				before = c;
			} catch {
				throw new Error("invalid history cursor");
			}
		}
		const rows = (
			before
				? this.db
						.prepare(
							"SELECT id,block,idx,payload FROM history_records WHERE account=? AND (block<? OR (block=? AND idx<?) OR (block=? AND idx=? AND id<?)) ORDER BY block DESC,idx DESC,id DESC LIMIT ?",
						)
						.all(
							accountId,
							before.block,
							before.block,
							before.idx,
							before.block,
							before.idx,
							before.id,
							limit + 1,
						)
				: this.db
						.prepare(
							"SELECT id,block,idx,payload FROM history_records WHERE account=? ORDER BY block DESC,idx DESC,id DESC LIMIT ?",
						)
						.all(accountId, limit + 1)
		) as (Stored & { id: string; block: number; idx: number })[];
		const items = rows
			.slice(0, limit)
			.map((row) => {
				const r = cached(row.payload);
				if (
					r.id !== row.id ||
					r.blockNumber !== BigInt(row.block) ||
					r.logIndex !== row.idx ||
					row.block > checkpoint.block
				)
					throw new Error("invalid history cache ordering");
				return r;
			})
			.map((r) =>
				r.status === "queued" &&
				r.expiresAt !== undefined &&
				Math.floor(this.now() / 1000) > r.expiresAt
					? { ...r, status: "expired" as const }
					: r,
			);
		const last = items.at(-1);
		return {
			items,
			observedAt: checkpoint.observed,
			indexedThrough: BigInt(checkpoint.block),
			...(rows.length > limit && last
				? {
						nextCursor: Buffer.from(
							JSON.stringify({
								account: accountId,
								binding: checkpoint.binding,
								block: integer(last.blockNumber),
								idx: last.logIndex,
								id: last.id,
								hash: last.blockHash,
							}),
						).toString("base64url"),
					}
				: {}),
		};
	}
}
