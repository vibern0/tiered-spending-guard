import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import type { BackendConfig } from "../config/config";
import type { BackendVaultRecord } from "../vaults/types";
import type {
	ConfiguredSubmissionRuntime,
	SubmissionEntry,
	SubmissionRuntimeDependencies as Dependencies,
} from "./types";
import { sanitizeRpc } from "../chain/read-client";
import { loadEvidenceAccess } from "../chain/evidence-access";
import { createSubmissionReadClient } from "./read-client";
import { createSubmissionPreparation } from "./prepare";
import { createSubmissionExecution } from "./execute";
import { createSubmissionReconciliation } from "./reconcile";

export { createSubmissionReadClient } from "./read-client";

function compose(
	config: BackendConfig,
	dependencies: Dependencies,
	currentVault?: () => BackendVaultRecord | undefined,
): ConfiguredSubmissionRuntime {
	if (config.id !== "local" || config.chainId !== 11155111)
		throw new Error("configured PWA submissions require the local Sepolia profile");
	const { providers } = dependencies;
	if (providers[0].source === providers[1].source)
		throw new Error("two distinct fixed submission providers are required");
	const entries = new Map<string, SubmissionEntry>();
	const preparation = createSubmissionPreparation(providers, entries);
	const execution = createSubmissionExecution(
		{
			relayPrivateKey: config.relayPrivateKey,
			journalPath: config.journalPath,
			provisioningJournalPath: config.provisioningJournalPath,
		},
		dependencies,
		{
			entryFor: preparation.entryFor,
			revalidatedSnapshot: preparation.revalidatedSnapshot,
			revalidate: preparation.revalidate,
		},
	);
	const reconcile = createSubmissionReconciliation(
		config.journalPath,
		providers,
		entries,
		{ stateAt: preparation.stateAt, snapshotAt: preparation.snapshotAt },
		{ discard: execution.discard, entryForOuterHash: execution.entryForOuterHash },
		currentVault,
	);
	return Object.freeze({
		prepare: preparation.prepare,
		revalidate: preparation.revalidate,
		deriveOuterHash: execution.deriveOuterHash,
		broadcast: execution.broadcast,
		reconcile,
		discard: execution.discard,
	});
}

export function createConfiguredSubmissionRuntime(
	config: BackendConfig,
	currentVault?: () => BackendVaultRecord | undefined,
	beforeSign?: (submissionId: string) => void,
): ConfiguredSubmissionRuntime {
	const access = loadEvidenceAccess(config.evidenceConfigPath);
	const providers = [
		createSubmissionReadClient(access.urls[0], access.operators[0]),
		createSubmissionReadClient(access.urls[1], access.operators[1]),
	] as const;
	const relay = createSubmissionReadClient(config.rpcUrl, "submission relay");
	const client = createPublicClient({ chain: sepolia, transport: http(config.rpcUrl) });
	return compose(
		config,
		{
			providers,
			relay,
			beforeSign,
			sendRawTransaction: (serializedTransaction) =>
				sanitizeRpc("submission relay", "sendRawTransaction", () =>
					client.sendRawTransaction({ serializedTransaction }),
				),
		},
		currentVault,
	);
}

export function createSubmissionRuntimeForTestsOnly(
	config: BackendConfig,
	dependencies: Dependencies,
	currentVault?: () => BackendVaultRecord | undefined,
): ConfiguredSubmissionRuntime {
	if (process.env.NODE_ENV !== "test")
		throw new Error("test-only submission dependencies are disabled");
	return compose(config, dependencies, currentVault);
}
