import { getAddress, isAddress, isAddressEqual, parseAbi, type Address, type Hex } from "viem";
import type {
	PreparedPwaIntent,
	PwaIntent,
	VerifiedPwaSnapshot,
} from "@tiered-spending-guard/security-core/pwa";
import type { BackendIntent, BackendVaultRecord } from "../vaults/types";
import type {
	BackendPreparedSubmission,
	ConfiguredSubmissionRuntime,
	SubmissionEntry as Entry,
	SubmissionReadClient as ReadClient,
} from "./types";
import { core, bytes32, hash } from "./core";
const ABI = parseAbi([
	"function nonce() view returns (uint256)",
	"function frozen() view returns (bool)",
	"function spendState(address) view returns (uint256,uint256,uint256)",
	"function balanceOf(address) view returns (uint256)",
	"function txNonce() view returns (uint256)",
	"function queueNonce() view returns (uint256)",
	"function getTxHash(uint256) view returns (bytes32)",
	"function getTxCreatedAt(uint256) view returns (uint256)",
]);
const MAX_LOG_BLOCK_RANGE = 10_000n;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
async function readDelayLogs(
	client: ReadClient,
	input: Readonly<{ address: Address; fromBlock: bigint; toBlock: bigint; queueNonce: bigint }>,
): Promise<Awaited<ReturnType<ReadClient["getLogs"]>>> {
	if (input.fromBlock > input.toBlock)
		throw new Error("Delay event scan boundary is in the future");
	const logs: Awaited<ReturnType<ReadClient["getLogs"]>> = [];
	for (let start = input.fromBlock; start <= input.toBlock; start += MAX_LOG_BLOCK_RANGE) {
		const end = start + MAX_LOG_BLOCK_RANGE - 1n;
		logs.push(
			...(await client.getLogs({
				address: input.address,
				fromBlock: start,
				toBlock: end < input.toBlock ? end : input.toBlock,
				args: { queueNonce: input.queueNonce },
			})),
		);
	}
	return logs;
}
function uint(value: unknown, label: string): bigint {
	if (
		typeof value === "string" &&
		/^(0|[1-9][0-9]{0,77})$/.test(value) &&
		BigInt(value) < 1n << 256n
	)
		return BigInt(value);
	if (typeof value === "bigint" && value >= 0n && value < 1n << 256n) return value;
	throw new Error(`${label} must be a canonical nonnegative integer`);
}
export function canonicalIntent(request: BackendIntent): PwaIntent {
	if (request.kind === "transfer" || request.kind === "add-recipient") {
		if (
			typeof request.recipient !== "string" ||
			!isAddress(request.recipient) ||
			isAddressEqual(request.recipient, ZERO)
		)
			throw new Error("recipient must be a nonzero address");
		const recipient = getAddress(request.recipient);
		return request.kind === "transfer"
			? { kind: "transfer", recipient, amount: uint(request.amount, "amount") }
			: { kind: "add-recipient", recipient };
	}
	if (typeof request.queueFingerprint !== "string" || !bytes32.test(request.queueFingerprint))
		throw new Error("canonical queue fingerprint is required");
	return {
		kind: request.kind,
		queueNonce: uint(request.queueNonce, "queueNonce"),
		queueFingerprint: request.queueFingerprint.toLowerCase() as Hex,
	};
}
function semantic(prepared: PreparedPwaIntent): unknown {
	const {
		snapshotHash: _snapshotHash,
		blockNumber: _blockNumber,
		blockHash: _blockHash,
		timestamp: _timestamp,
		...remaining
	} = prepared;
	return remaining;
}

