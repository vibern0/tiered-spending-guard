import type {
	PwaHistoricalVault,
	PwaProvisioningExecutionContext,
	PwaProvisioningPlan,
	PwaProvisioningRecovery,
	PwaProvisioningResult,
	PwaProvisioningTransaction,
} from "@tiered-spending-guard/security-core/pwa";
import * as pwaNamespace from "@tiered-spending-guard/security-core/pwa";
import { type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import type { StoredCredential } from "../auth/webauthn";

// Hardhat keeps security-core CommonJS; Node ESM exposes it under default while Vitest exposes named exports.
const pwaRuntime =
	(pwaNamespace as unknown as { default?: typeof pwaNamespace }).default ?? pwaNamespace;

const { executePwaProvisioning, provisioningPackageHash, writePwaProvisioningReview } = pwaRuntime;

export type BackendPwaProvisioningResult = Readonly<{
	chainId: 11155111;
	safe: Address;
	guard: Address;
	delay: Address;
	primaryPasskey: Address;
	secondaryPasskey: Address;
	usdc: Address;
	evidence: Readonly<{
		setupTransactionHash: Hex;
		verificationReportHash: Hex;
		deploymentsHash: Hex;
		policyHash: Hex;
		blockNumber: string;
	}>;
}>;

export type BackendPwaProvisioningCompletion = Readonly<{
	response: BackendPwaProvisioningResult;
	verified: PwaProvisioningResult;
	plan?: PwaProvisioningPlan;
}>;

export type ProvisioningCredentials = Readonly<{
	primary: StoredCredential;
	secondary: StoredCredential;
}>;

export type AutomaticPwaRecoveryPreflight = Readonly<{
	confirmedPrefixLength: number;
	nextTransactionId: PwaProvisioningTransaction["id"];
	nextTransactionNonce: string;
	packageHash: Hex;
	planHash: Hex;
	quoteBlockNumber: string;
	quoteBlockHash: Hex;
	gasEstimateA: string;
	gasEstimateB: string;
	gasLimit: string;
	maxFeePerGas: string;
	maxPriorityFeePerGas: string;
	confirmedActualCost: string;
	resultingOutlayWei: string;
	relayBalance: string;
}>;

export type AutomaticPwaProvisioner = Readonly<{
	historicalVault?: PwaHistoricalVault;
	completedRecoveryReady?: boolean;
	recoveryCredentials?: PwaProvisioningRecovery["credentials"];
	preflight?(): Promise<AutomaticPwaRecoveryPreflight>;
	provision(input?: ProvisioningCredentials): Promise<BackendPwaProvisioningCompletion>;
}>;

export type AutomaticPwaProvisionerOptions = Readonly<{
	historicalVault?: PwaHistoricalVault;
	reviewDirectory: string;
	recovery?: PwaProvisioningRecovery;
	reloadRecovery?(): Promise<PwaProvisioningRecovery | undefined>;
	createPlan(input: ProvisioningCredentials): Promise<PwaProvisioningPlan>;
	executionContext(
		plan: PwaProvisioningPlan,
	):
		| Promise<Readonly<{ context: PwaProvisioningExecutionContext; close(): void }>>
		| Readonly<{ context: PwaProvisioningExecutionContext; close(): void }>;
	preflight?(): Promise<AutomaticPwaRecoveryPreflight>;
}>;

/** Keeps authorization evidence bound to one immutable reviewed package lineage. */
export function pwaProvisioningAuthorizationPath(journalPath: string, packageHash: Hex): string {
	return `${journalPath}.authorizations.${packageHash.slice(2)}.json`;
}

function result(value: PwaProvisioningResult): BackendPwaProvisioningResult {
	return Object.freeze({
		chainId: value.chainId,
		safe: value.safe,
		guard: value.guard,
		delay: value.delay,
		primaryPasskey: value.primaryPasskey,
		secondaryPasskey: value.secondaryPasskey,
		usdc: value.usdc,
		evidence: Object.freeze({
			setupTransactionHash: value.setupReceipt.transactionHash,
			verificationReportHash: value.topologyReportHash,
			deploymentsHash: value.deploymentsHash,
			policyHash: value.policyHash,
			blockNumber: String(value.setupReceipt.blockNumber),
		}),
	});
}

function credentialIdentity(input: ProvisioningCredentials): string {
	const encode = (credential: StoredCredential) =>
		JSON.stringify([
			credential.role,
			credential.id,
			credential.x.toString(),
			credential.y.toString(),
			Buffer.from(credential.publicKey).toString("base64url"),
		]);
	return `${encode(input.primary)}:${encode(input.secondary)}`;
}

export function recoverableProvisioningFailure(error: unknown): boolean {
	const message = error instanceof Error ? error.message : "";
	return (
		/Sepolia RPC request failed|submission outcome unknown|provisioning (?:quote|relay) nonce mismatch|nonce drift before provisioning|deployer nonce does not equal/.test(
			message,
		) && !/ExecutionRevertedError|ContractFunctionRevertedError/.test(message)
	);
}

/** One backend-trusted, single-flight Sepolia provisioning operation. */
export function createAutomaticPwaProvisioner(
	options: AutomaticPwaProvisionerOptions,
): AutomaticPwaProvisioner {
	if (options.historicalVault) return historicalProvisioner(options.historicalVault);
	let boundCredentialIdentity: string | undefined;
	let preparedPlan = options.recovery?.plan;
	let recovered = options.recovery;
	let inFlight: Promise<BackendPwaProvisioningCompletion> | undefined;
	let completed: BackendPwaProvisioningCompletion | undefined;

	const provision = (
		credentials?: ProvisioningCredentials,
	): Promise<BackendPwaProvisioningCompletion> => {
		if (!preparedPlan && !credentials && !options.reloadRecovery)
			return Promise.reject(
				new Error(
					"verified primary and secondary credentials are required for fresh provisioning",
				),
			);
		if (!options.recovery && credentials) {
			const identity = credentialIdentity(credentials);
			if (boundCredentialIdentity !== undefined && identity !== boundCredentialIdentity)
				return Promise.reject(
					new Error(
						"automatic provisioning is already bound to a different credential pair",
					),
				);
			boundCredentialIdentity = identity;
		}
		if (completed) return Promise.resolve(completed);
		if (inFlight) return inFlight;

		const executeOnce = async () => {
			if (options.reloadRecovery) {
				recovered = await options.reloadRecovery();
				preparedPlan = recovered?.plan;
			}
			if (!preparedPlan && !credentials)
				throw new Error(
					"verified primary and secondary credentials are required for fresh provisioning",
				);
			if (!preparedPlan) preparedPlan = await options.createPlan(credentials!);
			const plan = preparedPlan;
			if (plan.chainId !== sepolia.id)
				throw new Error("automatic provisioning supports only Ethereum Sepolia");
			const review = writePwaProvisioningReview(plan, options.reviewDirectory);
			if (provisioningPackageHash(plan) !== review.packageHash)
				throw new Error("automatic provisioning review package changed before execution");
			const lease = await options.executionContext(plan);
			try {
				const verified = await executePwaProvisioning(plan, lease.context);
				completed = Object.freeze({ response: result(verified), verified, plan });
				return completed;
			} finally {
				lease.close();
			}
		};
		const operation = (async () => {
			for (let attempt = 0; ; attempt++) {
				try {
					return await executeOnce();
				} catch (error) {
					if (
						!options.reloadRecovery ||
						!recoverableProvisioningFailure(error) ||
						attempt >= 2
					)
						throw error;
					// Reconstruct and verify recorded progress before another attempt.
					// A durable hash is reconciled, never signed or broadcast again.
					await new Promise<void>((resolve) => setTimeout(resolve, 500));
				}
			}
		})();
		inFlight = operation;
		void operation
			.finally(() => {
				if (!completed) inFlight = undefined;
			})
			.catch(() => undefined);
		return operation;
	};

	const preflight =
		options.preflight ??
		(() =>
			Promise.reject(new Error("recovery preflight is unavailable for fresh provisioning")));
	return Object.freeze({
		preflight,
		provision,
		get recoveryCredentials() {
			return recovered?.credentials;
		},
		get completedRecoveryReady() {
			return recovered?.confirmedPrefixLength === 7;
		},
	});
}

export function historicalProvisioner(
	historicalVault: PwaHistoricalVault,
): AutomaticPwaProvisioner {
	const unavailable = () =>
		Promise.reject(
			new Error(
				"historical vault is read-only; current-profile provisioning and transfers are disabled",
			),
		);
	return Object.freeze({
		historicalVault,
		recoveryCredentials: historicalVault.credentials,
		provision: unavailable,
		preflight: unavailable,
	});
}
