import { isAddressEqual, keccak256, stringToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { RelayerContext, SubmissionRequest } from "@tiered-spending-guard/sdk/pwa";
import type { BackendConfig } from "../config/config";
import type {
	BackendPreparedSubmission,
	ConfiguredSubmissionRuntime,
	SubmissionEntry as Entry,
	SubmissionRuntimeDependencies,
} from "./types";
import type { SubmissionPreparation } from "./prepare";
import { SubmissionJournal } from "./journal";
import { core } from "./core";
type SignedEnvelope = {
	entry: Entry;
	request: SubmissionRequest | null;
	raw: Hex;
	hash: Hex;
	nonce: bigint;
	close(): void;
};

/**
 * Build the bounded Sepolia relay path for server-held prepared intents.
 * Signed envelopes and payer leases remain process-local; their exact hashes must become durable before sending.
 */
export function createSubmissionExecution(
	config: Pick<BackendConfig, "relayPrivateKey" | "journalPath" | "provisioningJournalPath">,
	dependencies: SubmissionRuntimeDependencies,
	preparation: Pick<SubmissionPreparation, "entryFor" | "revalidatedSnapshot" | "revalidate">,
) {
	const { providers, relay } = dependencies;
	const { entryFor, revalidatedSnapshot, revalidate } = preparation;
	const payer = privateKeyToAccount(config.relayPrivateKey);
	const policy = core.loadCommittedPwaProvisioningAutomationPolicy();
	const envelopes = new Map<string, SignedEnvelope>();
	let activeEnvelope: string | undefined;
	/** Release a prepared envelope's payer lease and remove its process-local signed bytes. */
	const discard = (prepared: BackendPreparedSubmission) => {
		const envelope = envelopes.get(prepared.id);
		if (envelope) {
			envelope.close();
			envelopes.delete(prepared.id);
		}
		if (activeEnvelope === prepared.id) {
			activeEnvelope = undefined;
		}
	};

	/**
	 * Revalidate intent state, encode required approvals, acquire the payer lease and sign a bounded envelope.
	 * Reject unresolved durable submissions and provider nonce disagreement; retain bytes for exact-hash broadcast.
	 */
	const deriveOuterHash: ConfiguredSubmissionRuntime["deriveOuterHash"] = async (
		prepared,
		approvals,
	) => {
		const entry = entryFor(prepared);
		if (activeEnvelope) {
			throw new Error("another payer operation is pending; reconcile it before signing");
		}
		const lease = core.createPwaProvisioningRuntime({
			plan: entry.vault.provisioningPlan!,
			journalPath: config.provisioningJournalPath,
			account: payer,
			client: relay,
		});
		activeEnvelope = prepared.id;
		try {
			if (new SubmissionJournal(config.journalPath).listPending().length) {
				throw new Error(
					"a durable submission is unresolved; reconcile its exact hash before signing",
				);
			}
			const fresh = await revalidatedSnapshot(prepared);
			const idempotencyKey = keccak256(stringToHex(prepared.id));
			let request: SubmissionRequest | null;
			let to: Address, data: Hex;
			if ("safeTx" in entry.prepared) {
				const primary = approvals.find((approval) => approval.role === "primary");
				const secondary = approvals.find((approval) => approval.role === "secondary");
				if (
					!primary ||
					approvals.length !== entry.prepared.requiredApprovals.length ||
					(entry.prepared.requiredApprovals.some((role) => role === "secondary") &&
						!secondary)
				) {
					throw new Error("exact required approvals are missing");
				}
				const signatures = core.encodeGuardContractSignatures(
					{ address: entry.vault.primaryPasskey, payload: primary.payload },
					secondary
						? { address: entry.vault.secondaryPasskey, payload: secondary.payload }
						: undefined,
				);
				request = {
					version: 1,
					kind: "safe-execution",
					idempotencyKey,
					chainId: 11155111,
					deploymentsHash: core.deploymentInfrastructureHash(fresh.proof.deployments),
					policyHash: entry.prepared.policyHash,
					safe: entry.prepared.safe,
					guard: entry.prepared.guard,
					asset: entry.prepared.asset,
					transaction: entry.prepared.safeTx,
					safeTxHash: entry.prepared.safeTxHash,
					signatures,
					expectedSpend: entry.prepared.expectedSpend,
				};
				to = request.safe;
				data = core.encodeSafeExecutionCalldata(request);
			} else if (entry.prepared.kind === "execute-ready") {
				if (approvals.length) {
					throw new Error("permissionless execution does not accept approvals");
				}
				const queue = entry.prepared.queue;
				request = {
					version: 1,
					kind: "delay-execution",
					idempotencyKey,
					chainId: 11155111,
					deploymentsHash: core.deploymentInfrastructureHash(fresh.proof.deployments),
					policyHash: entry.prepared.policyHash,
					safe: entry.prepared.safe,
					guard: entry.prepared.guard,
					delay: entry.prepared.delay,
					queueNonce: queue.queueNonce,
					queueFingerprint: queue.queueFingerprint,
					to: queue.to,
					value: queue.value,
					data: queue.data,
					operation: queue.operation,
					createdAt: queue.createdAt,
					cooldownSeconds: 120n,
					expirationSeconds: 600n,
				};
				to = request.delay;
				data = core.encodeDelayExecutionCalldata(request);
			} else {
				if (approvals.length || entry.prepared.kind !== "skip-expired") {
					throw new Error("unsupported direct lifecycle transaction");
				}
				// skipExpired has a separate closed prepared call; it cannot enter generic Delay execution.
				request = null;
				to = entry.prepared.call.to;
				data = entry.prepared.call.data;
			}
			const nonces = await Promise.all(
				[...providers, relay].map(async (client) => {
					const [latest, pending] = await Promise.all([
						client.getTransactionCount({
							address: payer.address,
							blockTag: "latest",
						}),
						client.getTransactionCount({
							address: payer.address,
							blockTag: "pending",
						}),
					]);
					if (BigInt(latest) !== BigInt(pending)) {
						throw new Error("payer has an outstanding transaction");
					}
					return BigInt(latest);
				}),
			);
			if (
				nonces.some((nonce) => nonce !== nonces[0]) ||
				nonces[0]! > BigInt(Number.MAX_SAFE_INTEGER)
			) {
				throw new Error("payer nonce providers disagree");
			}
			const blockNumber = fresh.snapshot.blockNumber;
			const blocks = await Promise.all(
				[...providers, relay].map((client) => client.getBlock({ blockNumber })),
			);
			if (
				blocks.some(
					(block) =>
						block.hash !== fresh.snapshot.blockHash ||
						block.baseFeePerGas === null ||
						block.baseFeePerGas === undefined ||
						block.gasLimit === undefined,
				)
			) {
				throw new Error("payer quote block disagrees");
			}
			const [estimates, tips, relayBalance] = await Promise.all([
				Promise.all(
					providers.map((client) =>
						client.estimateGas({
							account: payer.address,
							to,
							data,
							value: 0n,
							blockNumber,
						}),
					),
				),
				Promise.all(providers.map((client) => client.getMaxPriorityFeePerGas())),
				relay.getBalance({ address: payer.address }),
			]);
			const envelope = core.derivePwaProvisioningEnvelope({
				estimates: estimates as [bigint, bigint],
				priorityFeesPerGas: tips as [bigint, bigint],
				blockGasLimit: blocks[0]!.gasLimit!,
				baseFeePerGas: blocks[0]!.baseFeePerGas!,
				value: 0n,
				confirmedActualCost: 0n,
				pendingReservation: 0n,
				relayBalance,
				policy,
			});
			dependencies.beforeSign?.(prepared.id);
			const raw = await payer.signTransaction({
				chainId: 11155111,
				type: "eip1559",
				to,
				value: 0n,
				data,
				nonce: Number(nonces[0]!),
				gas: envelope.gasLimit,
				maxFeePerGas: envelope.maxFeePerGas,
				maxPriorityFeePerGas: envelope.maxPriorityFeePerGas,
			});
			const outerHash = keccak256(raw);
			envelopes.set(prepared.id, {
				entry,
				request,
				raw,
				hash: outerHash,
				nonce: nonces[0]!,
				close: lease.close,
			});
			return outerHash;
		} catch (error) {
			lease.close();
			activeEnvelope = undefined;
			throw error;
		}
	};
	/** Send only the retained signed envelope after verifying its durable hash and current execution state. */
	const broadcast: ConfiguredSubmissionRuntime["broadcast"] = async (
		prepared,
		_approvals,
		expectedHash,
	) => {
		const envelope = envelopes.get(prepared.id);
		if (
			!envelope ||
			envelope.hash !== expectedHash ||
			keccak256(envelope.raw) !== expectedHash
		) {
			throw new Error("exact signed envelope is unavailable");
		}
		const durable = new SubmissionJournal(config.journalPath).get(prepared.id);
		if (
			durable?.outerTransactionHash?.toLowerCase() !== expectedHash.toLowerCase() ||
			durable.state !== "submitting"
		) {
			throw new Error("signed hash must be durable before broadcast");
		}
		const fresh = await revalidatedSnapshot(prepared);
		/** Require every fixed provider and relay to agree that the signed payer nonce is still unused on Sepolia. */
		const checkPayer = async () => {
			const states = await Promise.all(
				[...providers, relay].map(async (client) => {
					const [chainId, latest, pending] = await Promise.all([
						client.getChainId(),
						client.getTransactionCount({
							address: payer.address,
							blockTag: "latest",
						}),
						client.getTransactionCount({
							address: payer.address,
							blockTag: "pending",
						}),
					]);
					return { chainId, latest: BigInt(latest), pending: BigInt(pending) };
				}),
			);
			if (
				states.some(
					(state) =>
						state.chainId !== 11155111 ||
						state.latest !== envelope.nonce ||
						state.pending !== envelope.nonce,
				)
			) {
				throw new Error("payer chain or nonce changed before broadcast");
			}
		};
		if (envelope.entry.prepared.kind === "skip-expired") {
			await checkPayer();
			dependencies.beforeSign?.(prepared.id);
			return dependencies.sendRawTransaction(envelope.raw);
		}
		const request = envelope.request;
		if (!request) {
			throw new Error("reviewed transport request is missing");
		}
		const snapshot = fresh.snapshot;
		/** Enforce the reviewed transport's exact target and calldata before revalidation and raw-envelope broadcast. */
		const send = async (target: Address, data: Hex) => {
			const expectedTo = request.kind === "safe-execution" ? request.safe : request.delay;
			const expectedData =
				request.kind === "safe-execution"
					? core.encodeSafeExecutionCalldata(request)
					: core.encodeDelayExecutionCalldata(request);
			if (!isAddressEqual(target, expectedTo) || data !== expectedData) {
				throw new Error("transport altered the signed outer call");
			}
			await revalidate(prepared);
			await checkPayer();
			dependencies.beforeSign?.(prepared.id);
			return dependencies.sendRawTransaction(envelope.raw);
		};
		const context: RelayerContext = {
			readers: {
				/** Read the first fixed provider's chain identity for reviewed transport validation. */
				chainId: async () => providers[0].getChainId(),
				/** Supply deployment evidence from the freshly verified provisioning proof. */
				deployments: async () => fresh.proof.deployments,
				/** Supply the freshly verified Safe topology to the closed submission transport. */
				topology: async () => fresh.proof.topologyReport,
				/** Supply the Safe nonce bound to the fresh dual-provider snapshot. */
				safeNonce: async () => snapshot.safeNonce,
				/** Supply the policy identity bound to the fresh dual-provider snapshot. */
				policyHash: async () => snapshot.policyHash,
				/** Supply the verified spending counters used to validate the prepared execution. */
				spendState: async () => snapshot.spendState,
				/** Require and expose the exact verified queue head for reviewed Delay execution. */
				delayItem: async () => {
					if (!snapshot.queueHead) {
						throw new Error("reviewed queue head is missing");
					}
					return {
						...snapshot.queueHead,
						txHash: snapshot.queueHead.queueFingerprint,
					};
				},
				/** Supply the verified current Delay head nonce for queue identity validation. */
				delayNonce: async () => snapshot.queueHeadNonce,
				/** Supply the verified snapshot time for Delay cooldown and expiry checks. */
				blockTimestamp: async () => snapshot.timestamp,
				/** Leave receipt completion to independent reconciliation after broadcasting. */
				receipt: async () => undefined,
			},
			broadcaster: { executeSafe: send, executeDelay: send },
		};
		const result = await core.validateAndBroadcast(request, context);
		if (result.kind !== "submitted" && result.kind !== "confirmed") {
			throw new Error(
				`reviewed submission transport rejected the current state: ${result.kind}: ${result.reason}`,
			);
		}
		if (result.transactionHash !== expectedHash) {
			throw new Error("transport returned a different transaction hash");
		}
		return result.transactionHash;
	};

	/** Locate process-local intent evidence by the exact signed outer transaction hash. */
	const entryForOuterHash = (transactionHash: Hex) =>
		[...envelopes.values()].find(
			(value) => value.hash.toLowerCase() === transactionHash.toLowerCase(),
		)?.entry;
	return Object.freeze({ deriveOuterHash, broadcast, discard, entryForOuterHash });
}
export type SubmissionExecution = ReturnType<typeof createSubmissionExecution>;
