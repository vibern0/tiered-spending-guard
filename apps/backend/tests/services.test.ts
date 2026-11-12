import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AccountStore } from "../src/accounts/store";
import { loadBackendConfig } from "../src/config/config";
import { AccountService } from "../src/accounts/service";

function storeFixture() {
	const root = mkdtempSync(join(tmpdir(), "vault-services-"));
	const config = loadBackendConfig({
		BACKEND_PROFILE: "local",
		BACKEND_RELAY_PRIVATE_KEY: `0x${"11".repeat(32)}`,
		BACKEND_RPC_URL: "https://unused.invalid",
		BACKEND_JOURNAL_PATH: join(root, "submissions.json"),
		BACKEND_PROVISIONING_JOURNAL_PATH: join(root, "provisioning.json"),
		BACKEND_PROVISIONING_REVIEW_DIRECTORY: join(root, "reviews"),
	});
	return new AccountStore(config);
}

describe("backend services", () => {
	it("creates one unprivileged account session and projects its public metadata", async () => {
		const store = storeFixture();
		try {
			const service = new AccountService(store, {
				handlers: async () => {
					throw new Error("unverified account must not load runtime handlers");
				},
				submissionIds: async () => {
					throw new Error("unauthenticated account must not list submissions");
				},
			});

			const created = service.create();
			const projection = await service.project(created);

			expect(created.authenticated).toBe(false);
			expect(projection).toEqual({
				authenticated: false,
				csrfToken: created.csrfToken,
				account: {
					id: created.accountId,
					userHandle: store.account(created.accountId!)!.userHandle,
					state: "registering",
				},
			});
			expect([...store.accounts()]).toHaveLength(1);
		} finally {
			store.close();
		}
	});
});
