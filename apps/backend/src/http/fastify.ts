import { randomUUID } from "node:crypto";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { createBackendLogger } from "../logging";

const BODY_LIMIT = 256 * 1024;

type BackendFastifyOptions = Readonly<{ logger?: FastifyBaseLogger }>;

type StatusError = Error & Readonly<{ statusCode: number }>;

function statusError(statusCode: number, message: string): StatusError {
	return Object.assign(new Error(message), { statusCode });
}

function parseJson(value: Buffer): unknown {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value.toString("utf8"));
	} catch {
		throw statusError(400, "invalid JSON request");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw statusError(400, "request must be an object");
	return parsed;
}

export function createBackendFastify(options: BackendFastifyOptions = {}): FastifyInstance {
	const fastify = Fastify({
		ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
		loggerInstance:
			options.logger ??
			createBackendLogger({ level: process.env.NODE_ENV === "test" ? "silent" : "info" }),
		requestIdHeader: false,
		exposeHeadRoutes: false,
		bodyLimit: BODY_LIMIT,
		genReqId: () => randomUUID(),
	});

	fastify.removeContentTypeParser("application/json");
	const parser = (
		_request: unknown,
		payload: string | Buffer,
		done: (error: Error | null, body?: unknown) => void,
	) => {
		try {
			done(null, parseJson(Buffer.isBuffer(payload) ? payload : Buffer.from(payload)));
		} catch (error) {
			done(error as Error);
		}
	};
	fastify.addContentTypeParser(
		"application/json",
		{ parseAs: "buffer", bodyLimit: BODY_LIMIT },
		parser,
	);

	// Validate JSON wire types first; preserve the existing domain bigint representation.
	fastify.addHook("preHandler", async (request) => {
		const body = request.body as Record<string, unknown> | undefined;
		if (!body) return;
		for (const key of ["amount", "queueNonce"]) {
			const value = body[key];
			if (typeof value === "string" && /^(0|[1-9][0-9]*)n$/.test(value))
				body[key] = BigInt(value.slice(0, -1));
		}
	});

	fastify.setReplySerializer((payload) =>
		JSON.stringify(payload, (_key, item) => (typeof item === "bigint" ? `${item}n` : item)),
	);
	fastify.addHook("onRequest", async (request, reply) => {
		reply.header("x-request-id", request.id);
		let finished = false;
		reply.raw.once("finish", () => {
			finished = true;
		});
		reply.raw.once("close", () => {
			if (!finished && !reply.raw.writableFinished)
				request.log.warn({ responseTime: reply.elapsedTime }, "request aborted");
		});
		if (
			request.method === "POST" &&
			request.headers["content-type"]?.split(";", 1)[0] !== "application/json"
		)
			throw statusError(415, "JSON request required");
	});
	fastify.addHook("onSend", async (_request, reply, payload) => {
		reply.header("cache-control", "no-store");
		return payload;
	});
	return fastify;
}
