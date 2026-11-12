import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccountStore } from "../src/accounts/store";
import { createAccountServer } from "../src/http/server";
import { type AccountGateway } from "../src/accounts/types";
import { loadBackendConfig } from "../src/config/config";
import { createBackendServer } from "../src/compatibility/server";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanups.splice(0)) await close();
});

function fixture(surface: "account" | "legacy") {
	const root = mkdtempSync(join(tmpdir(), "backend-docs-"));
	const config = loadBackendConfig({
		BACKEND_PROFILE: "local",
		BACKEND_RELAY_PRIVATE_KEY: `0x${"11".repeat(32)}`,
		BACKEND_RPC_URL: "https://secret.invalid/private-token",
		BACKEND_JOURNAL_PATH: join(root, "s.json"),
		BACKEND_PROVISIONING_JOURNAL_PATH: join(root, "p.json"),
		BACKEND_PROVISIONING_REVIEW_DIRECTORY: join(root, "reviews"),
	});
	const unused = async (): Promise<never> => {
		throw new Error("documentation must not invoke runtime capabilities");
	};
	const store = surface === "account" ? new AccountStore(config) : undefined;
	const backend = store
		? createAccountServer(config, store, {
				handlers: unused,
				provision: unused,
				prepare: unused,
				submit: unused,
				status: unused,
			} satisfies AccountGateway)
		: createBackendServer(config, { autoProvisionVault: unused });
	cleanups.push(async () => {
		await backend.close();
		store?.close();
		rmSync(root, { recursive: true, force: true });
	});
	return {
		backend,
		config,
		get: (url: string, headers: Record<string, string> = {}, remoteAddress = "127.0.0.1") =>
			backend.fastify.inject({
				method: "GET",
				url,
				headers: { host: "localhost:8787", ...headers },
				remoteAddress,
			}),
	};
}

describe.each(["account", "legacy"] as const)("%s API documentation", (surface) => {
	it("serves all registered application routes with bodies, responses and security documentation", async () => {
		const { backend, get, config } = fixture(surface);
		const response = await get("/documentation/json");
		expect(response.statusCode).toBe(200);
		expect(response.headers["cache-control"]).toBe("no-store");
		expect(response.headers["x-request-id"]).toBeTruthy();
		const document = response.json();
		expect(document.openapi).toBe("3.0.3");
		expect(Object.keys(document.paths)).toHaveLength(surface === "account" ? 13 : 10);
		for (const [path, item] of Object.entries(document.paths)) {
			for (const [method, operation] of Object.entries(item as Record<string, any>)) {
				expect(
					backend.fastify.hasRoute({
						method: method.toUpperCase() as "GET" | "POST",
						url: path.replace(/\{([^}]+)\}/g, ":$1"),
					}),
				).toBe(true);
				expect(operation.summary).toBeTruthy();
				expect(operation.responses["200"].content["application/json"].schema).toBeTruthy();
				expect(operation.responses["403"]).toBeTruthy();
				if (method === "post")
					expect(operation.requestBody.content["application/json"].schema).toBeTruthy();
				if (surface === "account" && path.includes("/submissions")) {
					expect(operation.security).toEqual([{ sessionCookie: [] }]);
					expect(operation.parameters).toContainEqual(
						expect.objectContaining({ name: "x-vault-account", required: true }),
					);
				}
			}
		}
		// Compare the registered inventory in both directions: adding a route must update docs.
		for (const method of [
			"GET",
			"POST",
			"PUT",
			"PATCH",
			"DELETE",
			"HEAD",
			"OPTIONS",
		] as const) {
			const registered = backend.fastify.printRoutes({ method, commonPrefix: false });
			const actual = [...registered.matchAll(/^[├└]── (\/\S+) \(/gm)]
				.map((match) => match[1].replace(/:([^/]+)/g, "{$1}"))
				.filter((path) => !path.startsWith("/documentation"))
				.sort();
			const expected = Object.entries(document.paths)
				.filter(([, item]) => (item as Record<string, unknown>)[method.toLowerCase()])
				.map(([path]) => path)
				.sort();
			expect(actual).toEqual(expected);
		}
		expect(
			document.paths["/v1/submissions/prepare"].post.requestBody.content["application/json"]
				.schema.oneOf,
		).toHaveLength(5);
		expect(document.paths["/v1/credentials/{role}/rebind/options"] !== undefined).toBe(
			surface === "legacy",
		);
		expect(document.paths["/v1/auth/setup"] !== undefined).toBe(surface === "account");
		expect(response.body).not.toContain(config.relayPrivateKey);
		expect(response.body).not.toContain(config.rpcUrl);
		expect(response.body).not.toContain(config.journalPath);
	});

	it("serves a local Swagger UI and assets without enabling a write console", async () => {
		const { get } = fixture(surface);
		const ui = await get("/documentation/");
		expect(ui.statusCode).toBe(200);
		expect(ui.headers["content-type"]).toContain("text/html");
		expect(ui.headers["cache-control"]).toBe("no-store");
		expect(ui.body).toContain("swagger-ui");
		const script = await get("/documentation/static/swagger-initializer.js");
		expect(script.statusCode).toBe(200);
		expect(script.body).toContain('"supportedSubmitMethods":[]');
		expect(script.body).toContain('"validatorUrl":null');
		const css = await get("/documentation/static/swagger-ui.css");
		expect(css.statusCode).toBe(200);
		expect(css.headers["cache-control"]).toBe("no-store");
	});

	it("retains Origin and loopback checks for specs and static assets", async () => {
		const { get } = fixture(surface);
		for (const path of [
			"/documentation/",
			"/documentation/json",
			"/documentation/static/swagger-ui.css",
		]) {
			expect((await get(path, { origin: "https://attacker.invalid" })).statusCode).toBe(403);
			expect((await get(path, {}, "203.0.113.1")).statusCode).toBe(403);
			if (surface === "account")
				expect((await get(path, { host: "attacker.invalid" })).statusCode).toBe(403);
		}
	});
});
