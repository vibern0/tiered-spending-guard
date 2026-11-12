import { loadBackendEnvironment } from "./environment";
import { loadBackendConfig } from "./config";
import { createBackendLogger } from "./logging";
import { createConfiguredBackend } from "./main";
import { sanitizeBackendMessage } from "./server";

async function run(): Promise<void> {
	loadBackendEnvironment();
	const logger = createBackendLogger({ pretty: process.env.NODE_ENV !== "production" });
	try {
		const config = loadBackendConfig();
		logger.info({ stage: "startup" }, "Starting backend; verifying saved accounts");
		await createConfiguredBackend(undefined, config, undefined, { logger });
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
