import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccountStore } from "../src/accounts/store";
import { createAccountServer } from "../src/http/server";
import { type AccountGateway } from "../src/accounts/types";
import { loadBackendConfig } from "../src/config/config";
import { createBackendFastify } from "../src/http/fastify";
import { registerBackendDocumentation } from "../src/http/documentation";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanups.splice(0)) await close();
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "backend-docs-"));
	const config = loadBackendConfig({
		BACKEND_PROFILE: "local",
		BACKEND_RELAY_PRIVATE_KEY: `0x${"11".repeat(32)}`,
		BACKEND_RPC_URL: "https://secret.invalid/private-token",
		BACKEND_DATA_DIRECTORY: root,
	});
	const unused = async (): Promise<never> => {
		throw new Error("documentation must not invoke runtime capabilities");
	};
	const store = new AccountStore(config);
	const backend = createAccountServer(config, store, {
		handlers: unused,
		provision: unused,
		prepare: unused,
		submit: unused,
		status: unused,
	} satisfies AccountGateway);
	cleanups.push(async () => {
		await backend.close();
		store.close();
		rmSync(root, { recursive: true, force: true });
	});
	return {
		backend,
		config,
		store,
		get: (url: string, headers: Record<string, string> = {}, remoteAddress = "127.0.0.1") =>
			backend.fastify.inject({
				method: "GET",
				url,
				headers: { host: "localhost:8787", ...headers },
				remoteAddress,
			}),
	};
}

describe("local account API documentation", () => {
	it("generates documentation from registered route schemas without an endpoint inventory", async () => {
		const fastify = createBackendFastify({});
		cleanups.push(() => fastify.close());
		registerBackendDocumentation(fastify);
		fastify.register(async (routes) => {
			routes.post(
				"/new-route",
				{
					schema: {
						summary: "New runtime route",
						body: { type: "object", properties: {}, additionalProperties: false },
						response: {
							200: { type: "object", properties: { amount: { type: "string" } } },
						},
					},
				},
				async () => ({ amount: 2n, retained: "public response field" }),
			);
		});
		const document = (await fastify.inject("/documentation/json")).json();
		expect(document.paths["/new-route"].post.summary).toBe("New runtime route");
		expect(document.paths["/v1/auth/setup"]).toBeUndefined();
		const response = await fastify.inject({ method: "POST", url: "/new-route", payload: {} });
		expect(response.json()).toEqual({ amount: "2n", retained: "public response field" });
	});

	it("serves registered account routes with their request and security schemas", async () => {
		const { backend, get, config } = fixture();
		const response = await get("/documentation/json");
		expect(response.statusCode).toBe(200);
		expect(response.headers["cache-control"]).toBe("no-store");
		expect(response.headers["x-request-id"]).toBeTruthy();
		const document = response.json();
		expect(document.openapi).toBe("3.0.3");
		for (const [path, item] of Object.entries(document.paths)) {
			for (const [method, operation] of Object.entries(item as Record<string, any>)) {
				expect(
					backend.fastify.hasRoute({
						method: method.toUpperCase() as "GET" | "POST",
						url: path.replace(/\{([^}]+)\}/g, ":$1"),
					}),
				).toBe(true);
				expect(operation.summary).toBeTruthy();
				expect(
					operation.responses[path.endsWith("auto-provision") ? "202" : "200"].content[
						"application/json"
					].schema,
				).toBeTruthy();
				expect(operation.responses["403"]).toBeTruthy();
				if (method === "post")
					expect(operation.requestBody.content["application/json"].schema).toBeTruthy();
				if (path.includes("/submissions")) {
					expect(operation.security).toEqual([{ sessionCookie: [] }]);
					expect(operation.parameters).toContainEqual(
						expect.objectContaining({ name: "x-vault-account", required: true }),
					);
				}
			}
		}
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
		expect(document.paths["/v1/credentials/{role}/rebind/options"]).toBeUndefined();
		expect(document.paths["/v1/auth/setup"]).toBeDefined();
		expect(response.body).not.toContain(config.relayPrivateKey);
		expect(response.body).not.toContain(config.rpcUrl);
		expect(response.body).not.toContain(config.journalPath);
	});

	it("preserves unauthenticated account-route rejection before header validation", async () => {
		const { get } = fixture();
		expect((await get("/v1/vaults/current")).statusCode).toBe(401);
	});

	it("preserves selected-account denials and invalid role/id not-found responses", async () => {
		const { backend, config, get, store } = fixture();
		const account = store.createAccount(),
			session = store.createSession(account.id, true);
		const headers = { cookie: `vault_local_session=${session.token}` };
		expect((await get("/v1/vaults/current", headers)).statusCode).toBe(403);
		expect(
			(await get("/v1/vaults/current", { ...headers, "x-vault-account": "other" }))
				.statusCode,
		).toBe(403);
		expect(
			(await get("/v1/submissions/bad%20id", { ...headers, "x-vault-account": account.id }))
				.statusCode,
		).toBe(404);
		expect(
			(
				await backend.fastify.inject({
					method: "POST",
					url: "/v1/registrations/unknown/options",
					headers: {
						...headers,
						host: "localhost:8787",
						origin: config.origin,
						"x-vault-account": account.id,
						"x-csrf-token": session.csrfToken,
					},
					payload: {},
				})
			).statusCode,
		).toBe(404);
	});

	it("serves a local read-only Swagger UI and assets", async () => {
		const { get } = fixture();
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

	it("retains Host, Origin and loopback checks for specs and assets", async () => {
		const { get } = fixture();
		for (const path of [
			"/documentation/",
			"/documentation/json",
			"/documentation/static/swagger-ui.css",
		]) {
			expect((await get(path, { origin: "https://attacker.invalid" })).statusCode).toBe(403);
			expect((await get(path, {}, "203.0.113.1")).statusCode).toBe(403);
			expect((await get(path, { host: "attacker.invalid" })).statusCode).toBe(403);
		}
	});
});
