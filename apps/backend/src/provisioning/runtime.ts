import type {
	PwaProvisioningPlan,
	PwaProvisioningRecovery,
	PwaProvisioningTransaction,
} from "@tiered-spending-guard/security-core/pwa";
import * as pwaNamespace from "@tiered-spending-guard/security-core/pwa";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { loadEvidenceAccess } from "../chain/evidence-access";
import { createReadClient } from "../chain/read-client";
import { createRelayClient } from "../chain/relay-client";
import type { BackendConfig } from "../config/config";
import { recoverAutomaticPwaProvisioning } from "./recovery";
import { historicalProvisioner, recoverableProvisioningFailure } from "./service";

import {
	createAutomaticPwaProvisioner,
	pwaProvisioningAuthorizationPath,
	type AutomaticPwaProvisioner,
} from "./service";

// Hardhat keeps security-core CommonJS; Node ESM exposes it under default while Vitest exposes named exports.
const pwaRuntime =
	(pwaNamespace as unknown as { default?: typeof pwaNamespace }).default ?? pwaNamespace;

const {
	assertPwaProvisioningTransactionAuthorization,
	collectPwaProvisioningQuote,
	createLocalPhaseOneProvisioningAuthorizer,
	createPwaProvisioningAuthorizationStore,
	createPwaProvisioningRuntime,
	loadCommittedPwaPhaseOneProfile,
	loadCommittedPwaProvisioningAutomationPolicy,
	provisioningPackageHash,
	readLiveJournal,
	resolvePwaProvisioningPlan,
} = pwaRuntime;

type AutomaticDependencies = Readonly<{
	providers: readonly [ReturnType<typeof createReadClient>, ReturnType<typeof createReadClient>];
	relay: Omit<ReturnType<typeof createRelayClient>, "getTransactionCount" | "getBlock"> &
		Pick<ReturnType<typeof createReadClient>, "getTransactionCount" | "getBlock">;
}>;

/** Concrete local Sepolia composition. Phase One authorization is not independent. */
export function createConfiguredAutomaticPwaProvisioner(
	config: BackendConfig,
): Promise<AutomaticPwaProvisioner> {
	const access = loadEvidenceAccess(config.evidenceConfigPath);
	return composeAutomaticPwaProvisioner(config, {
		providers: [
			createReadClient(access.urls[0], access.operators[0], {
				batch: true,
				source: access.operators[0],
			}),
			createReadClient(access.urls[1], access.operators[1], {
				batch: true,
				source: access.operators[1],
			}),
		],
		relay: createRelayClient(config.rpcUrl),
	});
}

export function createConfiguredAutomaticPwaProvisionerForTestsOnly(
	config: BackendConfig,
	dependencies: AutomaticDependencies,
): Promise<AutomaticPwaProvisioner> {
	if (process.env.NODE_ENV !== "test")
		throw new Error("test-only automatic provisioning dependencies are disabled");
	return composeAutomaticPwaProvisioner(config, dependencies);
}

