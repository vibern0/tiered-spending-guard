import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
	encodeAbiParameters,
	encodeEventTopics,
	encodeFunctionData,
	keccak256,
	encodePacked,
	parseAbi,
	type Address,
	type Hex,
} from "viem";
import { VaultHistory } from "../src/history/service";
import type { HistoryLog, HistoryReadClient } from "../src/history/types";
import type { BackendVaultRecord } from "../src/vaults/types";

const safe = `0x${"11".repeat(20)}` as Address,
	usdc = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Address,
	guard = `0x${"33".repeat(20)}` as Address,
	delay = `0x${"44".repeat(20)}` as Address,
	recipient = `0x${"55".repeat(20)}` as Address;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const tokenAbi = parseAbi([
	"event Transfer(address indexed from,address indexed to,uint256 value)",
	"function transfer(address,uint256) returns (bool)",
]);
const delayAbi = parseAbi([
	"event TransactionAdded(uint256 indexed queueNonce,bytes32 indexed txHash,address to,uint256 value,bytes data,uint8 operation)",
	"event TxNonceSet(uint256 nonce)",
	"function skipExpired()",
	"function executeNextTx(address,uint256,bytes,uint8)",
	"function setTxNonce(uint256)",
]);
const safeAbi = parseAbi([
	"function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) returns (bool)",
	"event ExecutionSuccess(bytes32 indexed txHash,uint256 payment)",
	"event ExecutionFromModuleSuccess(address indexed module)",
	"event TransferAuthorized(uint8 tier,address token,address recipient,uint256 amount,uint256 baseSpent,uint256 instantSpent,uint256 window)",
]);
const vault = {
	chainId: 11155111,
	safe,
	usdc,
	guard,
	delay,
	evidence: { blockNumber: "10" },
} as BackendVaultRecord;
const roots: string[] = [],
	services: VaultHistory[] = [];
