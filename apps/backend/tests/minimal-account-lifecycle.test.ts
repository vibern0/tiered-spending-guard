import { mkdtempSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadBackendConfig } from "../src/config/config";
import { AccountStore } from "../src/accounts/store";
import { createAccountServer } from "../src/http/server";

const close: (() => void)[] = [];
afterEach(() =>
	close
		.splice(0)
		.reverse()
		.forEach((fn) => fn()),
);
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "minimal-accounts-"));
	close.push(() => rmSync(root, { recursive: true, force: true }));
	const config = loadBackendConfig({
		BACKEND_DATA_DIRECTORY: root,
		BACKEND_RELAY_PRIVATE_KEY: `0x${"11".repeat(32)}`,
		BACKEND_RPC_URL: "https://unused.invalid",
	});
	return { root, config };
}
function open(config: ReturnType<typeof loadBackendConfig>) {
	const store = new AccountStore(config);
	close.push(() => store.close());
	return store;
}
const key = (role: "primary" | "secondary", n: number) => ({
	id: `${role}-${n}`,
	role,
	publicKey: Uint8Array.of(n),
	x: BigInt(n),
	y: BigInt(n + 1),
	counter: 0,
});
const projection = {
	chainId: 11155111 as const,
	safe: `0x${"11".repeat(20)}` as const,
	guard: `0x${"22".repeat(20)}` as const,
	delay: `0x${"33".repeat(20)}` as const,
	usdc: `0x${"44".repeat(20)}` as const,
	evidence: { blockNumber: "10" },
};
describe("fresh account lifecycle", () => {
	it("serves history from public vault metadata without loading a signing runtime or starving other accounts", async () => {
		const { config } = fixture(),
			store = open(config);
		const a = store.createAccount(),
			b = store.createAccount();
		store.completeCreation(a.id, projection);
		store.completeCreation(b.id, { ...projection, safe: `0x${"55".repeat(20)}` });
		const calls: string[] = [];
		const unused = async (): Promise<never> => {
			throw new Error("history must not load private runtime capabilities");
		};
		const backend = createAccountServer(
			config,
			store,
			{
				handlers: unused,
				provision: unused,
				prepare: unused,
				submit: unused,
				status: unused,
			},
			{
				history: {
					page: () => ({ items: [], observedAt: 0 }),
					scan: async (id) => {
						calls.push(id);
						if (calls.length === 1) throw new Error("one unavailable account");
					},
				},
			},
		);
		try {
			await backend.fastify.listen({ host: "127.0.0.1", port: 0 });
			await vi.waitFor(() => expect(new Set(calls)).toEqual(new Set([a.id, b.id])));
			const session = store.createSession(a.id, true),
				headers = {
					host: "localhost:" + (backend.server.address() as { port: number }).port,
					cookie: `vault_local_session=${session.token}`,
					"x-vault-account": a.id,
				};
			expect(
				(
					await backend.fastify.inject({
						method: "GET",
						url: "/v1/vaults/current/history?limit=1",
						headers,
					})
				).statusCode,
			).toBe(200);
			expect(
				(
					await backend.fastify.inject({
						method: "GET",
						url: "/v1/vaults/current/history",
						headers: { ...headers, "x-vault-account": b.id },
					})
				).statusCode,
			).toBe(403);
			for (const query of ["limit=101", "limit=0", "other=1"])
				expect(
					(
						await backend.fastify.inject({
							method: "GET",
							url: `/v1/vaults/current/history?${query}`,
							headers,
						})
					).statusCode,
				).toBe(400);
		} finally {
			await backend.close();
		}
		expect(store.historyVault(a.id)).toEqual(projection);
		expect(store.historyVault(a.id)).not.toHaveProperty("relayPrivateKey");
	});
	it("refuses an old evidence directory instead of creating an empty registry over it", () => {
		const { root, config } = fixture();
		writeFileSync(join(root, "provisioning.json"), "retained deployment evidence");
		expect(() => new AccountStore(config)).toThrow(/fresh|unexpected|incompatible/);
	});
	it("uses one external root and refuses a previous database format without erasing it", () => {
		const { root, config } = fixture();
		expect(config.accountDatabasePath).toBe(join(realpathSync(root), "accounts.sqlite"));
		const old = new DatabaseSync(config.accountDatabasePath!);
		old.exec(
			"CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('preserve'); PRAGMA user_version=1;",
		);
		old.close();
		expect(() => new AccountStore(config)).toThrow(/schema|format/);
		const retained = new DatabaseSync(config.accountDatabasePath!);
		expect(retained.prepare("SELECT value FROM retained").get()).toEqual({ value: "preserve" });
		retained.close();
	});
	it("commits second registration and job eligibility together, surviving reopen", () => {
		const { config } = fixture();
		const store = new AccountStore(config),
			account = store.createAccount();
		store.storeCredential(account.id, key("primary", 1));
		expect([...store.provisioningJobs()]).toHaveLength(0);
		expect(() => store.storeCredential(account.id, key("secondary", 1))).toThrow();
		expect(store.account(account.id)?.state).toBe("registering");
		store.storeCredential(account.id, key("secondary", 3));
		expect(store.account(account.id)?.state).toBe("queued");
		store.close();
		const next = open(config);
		expect([...next.provisioningJobs()].map((a) => a.id)).toEqual([account.id]);
		expect(next.credentials(account.id)).toHaveLength(2);
	});
	it("does not turn credential records alone into a creation grant", () => {
		const { config } = fixture();
		const store = open(config),
			account = store.createAccount();
		store.storeCredential(account.id, key("primary", 1));
		store.storeCredential(account.id, key("secondary", 3));
		store.markProvisioning(account.id, "registering");
		expect([...store.provisioningJobs()]).toHaveLength(0);
	});
	it("resumes only a committed creation job after restart without a browser session", async () => {
		const { config } = fixture();
		const first = new AccountStore(config),
			account = first.createAccount();
		first.storeCredential(account.id, key("primary", 1));
		first.storeCredential(account.id, key("secondary", 3));
		first.markProvisioning(account.id, "provisioning");
		const incomplete = first.createAccount();
		first.storeCredential(incomplete.id, key("primary", 5));
		first.close();
		const store = open(config),
			calls: string[] = [];
		const unused = async (): Promise<never> => {
			throw new Error("unexpected spending capability");
		};
		const backend = createAccountServer(config, store, {
			handlers: unused,
			provision: unused,
			prepare: unused,
			submit: unused,
			status: unused,
			runProvisioning: async (id) => {
				calls.push(id);
				store.markProvisioning(id, "verified");
			},
		});
		try {
			await backend.fastify.listen({ host: "127.0.0.1", port: 0 });
			await vi.waitFor(() => expect(calls).toEqual([account.id]), { timeout: 200 });
			expect(store.account(incomplete.id)?.state).toBe("registering");
		} finally {
			await backend.close();
		}
	});
	it("stops admitting creation jobs while draining the active operation on shutdown", async () => {
		const { config } = fixture(),
			store = open(config);
		for (const n of [1, 5]) {
			const a = store.createAccount();
			store.storeCredential(a.id, key("primary", n));
			store.storeCredential(a.id, key("secondary", n + 2));
		}
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const calls: string[] = [];
		const unused = async (): Promise<never> => {
			throw new Error("unexpected spending capability");
		};
		const backend = createAccountServer(config, store, {
			handlers: unused,
			provision: unused,
			prepare: unused,
			submit: unused,
			status: unused,
			runProvisioning: async (id) => {
				calls.push(id);
				await held;
				store.markProvisioning(id, "verified");
			},
		});
		await backend.fastify.listen({ host: "127.0.0.1", port: 0 });
		await vi.waitFor(() => expect(calls).toHaveLength(1));
		const closing = backend.close();
		release();
		await closing;
		expect(calls).toHaveLength(1);
		expect([...store.provisioningJobs()]).toHaveLength(1);
	});
});
