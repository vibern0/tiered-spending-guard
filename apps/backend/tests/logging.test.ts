import { afterEach, expect, it } from "vitest";
import { createBackendFastify } from "../src/http/fastify";
import { captureBackendLogs } from "./logger-fixture";

const servers: ReturnType<typeof createBackendFastify>[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
});
function fixture() {
	const { logger, entries } = captureBackendLogs();
	const server = createBackendFastify({
		logger,
	});
	servers.push(server);
	server.get("/health", async () => ({ ok: true }));
	server.post("/v1/submissions/:id/submit", async (request) => {
		request.log.info("Checking approved submission");
		return { ok: true };
	});
	server.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: "not found" }));
	return { server, entries };
}

it("uses native Fastify request logs with one generated correlation ID and response timing", async () => {
	const { server, entries } = fixture();
	const response = await server.inject({
		url: "/health",
		headers: { "x-request-id": "untrusted-id" },
	});
	expect(response.statusCode).toBe(200);
	expect(entries).toEqual([
		expect.objectContaining({
			level: 30,
			msg: "incoming request",
			req: { method: "GET", route: "/health" },
			reqId: response.headers["x-request-id"],
		}),
		expect.objectContaining({
			level: 30,
			msg: "request completed",
			res: { statusCode: 200 },
			responseTime: expect.any(Number),
			reqId: response.headers["x-request-id"],
		}),
	]);
	expect(response.headers["x-request-id"]).not.toBe("untrusted-id");
});

it("keeps headers, bodies, identifiers and unknown paths out of native logs", async () => {
	const { server, entries } = fixture();
	await server.inject({
		method: "POST",
		url: "/v1/submissions/private-reference/submit?secret=query-token",
		headers: {
			authorization: "Bearer header-token",
			cookie: "session=cookie-token",
			"content-type": "application/json",
		},
		payload: { assertion: "body-token" },
	});
	await server.inject({ url: "/private-path-token?secret=query-token" });
	expect(entries).toContainEqual(
		expect.objectContaining({
			msg: "incoming request",
			req: { method: "POST", route: "/v1/submissions/:id/submit" },
		}),
	);
	expect(entries).toContainEqual(
		expect.objectContaining({
			msg: "incoming request",
			req: { method: "GET", route: "unmatched" },
		}),
	);
	const custom = entries.find((entry) => entry.msg === "Checking approved submission");
	expect(custom?.reqId).toBe(entries[0].reqId);
	expect(JSON.stringify(entries)).not.toMatch(
		/private-reference|query-token|header-token|cookie-token|body-token|private-path-token/,
	);
});

it("lets Fastify log the actual listening address", async () => {
	const { server, entries } = fixture();
	await server.listen({ port: 0, host: "127.0.0.1" });
	const port = (server.server.address() as { port: number }).port;
	expect(entries).toContainEqual(
		expect.objectContaining({ msg: `Server listening at http://127.0.0.1:${port}` }),
	);
});

it("prevents Pino from copying private error text into an implicit log message", () => {
	const { logger, entries } = captureBackendLogs();
	const error = new Error("request /private-reference?secret=provider-token failed");
	logger.warn({ err: error });
	logger.error(error);
	logger.error({ err: error, code: "rpc_request_failed" }, "Provider verification failed safely");
	expect(entries).toHaveLength(3);
	expect(entries[2]).toMatchObject({
		code: "rpc_request_failed",
		msg: "Provider verification failed safely",
	});
	expect(JSON.stringify(entries)).not.toMatch(/private-reference|provider-token/);
	expect(error.message).toContain("provider-token");
});

it("records a disconnected long-running request once without leaking input", async () => {
	const { server, entries } = fixture();
	let received!: () => void;
	const arrival = new Promise<void>((resolve) => {
		received = resolve;
	});
	server.get("/v1/submissions/:id", async (_request, reply) => {
		received();
		await new Promise<void>((resolve) => reply.raw.once("close", resolve));
	});
	await server.listen({ port: 0, host: "127.0.0.1" });
	const port = (server.server.address() as { port: number }).port;
	const controller = new AbortController();
	const response = fetch(`http://127.0.0.1:${port}/v1/submissions/private-reference`, {
		signal: controller.signal,
	}).catch(() => undefined);
	await arrival;
	controller.abort();
	await response;
	await expect
		.poll(() => entries.filter((entry) => entry.msg === "request aborted").length)
		.toBe(1);
	expect(JSON.stringify(entries)).not.toContain("private-reference");
});
