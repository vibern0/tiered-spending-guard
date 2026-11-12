import { type Hex } from "viem";
import type { PwaObservedState, PwaObserverClient } from "@tiered-spending-guard/security-core/pwa";
import type { BackendIntent, BackendVaultRecord } from "../vaults/types";
import type {
	BackendPreparedSubmission,
	BackendSubmissionReceipt,
	SubmissionEntry as Entry,
	SubmissionReadClient as ReadClient,
} from "./types";
import type { SubmissionPreparation } from "./prepare";
import type { SubmissionExecution } from "./execute";
import { canonicalIntent } from "./prepare";
import { SubmissionJournal } from "./journal";
import { persistPwaObservation, submissionObserverExecutableHash } from "./observations";
import { core, hash } from "./core";

export function createSubmissionReconciliation(
	journalPath: string,
	providers: readonly [ReadClient, ReadClient],
	entries: Map<string, Entry>,
	preparation: Pick<SubmissionPreparation, "stateAt" | "snapshotAt">,
	execution: Pick<SubmissionExecution, "discard" | "entryForOuterHash">,
	currentVault?: () => BackendVaultRecord | undefined,
) {
	const { stateAt, snapshotAt } = preparation;
	const { discard, entryForOuterHash } = execution;
	const recoverEntry = async (transactionHash: Hex): Promise<Entry | undefined> => {
		const journal = new SubmissionJournal(journalPath);
		const stored = journal.findByOuterHash(transactionHash);
		const vault = currentVault?.();
		if (!stored || !vault) return undefined;
		const publicIntent = stored.publicRequest.intent;
		const preparedBlock = stored.publicRequest.preparedBlockNumber;
		if (
			!publicIntent ||
			typeof publicIntent !== "object" ||
			typeof preparedBlock !== "string" ||
			!/^\d+$/.test(preparedBlock)
		)
			throw new Error("durable submission reconstruction metadata is missing");
		const rawIntent = publicIntent as Record<string, unknown>;
		const request = {
			...rawIntent,
			...(rawIntent.kind === "transfer" ? { amount: BigInt(String(rawIntent.amount)) } : {}),
			...("queueNonce" in rawIntent
				? { queueNonce: BigInt(String(rawIntent.queueNonce)) }
				: {}),
		} as BackendIntent;
		const intent = canonicalIntent(request);
		const { snapshot } = await snapshotAt(vault, BigInt(preparedBlock));
		const prepared = core.preparePwaIntent(snapshot, intent);
		if (hash(prepared) !== stored.requestHash.toLowerCase())
			throw new Error("reconstructed submission does not match durable intent hash");
		const publicPrepared: BackendPreparedSubmission = Object.freeze({
			id: stored.id,
			requestHash: stored.requestHash as Hex,
			...("safeTxHash" in prepared ? { safeTxHash: prepared.safeTxHash } : {}),
			kind: prepared.kind,
			requiredApprovals: prepared.requiredApprovals,
			publicRequest: stored.publicRequest,
		});
		const entry = { vault, intent, snapshot, prepared, publicPrepared };
		entries.set(stored.id, entry);
		return entry;
	};

	const reconcile = async (
		transactionHash: Hex,
	): Promise<BackendSubmissionReceipt | undefined> => {
		const receipts = await Promise.all(
			providers.map((client) => client.getTransactionReceipt({ hash: transactionHash })),
		);
		if (receipts.some((receipt) => !receipt)) return undefined;
		const first = receipts[0]!;
		if (first.transactionHash.toLowerCase() !== transactionHash.toLowerCase())
			throw new Error("receipt does not match the durable submission hash");
		if (first.status !== "success" && first.status !== "reverted")
			throw new Error("submission receipt has an invalid status");
		if (core.canonicalSubmissionJson(first) !== core.canonicalSubmissionJson(receipts[1]))
			throw new Error("submission receipt providers disagree");
		const [heads, blocks] = await Promise.all([
			Promise.all(providers.map((client) => client.getBlockNumber())),
			Promise.all(
				providers.map((client) => client.getBlock({ blockNumber: first.blockNumber })),
			),
		]);
		if (heads.some((head) => head < first.blockNumber + 5n)) return undefined;
		if (
			blocks.some(
				(block) =>
					block.number !== first.blockNumber ||
					block.hash?.toLowerCase() !== first.blockHash.toLowerCase(),
			)
		)
			throw new Error("submission receipt is not canonical");
		const envelopeEntry = entryForOuterHash(transactionHash);
		const entry =
			envelopeEntry ??
			[...entries.values()].find(
				(value) =>
					new SubmissionJournal(journalPath)
						.get(value.publicPrepared.id)
						?.outerTransactionHash?.toLowerCase() === transactionHash.toLowerCase(),
			) ??
			(await recoverEntry(transactionHash));
		if (!entry)
			throw new Error(
				"durable server-held submission evidence is required for reconciliation",
			);
		if (first.status === "success") {
			const clients = providers.map((client) =>
				Object.freeze({
					source: client.source,
					getBlockNumber: client.getBlockNumber,
					getTransactionReceipt: client.getTransactionReceipt,
					getTransaction: client.getTransaction,
					getBlock: client.getBlock,
					readStateAt: async (blockNumber: bigint): Promise<PwaObservedState> => {
						const state = await stateAt(
							client,
							entry.vault,
							blockNumber,
							entry.prepared.recipient,
						);
						return {
							policy: state.proof.policy,
							safeNonce: state.snapshotState.safeNonce,
							queueHeadNonce: state.snapshotState.queueHeadNonce,
							queueTailNonce: state.snapshotState.queueTailNonce,
							safeUsdcBalance: state.balances!.safeUsdcBalance,
							recipientUsdcBalance: state.balances!.recipientUsdcBalance,
							spendState: state.snapshotState.spendState,
							queueHead: state.snapshotState.queueHead,
							deploymentsHash: state.proof.vault.deploymentsHash,
							policyHash: state.proof.vault.policyHash,
							topologyReportHash: state.proof.topologyReportHash,
						};
					},
				}),
			) as unknown as readonly [PwaObserverClient, PwaObserverClient];
			const record = await core.observePwaReceipt(
				{
					intent: entry.prepared,
					profileHash: hash(core.loadCommittedPwaPhaseOneProfile()),
					topologyReportHash: entry.vault.verifiedProvisioning.topologyReportHash,
					confirmations: 6,
					observer: {
						processId: `backend-observer-${process.pid}`,
						executableHash: submissionObserverExecutableHash(),
						startedAt: new Date().toISOString(),
					},
					clients,
				},
				transactionHash,
			);
			persistPwaObservation(`${journalPath}.observations`, record);
		}
		if (envelopeEntry) discard(entry.publicPrepared);
		return {
			status: first.status === "success" ? "confirmed" : "reverted",
			transactionHash,
			blockNumber: first.blockNumber,
			blockHash: first.blockHash,
		};
	};

	return reconcile;
}
