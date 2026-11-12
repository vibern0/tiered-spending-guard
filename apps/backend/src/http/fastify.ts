import { randomUUID } from "node:crypto";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { createBackendLogger } from "../logging";

const BODY_LIMIT = 256 * 1024;

export type BackendJsonOptions = Readonly<{
	strictContentType: boolean;
	requireObject: boolean;
	invalidMessage: string;
	bigintKeys: readonly string[];
}>;

export type BackendFastifyOptions = Readonly<{
	logger?: FastifyBaseLogger;
	json: BackendJsonOptions;
}>;

type StatusError = Error & Readonly<{ statusCode: number }>;

function statusError(statusCode: number, message: string): StatusError {
	return Object.assign(new Error(message), { statusCode });
}

function parseJson(value: Buffer, options: BackendJsonOptions): unknown {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value.toString("utf8"), (key, item) => {
			if (options.bigintKeys.includes(key) && typeof item === "string" && /^\d+n$/.test(item))
				return BigInt(item.slice(0, -1));
			return item;
		});
	} catch {
		throw statusError(400, options.invalidMessage);
	}
	if (options.requireObject && (!parsed || typeof parsed !== "object" || Array.isArray(parsed)))
		throw statusError(400, "request must be an object");
	return parsed;
}

export function createBackendFastify(options: BackendFastifyOptions): FastifyInstance {
	const fastify = Fastify({
		loggerInstance:
			options.logger ??
			createBackendLogger({ level: process.env.NODE_ENV === "test" ? "silent" : "info" }),
		requestIdHeader: false,
		exposeHeadRoutes: false,
		bodyLimit: BODY_LIMIT,
		genReqId: () => randomUUID(),
	});

	fastify.removeContentTypeParser("application/json");
	if (!options.json.strictContentType) fastify.removeContentTypeParser("text/plain");
	const parser = (
		_request: unknown,
		payload: string | Buffer,
		done: (error: Error | null, body?: unknown) => void,
	) => {
		try {
			done(
				null,
				parseJson(Buffer.isBuffer(payload) ? payload : Buffer.from(payload), options.json),
			);
		} catch (error) {
			done(error as Error);
		}
	};
	if (options.json.strictContentType)
		fastify.addContentTypeParser(
			"application/json",
			{ parseAs: "buffer", bodyLimit: BODY_LIMIT },
			parser,
		);
	else fastify.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: BODY_LIMIT }, parser);

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
			options.json.strictContentType &&
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
