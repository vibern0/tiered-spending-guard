import type { FastifyInstance } from "fastify";
import type { Server } from "node:http";
import type { BackendConfig } from "../config/config";
import { registerBackendDocumentation } from "../http/documentation";
import { diagnosticFor, sanitizeBackendMessage } from "../http/errors";
import { createBackendFastify } from "../http/fastify";
import type { BackendServerOptions } from "../http/types";
import { SubmissionJournal } from "../submissions/journal";
import type { BackendHandlers } from "../vaults/types";
import { RebindSessionStore, RegistrationSessionStore } from "./registration-sessions";
import { registerLegacyRoutes } from "./routes";

export type BackendServer = Readonly<{
	fastify: FastifyInstance;
	server: Server;
	sessions: RegistrationSessionStore;
	rebindSessions: RebindSessionStore;
	journal: SubmissionJournal;
	close: () => Promise<void>;
}>;

export function createBackendServer(
	config: BackendConfig,
	handlers: BackendHandlers,
	options: BackendServerOptions = {},
): BackendServer {
	const sessions = new RegistrationSessionStore(config);
	const rebindSessions = new RebindSessionStore(config);
	const journal = new SubmissionJournal(config.journalPath);
	const fastify = createBackendFastify({
		logger: options.logger,
		json: {
			strictContentType: false,
			requireObject: false,
			invalidMessage: "request body must be JSON",
			bigintKeys: ["amount", "nonce", "queueNonce", "window", "baseSpent", "instantSpent"],
		},
	});
	registerLegacyRoutes(fastify, config, handlers, sessions, rebindSessions);
	registerBackendDocumentation(fastify, "legacy");
	fastify.setErrorHandler((error, request, reply) => {
		if ((error as { statusCode?: number }).statusCode === 404)
			return reply.code(404).send({ error: "not found" });
		const message = sanitizeBackendMessage(error);
		const diagnostic = diagnosticFor(message);
		request.log.warn({ ...diagnostic, statusCode: 400 }, message);
		return reply.code(400).send({ error: message, ...diagnostic, requestId: request.id });
	});
	void Promise.resolve(fastify.ready()).catch((error: Error) =>
		fastify.server.emit("error", error),
	);
	return Object.freeze({
		fastify,
		server: fastify.server,
		sessions,
		rebindSessions,
		journal,
		close: () => fastify.close(),
	});
}
