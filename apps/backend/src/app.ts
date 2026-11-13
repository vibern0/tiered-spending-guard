import { createAccountGateway } from "./accounts/runtime";
import { AccountStore } from "./accounts/store";
import { loadBackendConfig } from "./config/config";
import { createAccountServer } from "./http/server";
import type { BackendServerOptions } from "./http/types";
import { loadEvidenceAccess } from "./chain/evidence-access";
import { VaultHistory } from "./history/service";
import { createHistoryReadClient } from "./history/read-client";

/** One local account application. Importing this module never reads secrets or starts work. */
export async function createConfiguredBackend(
	config = loadBackendConfig(),
	options: BackendServerOptions = {},
) {
	const store = new AccountStore(config);
	let history: VaultHistory | undefined;
	try {
		const access = loadEvidenceAccess(config.evidenceConfigPath);
		history = new VaultHistory({
			databasePath: store.databasePath,
			clients: [
				createHistoryReadClient(access.urls[0], access.operators[0]),
				createHistoryReadClient(access.urls[1], access.operators[1]),
			],
		});
		const backend = createAccountServer(config, store, createAccountGateway(config, store), {
			...options,
			history,
		});
		await backend.fastify.listen({ port: config.port, host: config.host });
		let closing: Promise<void> | undefined;
		return {
			server: backend.server,
			close: () =>
				(closing ??= (async () => {
					await backend.close();
					history!.close();
					store.close();
				})()),
		};
	} catch (error) {
		history?.close();
		store.close();
		throw error;
	}
}
