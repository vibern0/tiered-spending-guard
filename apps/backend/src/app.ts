import { existsSync } from "node:fs";
import { createAccountGateway } from "./accounts/runtime";
import { AccountStore } from "./accounts/store";
import { createBackendServer, type BackendServer } from "./compatibility/server";
import { loadBackendConfig } from "./config/config";
import { createAccountServer } from "./http/server";
import { type BackendServerOptions } from "./http/types";
import { createConfiguredAutomaticPwaProvisioner } from "./provisioning/runtime";
import { type AutomaticPwaProvisioner } from "./provisioning/service";
import { SubmissionJournal } from "./submissions/journal";
import { createConfiguredSubmissionRuntime } from "./submissions/runtime";
import { PwaSubmissionService, SEPOLIA_USDC_ADDRESS } from "./submissions/service";
import type { ConfiguredSubmissionRuntime } from "./submissions/types";
import { type BackendPreparedSubmission } from "./submissions/types";
import { createBackendHandlers } from "./vaults/service";

export async function startBackend(
	config: Parameters<typeof createBackendServer>[0],
	handlers: Parameters<typeof createBackendServer>[1],
	options: BackendServerOptions = {},
): Promise<BackendServer> {
	const backend = createBackendServer(config, handlers, options);
	await backend.fastify.listen({ port: config.port, host: config.host });
	return backend;
}

/** Historical single-vault injection is restricted to the local test harness. */
async function createSingleVaultTestBackend(
	provisioner?: AutomaticPwaProvisioner,
	configured?: ReturnType<typeof loadBackendConfig>,
	submissionRuntime?: ConfiguredSubmissionRuntime,
	options: BackendServerOptions = {},
): Promise<BackendServer> {
	if (process.env.NODE_ENV !== "test") throw new Error("single-vault test backend is disabled");
	const config = configured ?? loadBackendConfig();
	const configuredProvisioner: AutomaticPwaProvisioner =
		provisioner ??
		(config.id === "local"
			? await createConfiguredAutomaticPwaProvisioner(config)
			: Object.freeze({
					provision: () =>
						Promise.reject(
							new Error(
								"automatic PWA provisioning is unavailable outside BACKEND_PROFILE=local",
							),
						),
				}));
	// Late-bound: runtime callbacks capture handlers before their construction.
	// eslint-disable-next-line prefer-const
	let handlers: ReturnType<typeof createBackendHandlers>;
	const runtime = configuredProvisioner.historicalVault
		? undefined
		: (submissionRuntime ??
			(config.id === "local"
				? createConfiguredSubmissionRuntime(config, () => handlers?.vaultRecord())
				: undefined));
	const service = runtime
		? new PwaSubmissionService({
				journal: new SubmissionJournal(config.journalPath),
				revalidate: runtime.revalidate,
				deriveOuterHash: runtime.deriveOuterHash,
				broadcast: runtime.broadcast,
				reconcile: runtime.reconcile,
				...(runtime.discard ? { discard: runtime.discard } : {}),
				verifyApproval: async (role, prepared: BackendPreparedSubmission, assertion) => {
					if (!prepared.safeTxHash)
						throw new Error("signed submission is missing its Safe transaction hash");
					const verified = await handlers.verifyApproval(prepared.safeTxHash, {
						role,
						assertion,
					});
					return Object.freeze({ role, payload: verified.payload });
				},
			})
		: undefined;
	handlers = createBackendHandlers({
		config,
		usdc: SEPOLIA_USDC_ADDRESS,
		provisioner: configuredProvisioner,
		...(service && runtime
			? {
					prepareTransfer: async (input) => service.prepare(await runtime.prepare(input)),
					submit: async ({ id, body }) => service.submit(id, body as never),
					submission: async ({ id }) => service.status(id),
				}
			: {}),
	});
	// Only a fully verified seven-receipt recovery may hydrate an account at
	// startup. Its executor has no missing transaction and cannot broadcast.
	if (!configuredProvisioner.historicalVault && configuredProvisioner.completedRecoveryReady)
		await handlers.autoProvisionVault({});
	return startBackend(config, handlers, options);
}

export async function createConfiguredBackend(
	provisioner?: AutomaticPwaProvisioner,
	configured?: ReturnType<typeof loadBackendConfig>,
	submissionRuntime?: ConfiguredSubmissionRuntime,
	options: BackendServerOptions = {},
): Promise<Pick<BackendServer, "server" | "close">> {
	if (provisioner || submissionRuntime)
		return createSingleVaultTestBackend(provisioner, configured, submissionRuntime, options);
	const config = configured ?? loadBackendConfig();
	if (config.id !== "local")
		return startBackend(
			config,
			{
				getReadiness: () => ({ provisioningReady: false, writesReady: false }),
				autoProvisionVault: () =>
					Promise.reject(new Error("automatic provisioning is localhost-only")),
			},
			options,
		);
	const store = new AccountStore(config);
	try {
		const gateway = createAccountGateway(config, store);
		if (existsSync(config.provisioningJournalPath) || existsSync(config.journalPath)) {
			const legacy = store.adoptLegacy();
			// Retain the existing fail-closed startup verification of configured legacy
			// evidence. New accounts are loaded lazily and never replace these paths.
			await gateway.handlers(legacy.id);
		}
		const backend = createAccountServer(config, store, gateway, options);
		await backend.fastify.listen({ port: config.port, host: config.host });
		return {
			server: backend.server,
			close: async () => {
				await backend.close();
				store.close();
			},
		};
	} catch (error) {
		store.close();
		throw error;
	}
}