afterEach(() => {
	services.splice(0).forEach((s) => s.close());
	roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true }));
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "vault-history-"));
	roots.push(root);
	const blocks = new Map<
		bigint,
		{
			hash: Hex;
			parentHash: Hex;
			timestamp: bigint;
			transactions: { hash: Hex; to: Address | null; input: Hex }[];
		}
	>();
	for (let n = 9; n < 40; n++)
		blocks.set(BigInt(n), {
			hash: hash(n),
			parentHash: hash(n - 1),
			timestamp: BigInt(1000 + n),
			transactions: [],
		});
	let latest = 16n,
		head = 0n,
		tail = 0n,
		now = 1500_000;
	const logs: HistoryLog[] = [],
		calls: { fromBlock: bigint; toBlock: bigint }[] = [];
	const nonces = new Map<bigint, { head: bigint; tail: bigint }>();
	const transactions = (n: bigint) => {
		const txs = [...blocks.get(n)!.transactions];
		for (const log of logs.filter((l) => l.blockNumber === n))
			if (!txs.some((t) => t.hash === log.transactionHash))
				txs.push({ hash: log.transactionHash, to: log.address, input: "0x" });
		return txs;
	};
	const client = (source: string): HistoryReadClient => ({
		source,
		getChainId: async () => 11155111,
		getBlockNumber: async () => latest,
		getBlock: async ({ blockNumber }) => ({
			number: blockNumber,
			...blocks.get(blockNumber)!,
			transactions: transactions(blockNumber),
		}),
		getLogs: async (input) => {
			calls.push(input);
			return logs.filter(
				(l) => l.blockNumber >= input.fromBlock && l.blockNumber <= input.toBlock,
			);
		},
		getTransactionReceipt: async ({ hash: h }) => {
			const pair = [...blocks].find(([n]) => transactions(n).some((t) => t.hash === h));
			return pair
				? {
						transactionHash: h,
						blockNumber: pair[0],
						blockHash: pair[1].hash,
						status: "success",
						logs: logs.filter((l) => l.transactionHash === h),
					}
				: null;
		},
		readContract: async ({ functionName, blockNumber }) =>
			functionName === "txCooldown"
				? 120n
				: functionName === "txExpiration"
					? 600n
					: functionName === "txNonce"
						? (nonces.get(blockNumber)?.head ?? head)
						: (nonces.get(blockNumber)?.tail ?? tail),
	});
	const first = client("one"),
		second = client("two");
	const path = join(root, "accounts.sqlite");
	const open = (overrides: Partial<HistoryReadClient> = {}, maxBlocks = 32) => {
		const s = new VaultHistory({
			databasePath: path,
			clients: [first, { ...second, ...overrides }],
			maxBlocks,
			now: () => now,
		});
		services.push(s);
		return s;
	};
	const transfer = (n: number, from = recipient, to = safe, value = 5n) => {
		const tx = hash(100 + n);
		const log = {
			address: usdc,
			blockNumber: BigInt(n),
			blockHash: blocks.get(BigInt(n))!.hash,
			transactionHash: tx,
			logIndex: 0,
			topics: encodeEventTopics({
				abi: tokenAbi,
				eventName: "Transfer",
				args: { from, to },
			}) as Hex[],
			data: encodeAbiParameters([{ type: "uint256" }], [value]),
		};
		logs.push(log);
		return log;
	};
	const queue = (
		n = 10,
		nonce = 0n,
		data = encodeFunctionData({
			abi: tokenAbi,
			functionName: "transfer",
			args: [recipient, 9n],
		}),
		to = usdc,
	) => {
		const fp = keccak256(
			encodePacked(["address", "uint256", "bytes", "uint8"], [to, 0n, data, 0]),
		);
		const log: HistoryLog = {
			address: delay,
			blockNumber: BigInt(n),
			blockHash: hash(n),
			transactionHash: hash(200 + n),
			logIndex: 0,
			topics: encodeEventTopics({
				abi: delayAbi,
				eventName: "TransactionAdded",
				args: { queueNonce: nonce, txHash: fp },
			}) as Hex[],
			data: encodeAbiParameters(
				[{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "uint8" }],
				[to, 0n, data, 0],
			),
		};
		logs.push(log);
		return { fp, data, log };
	};
	return {
		open,
		transfer,
		logs,
		blocks,
		calls,
		nonces,
		first,
		second,
		queue,
		path,
		setNow: (n: number) => {
			now = n;
		},
		setLatest: (n: bigint) => {
			latest = n;
		},
		setNonce: (h: bigint, t: bigint) => {
			head = h;
			tail = t;
		},
	};
}
describe("confirmed account vault history", () => {
	it("does not reuse an earlier withdrawal as evidence for another nested execution", async () => {
		const f = fixture(),
			s = f.open();
		f.queue(10, 0n);
		f.queue(11, 1n);
		f.setNonce(0n, 2n);
		await s.scan("alice", vault);
		f.blocks.get(12n)!.timestamp = 1200n;
		f.blocks.get(12n)!.transactions.push({ hash: hash(300), to: recipient, input: "0x1234" });
		const transfer = f.transfer(12, safe, recipient, 9n);
		transfer.transactionHash = hash(300);
		for (const logIndex of [1, 2])
			f.logs.push({
				...transfer,
				address: safe,
				logIndex,
				topics: encodeEventTopics({
					abi: safeAbi,
					eventName: "ExecutionFromModuleSuccess",
					args: { module: delay },
				}) as Hex[],
				data: "0x",
			});
		f.setNonce(2n, 2n);
		f.setLatest(17n);
		await s.scan("alice", vault);
		expect(s.page("alice").items.find((x) => x.readyAt && x.queueNonce === 0n)?.status).toBe(
			"executed",
		);
		expect(s.page("alice").items.find((x) => x.readyAt && x.queueNonce === 1n)?.status).toBe(
			"unresolved",
		);
	});
	it("indexes permissionless Delay execution through a third-party wrapper without tracing", async () => {
		const f = fixture(),
			s = f.open();
		f.queue();
		f.nonces.set(10n, { head: 0n, tail: 1n });
		f.blocks.get(11n)!.timestamp = 1200n;
		f.blocks.get(11n)!.transactions.push({ hash: hash(300), to: recipient, input: "0x1234" });
		const transfer = f.transfer(11, safe, recipient, 9n);
		transfer.transactionHash = hash(300);
		f.logs.push({
			...transfer,
			address: safe,
			logIndex: 1,
			topics: encodeEventTopics({
				abi: safeAbi,
				eventName: "ExecutionFromModuleSuccess",
				args: { module: delay },
			}) as Hex[],
			data: "0x",
		});
		f.setNonce(1n, 1n);
		await s.scan("alice", vault);
		const items = s.page("alice").items;
		expect(items.find((x) => x.readyAt)?.status).toBe("executed");
		expect(items.find((x) => x.blockNumber === 11n && x.kind === "transfer")?.lane).toBe(
			"delayed",
		);
		expect(items.filter((x) => x.kind === "execute")).toHaveLength(1);
	});
	it("retires an eventless internal expired skip from paired canonical head without inventing a skip transaction", async () => {
		const f = fixture(),
			s = f.open();
		f.queue();
		f.setNonce(0n, 1n);
		await s.scan("alice", vault);
		f.blocks.get(12n)!.timestamp = 1800n;
		f.blocks.get(12n)!.transactions.push({ hash: hash(300), to: recipient, input: "0x1234" });
		f.setNonce(1n, 1n);
		f.setLatest(17n);
		await s.scan("alice", vault);
		expect(s.page("alice").items).toHaveLength(1);
		expect(s.page("alice").items[0]?.status).toBe("expired");
		expect(s.page("alice").indexedThrough).toBe(12n);
	});
	it("continues confirmed transfers while marking an unexplained canonical head advance unresolved", async () => {
		const f = fixture(),
			s = f.open();
		f.queue();
		f.setNonce(0n, 1n);
		await s.scan("alice", vault);
		f.blocks.get(12n)!.timestamp = 1200n;
		f.transfer(12);
		f.setNonce(1n, 1n);
		f.setLatest(17n);
		await s.scan("alice", vault);
		const items = s.page("alice").items;
		expect(items.find((x) => x.readyAt)?.status).toBe("unresolved");
		expect(items.filter((x) => x.kind === "transfer" && !x.readyAt)).toHaveLength(1);
		expect(items.some((x) => x.kind === "execute" || x.kind === "skip")).toBe(false);
	});
	it("rejects inconsistent cache ordering metadata and malformed checkpoints", async () => {
		for (const statement of [
			"UPDATE history_records SET idx=99",
			"UPDATE history_cursors SET observed='private accidental data'",
			"UPDATE history_cursors SET binding='private accidental data'",
		]) {
			const f = fixture(),
				s = f.open();
			f.transfer(10);
			await s.scan("alice", vault);
			const db = new DatabaseSync(f.path);
			try {
				db.exec(statement);
			} finally {
				db.close();
			}
			expect(() => s.page("alice")).toThrow("cache");
		}
	});
	it("never returns orphaned records after the rebuildable cursor is deleted", async () => {
		const f = fixture(),
			s = f.open();
		f.transfer(10);
		await s.scan("alice", vault);
		const db = new DatabaseSync(f.path);
		try {
			db.prepare("DELETE FROM history_cursors WHERE account=?").run("alice");
		} finally {
			db.close();
		}
		expect(s.page("alice").items).toEqual([]);
		await s.scan("alice", vault);
		expect(s.page("alice").items).toHaveLength(1);
	});
	it("fails closed on malformed cache payloads instead of returning unexpected fields", async () => {
		const f = fixture(),
			s = f.open();
		f.transfer(10);
		await s.scan("alice", vault);
		const db = new DatabaseSync(f.path);
		try {
			const row = db.prepare("SELECT payload FROM history_records").get() as {
				payload: string;
			};
			db.prepare("UPDATE history_records SET payload=?").run(
				JSON.stringify({
					...JSON.parse(row.payload),
					unexpected: "private accidental data",
				}),
			);
		} finally {
			db.close();
		}
		expect(() => s.page("alice")).toThrow("cache");
	});
	it("replays a queue from durable cache across bounded scans and isolates another account", async () => {
		const f = fixture(),
			s = f.open({}, 1),
			q = f.queue();
		f.setNonce(0n, 1n);
		await s.scan("alice", vault);
		await s.scan("bob", vault);
		await s.scan("alice", vault);
		f.blocks.get(12n)!.timestamp = 1200n;
		f.blocks.get(12n)!.transactions.push({
			hash: hash(300),
			to: delay,
			input: encodeFunctionData({
				abi: delayAbi,
				functionName: "executeNextTx",
				args: [usdc, 0n, q.data, 0],
			}),
		});
		f.setNonce(1n, 1n);
		f.setLatest(17n);
		await s.scan("alice", vault);
		expect(s.page("alice").items.find((x) => x.readyAt)?.status).toBe("executed");
		expect(s.page("bob").items.find((x) => x.readyAt)?.status).toBe("queued");
	});
	it("does not interpret an internal eventless call or a non-Delay top-level selector as a skip", async () => {
		const f = fixture(),
			s = f.open();
		f.queue();
		f.setNonce(0n, 1n);
		await s.scan("alice", vault);
		f.blocks.get(12n)!.timestamp = 1800n;
		f.blocks.get(12n)!.transactions.push({
			hash: hash(300),
			to: recipient,
			input: encodeFunctionData({ abi: delayAbi, functionName: "skipExpired" }),
		});
		f.setLatest(17n);
		await s.scan("alice", vault);
		expect(s.page("alice").items.some((x) => x.kind === "skip")).toBe(false);
		expect(s.page("alice").items[0]?.status).toBe("queued");
	});
	it("requires each event transaction to belong to its paired canonical block", async () => {
		const f = fixture();
		const getBlock: HistoryReadClient["getBlock"] = async (input) => ({
			...(await f.first.getBlock(input)),
			transactions: [],
		});
		const s = new VaultHistory({
			databasePath: f.path,
			clients: [
				{ ...f.first, getBlock },
				{ ...f.second, getBlock },
			],
		});
		services.push(s);
		f.transfer(10);
		await expect(s.scan("alice", vault)).rejects.toThrow("membership");
		expect(s.page("alice").items).toEqual([]);
	});
	it("rejects paired receipts that contradict the logs query or claim a different transaction", async () => {
		const f = fixture();
		f.transfer(10);
		for (const override of [
			{ logs: [] },
			{ transactionHash: hash(999) },
			{ blockNumber: 11n },
			{ blockHash: hash(999) },
			{ status: "reverted" },
		]) {
			const read: HistoryReadClient["getTransactionReceipt"] = async ({ hash: h }) =>
				({
					...(await f.first.getTransactionReceipt({ hash: h })!),
					...override,
				}) as Awaited<ReturnType<HistoryReadClient["getTransactionReceipt"]>>;
			const s = new VaultHistory({
				databasePath: f.path,
				clients: [
					{ ...f.first, getTransactionReceipt: read },
					{ ...f.second, getTransactionReceipt: read },
				],
			});
			services.push(s);
			await expect(s.scan("alice", vault)).rejects.toThrow();
			expect(s.page("alice").items).toEqual([]);
		}
	});
	it("ignores other people's USDC logs before applying the account scan bound", async () => {
		const f = fixture(),
			s = f.open();
		const log = f.transfer(10, recipient, delay);
		f.logs.splice(0);
		for (let i = 0; i < 10001; i++) f.logs.push({ ...log, logIndex: i });
		await s.scan("alice", vault);
		expect(s.page("alice").items).toEqual([]);
		expect(s.page("alice").indexedThrough).toBe(11n);
	});
	it("rejects duplicate canonical transaction hashes rather than selecting an arbitrary input", async () => {
		const f = fixture(),
			s = f.open();
		f.blocks
			.get(10n)!
			.transactions.push(
				{ hash: hash(999), to: delay, input: "0x" },
				{ hash: hash(999), to: safe, input: "0x" },
			);
		await expect(s.scan("alice", vault)).rejects.toThrow();
	});
	it("derives expiry without adding an invented expiry transaction", async () => {
		const f = fixture(),
			s = f.open();
		f.queue();
		f.setNonce(0n, 1n);
		await s.scan("alice", vault);
		f.setNow(1800_000);
		const p = s.page("alice");
		expect(p.items).toHaveLength(1);
		expect(p.items[0]?.status).toBe("expired");
		expect(p.items[0]?.kind).toBe("transfer");
		expect(p.items[0]?.blockNumber).toBe(10n);
	});
	it("decodes only the reviewed recipient repair and leaves other maintenance unsupported", async () => {
		const f = fixture(),
			s = f.open();
		const abi = parseAbi([
			"function repairPolicy(bytes32,address,uint256,uint256,uint256,uint256,address[],uint8)",
		]);
		const data = encodeFunctionData({
			abi,
			functionName: "repairPolicy",
			args: [
				hash(50),
				usdc,
				1_000_000n,
				3_000_000n,
				1_000_000n,
				3_000_000n,
				[recipient, safe],
				1,
			],
		});
		f.queue(10, 0n, data, guard);
		f.queue(11, 1n, "0xdeadbeef", guard);
		f.setNonce(0n, 2n);
		await s.scan("alice", vault);
		expect(s.page("alice").items.map((x) => x.kind)).toEqual([
			"unsupported",
			"recipient-addition",
		]);
		expect(s.page("alice").items[1]?.counterparty).toBe(safe);
	});
	it("rejects a range spliced across a reorg while scanning", async () => {
		const f = fixture(),
			s = f.open();
		f.blocks.get(11n)!.parentHash = hash(999);
		await expect(s.scan("alice", vault)).rejects.toThrow("parent");
		expect(s.page("alice").items).toEqual([]);
	});
	it("correlates base/step-up authorization with the one actual withdrawal", async () => {
		const f = fixture(),
			s = f.open();
		for (const [n, tier] of [
			[10, 0],
			[11, 1],
		]) {
			const transfer = f.transfer(n!, safe, recipient);
			f.logs.push({
				...transfer,
				address: guard,
				logIndex: 1,
				topics: encodeEventTopics({
					abi: safeAbi,
					eventName: "TransferAuthorized",
				}) as Hex[],
				data: encodeAbiParameters(
					[
						{ type: "uint8" },
						{ type: "address" },
						{ type: "address" },
						{ type: "uint256" },
						{ type: "uint256" },
						{ type: "uint256" },
						{ type: "uint256" },
					],
					[tier!, usdc, recipient, 5n, 5n, 5n, 1n],
				),
			});
		}
		await s.scan("alice", vault);
		expect(s.page("alice").items.map((x) => [x.kind, x.lane])).toEqual([
			["transfer", "step-up"],
			["transfer", "base"],
		]);
	});
	it("executes a queued outside-app transfer with its exact tuple and updates proposal status", async () => {
		const f = fixture(),
			s = f.open(),
			q = f.queue();
		f.setNonce(0n, 1n);
		await s.scan("alice", vault);
		f.blocks.get(12n)!.timestamp = 1200n;
		const log = f.transfer(12, safe, recipient, 9n);
		log.transactionHash = hash(300);
		f.blocks.get(12n)!.transactions.push({
			hash: hash(300),
			to: delay,
			input: encodeFunctionData({
				abi: delayAbi,
				functionName: "executeNextTx",
				args: [usdc, 0n, q.data, 0],
			}),
		});
		f.setLatest(17n);
		f.setNonce(1n, 1n);
		await s.scan("alice", vault);
		const items = s.page("alice").items;
		expect(items.filter((x) => x.kind === "transfer" && x.blockNumber === 12n)).toHaveLength(1);
		expect(items.find((x) => x.blockNumber === 10n)?.status).toBe("executed");
		expect(items.find((x) => x.blockNumber === 12n && x.kind === "transfer")?.lane).toBe(
			"delayed",
		);
	});
	it("indexes a Safe cancellation only after its success event, exact input, and paired receipt", async () => {
		const f = fixture(),
			s = f.open();
		f.queue();
		f.setNonce(0n, 1n);
		await s.scan("alice", vault);
		const secretSignature = `0x${"ab".repeat(256)}` as Hex;
		const input = encodeFunctionData({ abi: delayAbi, functionName: "setTxNonce", args: [1n] });
		const outer = encodeFunctionData({
			abi: safeAbi,
			functionName: "execTransaction",
			args: [delay, 0n, input, 0, 0n, 0n, 0n, safe, safe, secretSignature],
		});
		f.blocks.get(12n)!.transactions.push({ hash: hash(300), to: safe, input: outer });
		f.logs.push(
			{
				address: delay,
				blockNumber: 12n,
				blockHash: hash(12),
				transactionHash: hash(300),
				logIndex: 0,
				topics: encodeEventTopics({ abi: delayAbi, eventName: "TxNonceSet" }) as Hex[],
				data: encodeAbiParameters([{ type: "uint256" }], [1n]),
			},
			{
				address: safe,
				blockNumber: 12n,
				blockHash: hash(12),
				transactionHash: hash(300),
				logIndex: 1,
				topics: encodeEventTopics({
					abi: safeAbi,
					eventName: "ExecutionSuccess",
					args: { txHash: hash(400) },
				}) as Hex[],
				data: encodeAbiParameters([{ type: "uint256" }], [0n]),
			},
		);
		f.setLatest(17n);
		f.setNonce(1n, 1n);
		await s.scan("alice", vault);
		expect(s.page("alice").items.map((x) => x.status)).toEqual(["cancelled", "cancelled"]);
		const db = new DatabaseSync(f.path);
		try {
			expect(JSON.stringify(db.prepare("SELECT * FROM history_records").all())).not.toContain(
				secretSignature.slice(2),
			);
			expect(JSON.stringify(db.prepare("SELECT * FROM history_records").all())).not.toContain(
				outer,
			);
		} finally {
			db.close();
		}
	});
	it("rejects stale pagination cursors after canonical history is removed", async () => {
		const f = fixture(),
			s = f.open();
		f.transfer(10);
		f.transfer(11);
		await s.scan("alice", vault);
		const cursor = s.page("alice", { limit: 1 }).nextCursor!;
		f.blocks.get(11n)!.hash = hash(999);
		f.logs.splice(0);
		await s.scan("alice", vault);
		expect(() => s.page("alice", { cursor })).toThrow();
	});
	it("rejects contradictory lifecycle receipts without committing records or advancing the cursor", async () => {
		const f = fixture(),
			s = f.open({
				getTransactionReceipt: async (input) =>
					input.hash === hash(300) ? null : f.first.getTransactionReceipt(input),
			});
		f.queue();
		f.setNonce(0n, 1n);
		await s.scan("alice", vault);
		f.blocks.get(12n)!.timestamp = 1800n;
		f.blocks.get(12n)!.transactions.push({
			hash: hash(300),
			to: delay,
			input: encodeFunctionData({ abi: delayAbi, functionName: "skipExpired" }),
		});
		f.setLatest(17n);
		f.setNonce(1n, 1n);
		await expect(s.scan("alice", vault)).rejects.toThrow("disagree");
		expect(s.page("alice").indexedThrough).toBe(11n);
	});
	it("indexes outside-app USDC deposits and self-transfers once, bounded at six confirmations", async () => {
		const f = fixture(),
			s = f.open();
		f.transfer(10);
		f.transfer(11, safe, safe);
		f.transfer(12, safe, recipient);
		await s.scan("alice", vault);
		const page = s.page("alice");
		expect(page.indexedThrough).toBe(11n);
		expect(page.items.map((x) => x.direction)).toEqual(["self", "in"]);
		expect(page.items[0]?.amount).toBe(5n);
		expect(f.calls.every((c) => c.fromBlock >= 10n && c.toBlock <= 11n)).toBe(true);
	});
	it("persists the cursor and deduplicates restarts; paginates only its account", async () => {
		const f = fixture(),
			s = f.open();
		f.transfer(10);
		f.transfer(11, safe, recipient);
		await s.scan("alice", vault);
		const p = s.page("alice", { limit: 1 });
		expect(p.items).toHaveLength(1);
		expect(p.nextCursor).toBeTruthy();
		expect(s.page("alice", { cursor: p.nextCursor, limit: 1 }).items).toHaveLength(1);
		expect(s.page("bob").items).toEqual([]);
		expect(() => s.page("bob", { cursor: p.nextCursor })).toThrow();
		s.close();
		services.pop();
		const reopened = f.open();
		await reopened.scan("alice", vault);
		expect(reopened.page("alice").items).toHaveLength(2);
		expect(() => reopened.page("alice", { limit: 101 })).toThrow();
		expect(() => reopened.page("alice", { cursor: "garbage" })).toThrow();
	});
	it("fails closed on reader log, block, source, receipt and chain disagreement", async () => {
		const f = fixture();
		f.transfer(10);
		const s = f.open({ getLogs: async () => [] });
		await expect(s.scan("alice", vault)).rejects.toThrow();
		expect(s.page("alice").items).toEqual([]);
		await expect(
			f
				.open({
					getBlock: async ({ blockNumber }) => ({
						number: blockNumber,
						hash: hash(999),
						parentHash: hash(9),
						timestamp: 1010n,
						transactions: [],
					}),
				})
				.scan("alice", vault),
		).rejects.toThrow();
		await expect(f.open({ getChainId: async () => 1 }).scan("alice", vault)).rejects.toThrow();
		expect(() => f.open({ source: "one" })).toThrow();
	});
	it("rolls back a changed canonical checkpoint and reconstructs only the replacement chain", async () => {
		const f = fixture(),
			s = f.open();
		f.transfer(10);
		await s.scan("alice", vault);
		f.blocks.get(11n)!.hash = hash(999);
		f.logs.splice(0);
		await s.scan("alice", vault);
		expect(s.page("alice").items).toEqual([]);
	});
	it("advances empty scans in bounded increments and rejects changed vault identity", async () => {
		const f = fixture(),
			s = f.open({}, 1);
		await s.scan("alice", vault);
		expect(s.page("alice").indexedThrough).toBe(10n);
		await s.scan("alice", vault);
		expect(s.page("alice").indexedThrough).toBe(11n);
		await expect(s.scan("alice", { ...vault, safe: recipient })).rejects.toThrow();
	});
	it("derives queue expiry and discovers an eventless outside-app skip through canonical input and receipt", async () => {
		const f = fixture(),
			s = f.open();
		const data = encodeFunctionData({
			abi: tokenAbi,
			functionName: "transfer",
			args: [recipient, 9n],
		});
		const fp = keccak256(
			encodePacked(["address", "uint256", "bytes", "uint8"], [usdc, 0n, data, 0]),
		);
		f.logs.push({
			address: delay,
			blockNumber: 10n,
			blockHash: hash(10),
			transactionHash: hash(200),
			logIndex: 0,
			topics: encodeEventTopics({
				abi: delayAbi,
				eventName: "TransactionAdded",
				args: { queueNonce: 0n, txHash: fp },
			}) as Hex[],
			data: encodeAbiParameters(
				[{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "uint8" }],
				[usdc, 0n, data, 0],
			),
		});
		f.setNonce(0n, 1n);
		await s.scan("alice", vault);
		expect(s.page("alice").items[0]).toMatchObject({
			status: "queued",
			queueNonce: 0n,
			lane: "delayed",
			readyAt: 1130,
			expiresAt: 1730,
		});
		f.blocks.get(12n)!.timestamp = 1800n;
		f.blocks.get(12n)!.transactions.push({
			hash: hash(300),
			to: delay,
			input: encodeFunctionData({ abi: delayAbi, functionName: "skipExpired" }),
		});
		f.nonces.set(11n, { head: 0n, tail: 1n });
		f.setNonce(1n, 1n);
		f.setLatest(17n);
		await s.scan("alice", vault);
		expect(s.page("alice").items.map((x) => x.kind)).toEqual(["skip", "transfer"]);
		expect(s.page("alice").items[1]?.status).toBe("expired");
	});
});
