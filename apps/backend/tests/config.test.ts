import { describe, expect, it } from "vitest";
import { loadBackendConfig } from "../src/config/config";
import { resolve } from "node:path";

const valid = {
	BACKEND_PROFILE: "local",
	BACKEND_ORIGIN: "http://localhost:5173",
	BACKEND_RP_ID: "localhost",
	BACKEND_RELAY_PRIVATE_KEY: `0x${"11".repeat(32)}`,
	BACKEND_RPC_URL: "https://sepolia.example.invalid",
	BACKEND_JOURNAL_PATH: "/tmp/tiered-spending-guard/backend-journal.json",
	BACKEND_PROVISIONING_JOURNAL_PATH: "/tmp/tiered-spending-guard/provisioning-live-journal.json",
	BACKEND_PROVISIONING_REVIEW_DIRECTORY: "/tmp/tiered-spending-guard/provisioning-reviews",
};

describe("backend configuration", () => {
	it("rejects repository descendants whose name begins with two dots", () => {
		expect(() =>
			loadBackendConfig({
				...valid,
				BACKEND_JOURNAL_PATH: resolve(
					process.cwd(),
					"../..",
					"..profile-output",
					"journal.json",
				),
			}),
		).toThrow(/outside the repository/i);
	});

	it("requires every write-boundary input", () => {
		expect(loadBackendConfig(valid)).toMatchObject({
			id: "local",
			origin: "http://localhost:5173",
			rpId: "localhost",
		});
		for (const key of Object.keys(valid).filter(
			(key) => key !== "BACKEND_ORIGIN" && key !== "BACKEND_RP_ID",
		)) {
			const env = { ...valid };
			delete env[key as keyof typeof env];
			expect(() => loadBackendConfig(env), key).toThrow(key);
		}
		expect(() =>
			loadBackendConfig({
				...valid,
				BACKEND_JOURNAL_PATH: resolve(process.cwd(), "journal.json"),
			}),
		).toThrow(/outside the repository/i);
		expect(() =>
			loadBackendConfig({
				...valid,
				BACKEND_PROVISIONING_JOURNAL_PATH: valid.BACKEND_JOURNAL_PATH,
			}),
		).toThrow(/different paths/i);
	});

	it("rejects the retired external reviewed-artifacts setting", () => {
		expect(() =>
			loadBackendConfig({
				...valid,
				BACKEND_REVIEWED_ARTIFACTS: "/tmp/reviewed-artifacts.json",
			}),
		).toThrow(/retired|remove/i);
	});

	it("rejects both retired operator approval settings", () => {
		expect(() =>
			loadBackendConfig({ ...valid, BACKEND_PROVISIONING_APPROVAL: "/tmp/approval.json" }),
		).toThrow(/retired|remove/i);
		expect(() =>
			loadBackendConfig({
				...valid,
				BACKEND_PROVISIONING_APPROVAL_HASH_FILE: "/tmp/approval.hash",
			}),
		).toThrow(/retired|remove/i);
	});

	it("requires every HTTPS identity field and rejects unsafe profile combinations", () => {
		const https = {
			...valid,
			BACKEND_PROFILE: "https",
			BACKEND_ORIGIN: "https://vault.example",
			BACKEND_RP_ID: "vault.example",
		};
		expect(loadBackendConfig(https)).toMatchObject({
			id: "https",
			origin: "https://vault.example",
			rpId: "vault.example",
		});
		for (const key of ["BACKEND_ORIGIN", "BACKEND_RP_ID"] as const) {
			const env = { ...https };
			delete env[key];
			expect(() => loadBackendConfig(env), key).toThrow(key);
		}
		expect(() =>
			loadBackendConfig({ ...https, BACKEND_ORIGIN: "https://evil.example" }),
		).toThrow(/RP ID|origin/i);
		expect(() =>
			loadBackendConfig({ ...https, BACKEND_ORIGIN: "http://vault.example" }),
		).toThrow(/HTTPS/i);
		expect(() =>
			loadBackendConfig({ ...https, BACKEND_ORIGIN: "https://user@vault.example" }),
		).toThrow();
		expect(() =>
			loadBackendConfig({
				...https,
				BACKEND_RP_ID: "192.0.2.1",
				BACKEND_ORIGIN: "https://192.0.2.1",
			}),
		).toThrow(/RP.?ID/i);
		expect(() =>
			loadBackendConfig({
				...https,
				BACKEND_RP_ID: "preview-vault.example",
				BACKEND_ORIGIN: "https://preview-vault.example",
			}),
		).toThrow(/preview/i);
		expect(() => loadBackendConfig({ ...https, BACKEND_PROFILE: "preview" })).toThrow(
			/BACKEND_PROFILE/,
		);
	});
});
