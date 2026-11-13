import { readFileSync, statSync } from "node:fs";
import { assertExternalBackendPath } from "../config/config";
export type EvidenceAccess = Readonly<{
	urls: readonly [string, string];
	operators: readonly ["infura", "alchemy"];
}>;
/** Trusted external access config; signed deployment/profile commitments remain unchanged. */
export function loadEvidenceAccess(configPath?: string): EvidenceAccess {
	try {
		const path = assertExternalBackendPath(configPath, "evidence access configuration");
		const stat = statSync(path);
		if (!stat.isFile() || stat.size > 16384 || (stat.mode & 0o077) !== 0) throw new Error();
		const value = JSON.parse(readFileSync(path, "utf8"));
		if (
			!value ||
			Object.keys(value).sort().join() !== "alchemyUrl,infuraUrl,version" ||
			value.version !== 2
		)
			throw new Error();
		const checked = (input: unknown, host: string, pattern: RegExp) => {
			if (typeof input !== "string") throw new Error();
			const url = new URL(input);
			if (
				url.href !== input ||
				url.protocol !== "https:" ||
				url.hostname !== host ||
				url.port ||
				url.username ||
				url.password ||
				url.search ||
				url.hash ||
				!pattern.test(url.pathname)
			)
				throw new Error();
			return url.href;
		};
		return Object.freeze({
			urls: Object.freeze([
				checked(value.infuraUrl, "sepolia.infura.io", /^\/v3\/[a-fA-F0-9]{32}$/),
				checked(
					value.alchemyUrl,
					"eth-sepolia.g.alchemy.com",
					/^\/v2\/[A-Za-z0-9_-]{1,128}$/,
				),
			] as const),
			operators: Object.freeze(["infura", "alchemy"] as const),
		});
	} catch {
		throw new Error("evidence access configuration failed closed");
	}
}
