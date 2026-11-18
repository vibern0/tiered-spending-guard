import { loadBackendEnvironment } from "./config/environment";
import { loadBackendConfig } from "./config/config";
import { createBackendLogger } from "./logging";
import { createConfiguredBackend } from "./app";
import { sanitizeBackendMessage } from "./http/errors";

/**
 * Load external configuration, start the local server, and drain owned resources on termination.
 * Startup failures set a failing exit code and log only a sanitized diagnostic.
 */
async function run(): Promise<void> {
	loadBackendEnvironment();
	const logger = createBackendLogger({ pretty: process.env.NODE_ENV !== "production" });
	try {
		const config = loadBackendConfig();
		logger.info({ stage: "startup" }, "Starting backend; verifying saved accounts");
		const backend = await createConfiguredBackend(config, { logger });
		for (const signal of ["SIGINT", "SIGTERM"] as const) {
			process.once(signal, () => {
				void backend.close().catch(() => {
					process.exitCode = 1;
				});
			});
		}
	} catch (error) {
		process.exitCode = 1;
		logger.error(
			{ code: "backend_startup_failed", stage: "startup" },
			sanitizeBackendMessage(error),
		);
	}
}

void run().catch((error: unknown) => {
	process.exitCode = 1;
	createBackendLogger().error(
		{ code: "backend_startup_failed", stage: "startup" },
		sanitizeBackendMessage(error),
	);
});