async function composeAutomaticPwaProvisioner(
	config: BackendConfig,
	{ providers, relay }: AutomaticDependencies,
): Promise<AutomaticPwaProvisioner> {
	if (config.id !== "local")
		throw new Error("automatic PWA provisioning is available only for BACKEND_PROFILE=local");
	const profile = loadCommittedPwaPhaseOneProfile();
	const policy = loadCommittedPwaProvisioningAutomationPolicy();
	const authorizer = createLocalPhaseOneProvisioningAuthorizer(policy);
	const account = privateKeyToAccount(config.relayPrivateKey);
	let recovery: PwaProvisioningRecovery | undefined;
	const recover = (waitForPending = false) =>
		recoverAutomaticPwaProvisioning({
			config,
			deployer: account.address,
			profile,
			safeProxySaltNonce: policy.safeProxySaltNonce,
			providers,
			relay,
			waitForPending,
		});
	try {
		let restored: Awaited<ReturnType<typeof recover>> | undefined;
		for (let attempt = 0; ; attempt++) {
			try {
				restored = await recover();
				break;
			} catch (error) {
				if (!recoverableProvisioningFailure(error) || attempt >= 2) throw error;
				await new Promise<void>((resolve) => setTimeout(resolve, 500));
			}
		}
		if (restored.historicalVault) return historicalProvisioner(restored.historicalVault);
		recovery = restored.recovery;
	} catch (error) {
		const detail =
			error instanceof Error &&
			error.message.startsWith("fail closed: PWA provisioning recovery ")
				? `: ${error.message}`
				: "";
		throw new Error(`automatic provisioning recovery validation failed closed${detail}`);
	}

	const assertRelayQuoteAnchor = async (
		plan: PwaProvisioningPlan,
		transaction: PwaProvisioningTransaction,
		quote: Awaited<ReturnType<typeof collectPwaProvisioningQuote>>,
	) => {
		const [block, latest, pending] = await Promise.all([
			relay.getBlock({ blockNumber: quote.blockNumber }),
			relay.getTransactionCount({ address: plan.deployer, blockTag: "latest" }),
			relay.getTransactionCount({ address: plan.deployer, blockTag: "pending" }),
		]);
		if (
			block.number !== quote.blockNumber ||
			block.hash?.toLowerCase() !== quote.blockHash.toLowerCase()
		)
			throw new Error(
				"fail closed: relay quote block changed before provisioning authorization",
			);
		if (BigInt(latest) !== transaction.nonce || BigInt(pending) !== transaction.nonce)
			throw new Error(
				"fail closed: relay latest/pending nonce changed before provisioning authorization",
			);
	};

	const authorizeNext = async (
		plan: PwaProvisioningPlan,
		transaction: PwaProvisioningTransaction,
	) => {
		const quote = await collectPwaProvisioningQuote({
			transaction,
			deployer: plan.deployer,
			providers,
			relay,
			policy,
		});
		const journal = readLiveJournal(config.provisioningJournalPath, plan.deployer);
		const confirmedActualCost = journal.entries
			.filter((entry: { status: string }) => entry.status === "success")
			.reduce((total: bigint, entry: { reserved: bigint }) => total + entry.reserved, 0n);
		const pendingReservation = journal.entries
			.filter((entry: { status: string }) => entry.status === "pending")
			.reduce((total: bigint, entry: { reserved: bigint }) => total + entry.reserved, 0n);
		const relayBalance = await relay.getBalance({ address: plan.deployer });
		await assertRelayQuoteAnchor(plan, transaction, quote);
		const authorization = await authorizer.authorizeTransaction(plan, transaction, quote, {
			chainId: plan.chainId,
			deployer: plan.deployer,
			deployerNonce: transaction.nonce,
			packageHash: provisioningPackageHash(plan),
			planHash: plan.planHash,
			confirmedActualCost,
			pendingReservation,
			relayBalance,
			authorizedAt: new Date().toISOString(),
		});
		return Object.freeze({ quote, authorization, confirmedActualCost, relayBalance });
	};

	return createAutomaticPwaProvisioner({
		reviewDirectory: config.provisioningReviewDirectory,
		recovery,
		async reloadRecovery() {
			const restored = await recover(true);
			if (restored.pending)
				throw new Error(
					"automatic provisioning is still awaiting canonical confirmations for its recorded transaction",
				);
			if (restored.historicalVault) throw new Error("historical vault is read-only");
			recovery = restored.recovery;
			return recovery;
		},
		async preflight() {
			if (!recovery)
				throw new Error("recovery preflight requires a confirmed provisioning prefix");
			const transaction = recovery.plan.transactions[recovery.confirmedPrefixLength];
			if (!transaction) throw new Error("recovery has no missing provisioning transaction");
			const facts = await authorizeNext(recovery.plan, transaction);
			return Object.freeze({
				confirmedPrefixLength: recovery.confirmedPrefixLength,
				nextTransactionId: transaction.id,
				nextTransactionNonce: transaction.nonce.toString(),
				packageHash: provisioningPackageHash(recovery.plan),
				planHash: recovery.plan.planHash,
				quoteBlockNumber: facts.quote.blockNumber.toString(),
				quoteBlockHash: facts.quote.blockHash,
				gasEstimateA: facts.quote.estimates[0].toString(),
				gasEstimateB: facts.quote.estimates[1].toString(),
				gasLimit: facts.authorization.gasLimit,
				maxFeePerGas: facts.authorization.maxFeePerGas,
				maxPriorityFeePerGas: facts.authorization.maxPriorityFeePerGas,
				confirmedActualCost: facts.confirmedActualCost.toString(),
				resultingOutlayWei: facts.authorization.resultingOutlayWei,
				relayBalance: facts.relayBalance.toString(),
			});
		},
		async createPlan({ primary, secondary }) {
			const expectedDeployerNonce = BigInt(
				await relay.getTransactionCount({ address: account.address, blockTag: "latest" }),
			);
			return resolvePwaProvisioningPlan({
				profile,
				deployer: account.address,
				expectedDeployerNonce,
				safeProxySaltNonce: policy.safeProxySaltNonce,
				primaryCredential: { x: primary.x, y: primary.y },
				secondaryCredential: { x: secondary.x, y: secondary.y },
				client: relay,
			});
		},
		executionContext(plan) {
			const packageHash = provisioningPackageHash(plan);
			let authorizationStore:
				ReturnType<typeof createPwaProvisioningAuthorizationStore> | undefined;
			try {
				const runtime = createPwaProvisioningRuntime({
					plan,
					journalPath: config.provisioningJournalPath,
					account,
					client: relay,
					async authorize(transaction: PwaProvisioningTransaction) {
						// Completed restoration never opens an authorization writer. Acquire
						// only when the exact missing deployment transaction needs approval.
						authorizationStore ??= createPwaProvisioningAuthorizationStore(
							pwaProvisioningAuthorizationPath(
								config.provisioningJournalPath,
								packageHash,
							),
							{
								chainId: sepolia.id,
								deployer: plan.deployer,
								packageHash,
								planHash: plan.planHash,
							},
						);
						const facts = await authorizeNext(plan, transaction);
						const verified = assertPwaProvisioningTransactionAuthorization(
							plan,
							facts.authorization,
						);
						authorizationStore.append(verified);
						await assertRelayQuoteAnchor(plan, transaction, facts.quote);
						return Object.freeze({
							...transaction,
							gasLimit: BigInt(verified.gasLimit),
							maxFeePerGas: BigInt(verified.maxFeePerGas),
							maxPriorityFeePerGas: BigInt(verified.maxPriorityFeePerGas),
						});
					},
				});
				return Object.freeze({
					context: runtime.context,
					close: () => {
						try {
							runtime.close();
						} finally {
							authorizationStore?.close();
						}
					},
				});
			} catch (error) {
				authorizationStore?.close();
				throw error;
			}
		},
	});
}
