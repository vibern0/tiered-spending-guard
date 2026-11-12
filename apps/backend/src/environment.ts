import { lstatSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { assertExternalBackendPath } from "./config";

const DEFAULT_ENV_PATH = fileURLToPath(new URL("../.env", import.meta.url));

/** CLI-only loading: external configuration, quiet diagnostics, shell precedence. */
export function loadBackendEnvironment(
	env: NodeJS.ProcessEnv = process.env,
	defaultPath = DEFAULT_ENV_PATH,
): void {
	const explicit = env.DOTENV_CONFIG_PATH !== undefined;
	const path = explicit ? env.DOTENV_CONFIG_PATH : defaultPath;
	try {
		try {
			lstatSync(path!);
		} catch (error) {
			if (!explicit && (error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		const external = assertExternalBackendPath(path, "backend environment file");
		const result = config({
			path: external,
			processEnv: env,
			override: false,
			quiet: true,
			debug: false,
		});
		if (result.error) throw result.error;
	} catch {
		// Filesystem and parser errors can contain private paths or configuration.
		throw new Error("backend environment file could not be loaded");
	}
}