export function createSubmissionPreparation(
	providers: readonly [ReadClient, ReadClient],
	entries: Map<string, Entry>,
) {
	const read = <T>(
		client: ReadClient,
		address: Address,
		functionName: string,
		blockNumber: bigint,
		args: readonly unknown[] = [],
	) => client.readContract({ address, abi: ABI, functionName, args, blockNumber }) as Promise<T>;

	const stateAt = async (
		client: ReadClient,
		vault: BackendVaultRecord,
		blockNumber: bigint,
		recipient?: Address,
	) => {
		if (!vault.provisioningPlan)
			throw new Error("original reviewed provisioning plan is required for submissions");
		const anchor = await client.getBlock({ blockNumber });
		if (anchor.number !== blockNumber || !anchor.hash || !bytes32.test(anchor.hash))
			throw new Error("submission state block is unavailable");
		const scoped = core.createPinnedReadScope(client, blockNumber);
		const proof = await core.verifyPwaSubmissionState({
			plan: vault.provisioningPlan,
			vault: vault.verifiedProvisioning,
			client: scoped,
			blockNumber,
		});
		const [safeNonce, spendState, queueHeadNonce, queueTailNonce, frozen] = await Promise.all([
			read<bigint>(scoped, vault.safe, "nonce", blockNumber),
			read<readonly [bigint, bigint, bigint]>(
				scoped,
				vault.guard,
				"spendState",
				blockNumber,
				[vault.usdc],
			),
			read<bigint>(scoped, vault.delay, "txNonce", blockNumber),
			read<bigint>(scoped, vault.delay, "queueNonce", blockNumber),
			read<boolean>(scoped, vault.guard, "frozen", blockNumber),
		]);
		if (queueTailNonce < queueHeadNonce || queueTailNonce - queueHeadNonce > 128n)
			throw new Error("Delay queue is inconsistent or exceeds the supported bound");
		let queueHead: VerifiedPwaSnapshot["queueHead"] = null;
		if (queueHeadNonce < queueTailNonce) {
			const [fingerprint, createdAt, logs] = await Promise.all([
				read<Hex>(scoped, vault.delay, "getTxHash", blockNumber, [queueHeadNonce]),
				read<bigint>(scoped, vault.delay, "getTxCreatedAt", blockNumber, [queueHeadNonce]),
				readDelayLogs(client, {
					address: vault.delay,
					fromBlock: vault.verifiedProvisioning.setupReceipt.blockNumber,
					toBlock: blockNumber,
					queueNonce: queueHeadNonce,
				}),
			]);
			if (logs.length !== 1) throw new Error("Delay head requires one canonical queue event");
			const log = logs[0]!;
			if (
				log.removed ||
				log.args.operation !== 0 ||
				log.args.to === undefined ||
				log.args.value === undefined ||
				log.args.data === undefined ||
				createdAt <= 0n ||
				log.args.txHash?.toLowerCase() !== fingerprint.toLowerCase()
			)
				throw new Error("Delay queue event identity is inconsistent");
			const item = {
				safe: vault.safe,
				delay: vault.delay,
				queueNonce: queueHeadNonce,
				to: getAddress(log.args.to),
				value: log.args.value,
				data: log.args.data,
				operation: 0 as const,
				createdAt,
				readyAt: createdAt + 120n,
				expiresAt: createdAt + 720n,
				queueFingerprint: fingerprint,
			};
			if (core.queueFingerprint(item) !== fingerprint)
				throw new Error("Delay queue fingerprint mismatch");
			queueHead = Object.freeze(item);
		}
		const asset = proof.policy.assets[0]!;
		const snapshotState = {
			deploymentsHash: proof.vault.deploymentsHash,
			policyHash: proof.vault.policyHash,
			safe: vault.safe,
			guard: vault.guard,
			delay: vault.delay,
			usdc: vault.usdc,
			primaryPasskey: vault.primaryPasskey,
			secondaryPasskey: vault.secondaryPasskey,
			baseRecipientMode: "any-valid-address" as const,
			elevatedRecipients: asset.recipients as readonly [Address, ...Address[]],
			safeNonce,
			spendState: {
				window: spendState[0],
				baseSpent: spendState[1],
				instantSpent: spendState[2],
			},
			limits: {
				basePerTransaction: asset.basePerTransaction,
				stepUpPerTransaction: asset.stepUpPerTransaction,
				baseDailyLimit: asset.baseDailyLimit,
				instantDailyLimit: asset.instantDailyLimit,
			},
			cooldownSeconds: 120n,
			expirationSeconds: 600n,
			queueHeadNonce,
			queueTailNonce,
			queueHead,
		};
		let balances: { safeUsdcBalance: bigint; recipientUsdcBalance: bigint } | undefined;
		if (recipient) {
			const [safeUsdcBalance, recipientUsdcBalance] = await Promise.all([
				read<bigint>(scoped, vault.usdc, "balanceOf", blockNumber, [vault.safe]),
				read<bigint>(scoped, vault.usdc, "balanceOf", blockNumber, [recipient]),
			]);
			balances = { safeUsdcBalance, recipientUsdcBalance };
		}
		const block = await client.getBlock({ blockNumber });
		if (
			block.number !== blockNumber ||
			block.hash?.toLowerCase() !== anchor.hash.toLowerCase() ||
			block.timestamp !== anchor.timestamp
		)
			throw new Error("submission state block changed during collection");
		return { proof, snapshotState, block, frozen, balances };
	};

	const snapshotAt = async (vault: BackendVaultRecord, at?: bigint) => {
		const heads = await Promise.all(providers.map((client) => client.getBlockNumber()));
		if (heads[0] > heads[1] + 2n || heads[1] > heads[0] + 2n)
			throw new Error("submission providers disagree on chain height");
		const blockNumber = at ?? (heads[0] < heads[1] ? heads[0] : heads[1]);
		const values = await Promise.all(
			providers.map(async (client) => {
				const value = await stateAt(client, vault, blockNumber);
				const snapshot = await core.captureVerifiedPwaSnapshot(
					value.proof.vault,
					blockNumber,
					{
						getBlock: client.getBlock,
						readAt: async () => value.snapshotState,
					},
				);
				if (
					snapshot.blockHash.toLowerCase() !== value.block.hash!.toLowerCase() ||
					snapshot.timestamp !== value.block.timestamp
				)
					throw new Error("submission snapshot block changed after collection");
				return { ...value, snapshot };
			}),
		);
		if (
			core.canonicalSubmissionJson(values[0]!.snapshot) !==
				core.canonicalSubmissionJson(values[1]!.snapshot) ||
			values[0]!.frozen !== values[1]!.frozen
		)
			throw new Error("submission providers disagree on the canonical snapshot");
		return {
			snapshot: values[0]!.snapshot,
			proof: values[0]!.proof,
			frozen: values[0]!.frozen,
		};
	};

	const entryFor = (prepared: BackendPreparedSubmission) => {
		const entry = entries.get(prepared.id);
		if (
			!entry ||
			core.canonicalSubmissionJson(entry.publicPrepared) !==
				core.canonicalSubmissionJson(prepared)
		)
			throw new Error("server-held prepared intent is required");
		return entry;
	};
	const revalidatedSnapshot = async (prepared: BackendPreparedSubmission) => {
		const entry = entryFor(prepared);
		const originalBlocks = await Promise.all(
			providers.map((client) => client.getBlock({ blockNumber: entry.prepared.blockNumber })),
		);
		if (
			originalBlocks.some(
				(block) => block.hash?.toLowerCase() !== entry.prepared.blockHash.toLowerCase(),
			)
		)
			throw new Error("prepared snapshot block changed");
		const fresh = await snapshotAt(entry.vault);
		if (fresh.frozen && ["base-transfer", "step-up-transfer"].includes(entry.prepared.kind))
			throw new Error("instant spending is frozen");
		const actual = core.preparePwaIntent(fresh.snapshot, entry.intent);
		if (
			core.canonicalSubmissionJson(semantic(actual)) !==
			core.canonicalSubmissionJson(semantic(entry.prepared))
		)
			throw new Error(
				"prepared intent is stale after policy, nonce, counters, or queue drift",
			);
		return fresh;
	};
	const revalidate = async (prepared: BackendPreparedSubmission): Promise<void> => {
		await revalidatedSnapshot(prepared);
	};
	const prepare: ConfiguredSubmissionRuntime["prepare"] = async ({ vault, request }) => {
		if (
			typeof request.idempotencyKey !== "string" ||
			!/^[A-Za-z0-9._:-]{1,160}$/.test(request.idempotencyKey)
		)
			throw new Error("idempotency key is invalid");
		const intent = canonicalIntent(request);
		const existing = entries.get(request.idempotencyKey);
		if (existing) {
			if (
				core.canonicalSubmissionJson(existing.intent) !==
				core.canonicalSubmissionJson(intent)
			)
				throw new Error("idempotency key is already bound to another intent");
			return existing.publicPrepared;
		}
		const { snapshot, frozen } = await snapshotAt(vault);
		const prepared = core.preparePwaIntent(snapshot, intent);
		if (frozen && ["base-transfer", "step-up-transfer"].includes(prepared.kind))
			throw new Error("instant spending is frozen");
		const simulations = await Promise.all(
			providers.map((client) => core.simulatePwaIntent(prepared, client)),
		);
		if (simulations.some((evidence) => !evidence.ok))
			throw new Error("prepared intent simulation failed");
		const publicRequest = Object.freeze({
			...request,
			intent: JSON.parse(core.canonicalSubmissionJson(intent)),
			preparedBlockNumber: String(prepared.blockNumber),
			preparedAt: Number(prepared.timestamp) * 1000,
			preparedKind: prepared.kind,
		});
		const publicPrepared: BackendPreparedSubmission = Object.freeze({
			id: request.idempotencyKey,
			requestHash: hash(prepared),
			...("safeTxHash" in prepared ? { safeTxHash: prepared.safeTxHash } : {}),
			kind: prepared.kind,
			requiredApprovals: prepared.requiredApprovals,
			publicRequest,
		});
		const raced = entries.get(publicPrepared.id);
		if (raced) {
			if (core.canonicalSubmissionJson(raced.intent) !== core.canonicalSubmissionJson(intent))
				throw new Error("idempotency key is already bound to another intent");
			return raced.publicPrepared;
		}
		entries.set(publicPrepared.id, { vault, intent, snapshot, prepared, publicPrepared });
		return publicPrepared;
	};
	return Object.freeze({
		prepare,
		entryFor,
		stateAt,
		snapshotAt,
		revalidatedSnapshot,
		revalidate,
	});
}
export type SubmissionPreparation = ReturnType<typeof createSubmissionPreparation>;
