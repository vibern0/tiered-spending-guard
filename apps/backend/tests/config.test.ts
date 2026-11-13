import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { loadBackendConfig } from "../src/config/config";
const valid = {
	BACKEND_RELAY_PRIVATE_KEY: `0x${"11".repeat(32)}`,
	BACKEND_RPC_URL: "https://sepolia.example.invalid",
	BACKEND_DATA_DIRECTORY: "/tmp/minimal-vault-data",
};
describe("local backend configuration", () => {
	it("derives separate account evidence paths from one external root", () => {
		const c = loadBackendConfig(valid);
		expect(c).toMatchObject({
			id: "local",
			origin: "http://localhost:5173",
			rpId: "localhost",
			host: "127.0.0.1",
		});
		expect(c.journalPath).not.toBe(c.provisioningJournalPath);
		for (const key of Object.keys(valid)) {
			const env = { ...valid };
			delete env[key as keyof typeof env];
			expect(() => loadBackendConfig(env)).toThrow(key);
		}
	});
	it("rejects repository/symlink escapes, nonlocal profiles and invalid boundary identity", () => {
		for (const root of [
			resolve(process.cwd(), "journal"),
			resolve(process.cwd(), "../..", "..profile-output"),
		])
			expect(() => loadBackendConfig({ ...valid, BACKEND_DATA_DIRECTORY: root })).toThrow(
				/outside the repository/,
			);
		expect(() => loadBackendConfig({ ...valid, BACKEND_PROFILE: "https" })).toThrow(
			/only local/,
		);
		expect(() =>
			loadBackendConfig({ ...valid, BACKEND_ORIGIN: "http://127.0.0.1:5173" }),
		).toThrow();
		expect(() => loadBackendConfig({ ...valid, BACKEND_RP_ID: "evil.example" })).toThrow();
		expect(() => loadBackendConfig({ ...valid, BACKEND_PORT: "0" })).toThrow();
	});
});
