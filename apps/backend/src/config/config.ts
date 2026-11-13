import { existsSync, realpathSync } from "node:fs";
import { dirname, basename, resolve, relative, isAbsolute, sep, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = realpathSync(
	resolve(dirname(fileURLToPath(import.meta.url)), "../../../.."),
);

export type BackendConfig = Readonly<{
	id: "local";
	host: "127.0.0.1";
	port: number;
	chainId: 11155111;
	rpId: string;
	origin: string;
	rpcUrl: string;
	evidenceConfigPath?: string;
	relayPrivateKey: `0x${string}`;
	dataRoot: string;
	accountDatabasePath: string;
	journalPath: string;
	provisioningJournalPath: string;
	provisioningReviewDirectory: string;
}>;

export type BackendEnvironment = Readonly<Record<string, string | undefined>>;

export function assertExternalBackendPath(value: string | undefined, label: string): string {
	if (!value || !isAbsolute(value))
		throw new Error(`${label} must be an absolute path outside the repository`);
	const parts: string[] = [];
	let existing = resolve(value);
	while (!existsSync(existing)) {
		const parent = dirname(existing);
		if (parent === existing) break;
		parts.unshift(basename(existing));
		existing = parent;
	}
	const target = resolve(realpathSync(existing), ...parts);
	const fromRepository = relative(REPOSITORY_ROOT, target);
	if (
		fromRepository === "" ||
		(fromRepository !== ".." &&
			!fromRepository.startsWith(`..${sep}`) &&
			!isAbsolute(fromRepository))
	)
		throw new Error(`${label} must point outside the repository`);
	return target;
}

export function assertBackendWebAuthnIdentity(id: string, origin: string, rpId: string): void {
	if (id !== "local" || origin !== "http://localhost:5173" || rpId !== "localhost")
		throw new Error(
			"local BACKEND_ORIGIN and BACKEND_RP_ID must use the fixed localhost profile",
		);
}

export function loadBackendConfig(env: BackendEnvironment = process.env): BackendConfig {
	if (env.BACKEND_PROFILE !== undefined && env.BACKEND_PROFILE !== "local")
		throw new Error("BACKEND_PROFILE supports only local");
	const relayPrivateKey = env.BACKEND_RELAY_PRIVATE_KEY;
	if (!relayPrivateKey || !/^0x[0-9a-fA-F]{64}$/.test(relayPrivateKey))
		throw new Error("BACKEND_RELAY_PRIVATE_KEY is required and must be a local secret");
	const rpcUrl = env.BACKEND_RPC_URL;
	if (!rpcUrl || !/^https?:\/\//.test(rpcUrl)) throw new Error("BACKEND_RPC_URL is required");
	const port = Number(env.BACKEND_PORT ?? "8787");
	if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
		throw new Error("BACKEND_PORT is invalid");
	const origin = env.BACKEND_ORIGIN ?? "http://localhost:5173";
	const rpId = env.BACKEND_RP_ID ?? "localhost";
	assertBackendWebAuthnIdentity("local", origin, rpId);
	const dataRoot = assertExternalBackendPath(
		env.BACKEND_DATA_DIRECTORY,
		"BACKEND_DATA_DIRECTORY",
	);
	const evidenceConfigPath =
		env.BACKEND_EVIDENCE_CONFIG_PATH === undefined
			? undefined
			: assertExternalBackendPath(
					env.BACKEND_EVIDENCE_CONFIG_PATH,
					"BACKEND_EVIDENCE_CONFIG_PATH",
				);
	return Object.freeze({
		id: "local",
		host: "127.0.0.1",
		port,
		chainId: 11155111,
		origin,
		rpId,
		rpcUrl,
		relayPrivateKey: relayPrivateKey as `0x${string}`,
		dataRoot,
		accountDatabasePath: join(dataRoot, "accounts.sqlite"),
		journalPath: join(dataRoot, "submissions.json"),
		provisioningJournalPath: join(dataRoot, "provisioning.json"),
		provisioningReviewDirectory: join(dataRoot, "reviews"),
		...(evidenceConfigPath ? { evidenceConfigPath } : {}),
	});
}

export function isLoopbackAddress(value: string | undefined): boolean {
	return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}
