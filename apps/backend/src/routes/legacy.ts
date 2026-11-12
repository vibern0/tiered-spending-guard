import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { isLoopbackAddress, type BackendConfig } from "../config";
import { RebindSessionStore, RegistrationSessionStore } from "../session";
import {
	verifyPasskeyRebind,
	verifyPasskeyRegistration,
	type BackendPasskeyRole,
} from "../webauthn";
import type { BackendHandlers } from "../server";

type RoleParams = Readonly<{ role: string }>;
type SubmissionParams = Readonly<{ id: string }>;

function role(value: string): BackendPasskeyRole {
	if (value !== "primary" && value !== "secondary")
		throw Object.assign(new Error("not found"), { statusCode: 404 });
	return value;
}

function requestPath(request: FastifyRequest): string {
	return request.raw.url?.split("?", 1)[0] ?? "/";
}

export function registerLegacyRoutes(
	fastify: FastifyInstance,
	config: BackendConfig,
	handlers: BackendHandlers,
	sessions: RegistrationSessionStore,
	rebindSessions: RebindSessionStore,
): void {
	fastify.addHook("onRequest", async (request, reply) => {
		if (!isLoopbackAddress(request.raw.socket.remoteAddress)) {
			await reply.code(403).send({ error: "loopback only" });
			return;
		}
		const origin = request.headers.origin;
		if (origin !== undefined && origin !== config.origin) {
			await reply.code(403).send({ error: "origin not allowed" });
			return;
		}
		if (origin !== undefined) {
			reply.header("access-control-allow-origin", config.origin);
			reply.header("access-control-allow-methods", "GET,POST,OPTIONS");
			reply.header("access-control-allow-headers", "content-type");
			if (config.id === "https") reply.header("access-control-allow-credentials", "true");
			reply.header("vary", "Origin");
		}
		if (request.method === "OPTIONS") {
			await reply.code(204).send();
			return;
		}
		if (request.raw.url?.includes("?") && requestPath(request) !== "/health") {
			await reply.code(404).send({ error: "not found" });
			return;
		}
		if (request.method === "POST" && handlers.historicalVault) {
			await reply.code(409).send({
				code: "vault_read_only",
				error: "This vault uses an earlier recipient policy and is available for viewing. Transfers and credential changes are disabled.",
			});
		}
	});

	fastify.get("/health", async (_request, reply) => {
		const readiness = handlers.getReadiness?.();
		const provisioningReady =
			!handlers.historicalVault && (readiness?.provisioningReady ?? false);
		const writesReady =
			!handlers.historicalVault &&
			(readiness?.writesReady ??
				handlers.writesReady ??
				Boolean(handlers.prepareTransfer && handlers.submit && handlers.submission));
		return reply.send({
			ok: true,
			provisioningReady,
			writesReady,
			chainId: config.chainId,
			profileId: config.id,
			origin: config.origin,
			rpId: config.rpId,
			...(handlers.historicalVault
				? {
						vaultCompatibility: {
							mode: "read-only",
							profileVersion: handlers.historicalVault.profileVersion,
							reason: "This vault uses an earlier recipient policy. Transfers are disabled.",
						},
					}
				: {}),
		});
	});

	fastify.get("/v1/vaults/current", async (_request, reply) => {
		const current = handlers.currentVault?.();
		return current
			? reply.send(current)
			: reply.code(404).send({ error: "vault is not provisioned" });
	});

	fastify.post<{ Params: RoleParams }>(
		"/v1/registrations/:role/options",
		async (request, reply) => {
			const passkeyRole = role(request.params.role);
			const session = sessions.create(passkeyRole);
			return reply.send({
				sessionId: session.id,
				challenge: session.challenge,
				rpId: session.rpId,
				origin: session.origin,
				role: session.role,
				userVerification: "required",
				authenticatorAttachment: session.authenticatorAttachment,
			});
		},
	);

	fastify.post<{ Params: RoleParams }>(
		"/v1/registrations/:role/verify",
		async (request, reply) => {
			const passkeyRole = role(request.params.role);
			const input = request.body as {
				sessionId?: string;
				registration?: RegistrationResponseJSON;
			};
			if (!input?.sessionId || !input.registration)
				throw new Error("registration session and response are required");
			const session = sessions.consume(input.sessionId, passkeyRole);
			const credential = await verifyPasskeyRegistration({
				role: passkeyRole,
				credentialId: input.registration.id,
				challenge: session.challenge,
				rpId: session.rpId,
				origin: session.origin,
				response: input.registration,
			});
			if (!handlers.storeCredential) throw new Error("credential storage unavailable");
			handlers.storeCredential(credential);
			sessions.markRegistered(passkeyRole);
			return reply.send({
				role: passkeyRole,
				credentialId: credential.credentialId,
				counter: credential.counter,
			});
		},
	);

	fastify.post<{ Params: RoleParams }>(
		"/v1/credentials/:role/rebind/options",
		async (request, reply) => {
			if (config.id !== "local") return reply.code(404).send({ error: "not found" });
			const passkeyRole = role(request.params.role);
			const input = request.body;
			if (
				!input ||
				typeof input !== "object" ||
				Array.isArray(input) ||
				Object.keys(input).length !== 0
			)
				throw new Error("credential rebind options body must be empty");
			if (!handlers.rebindCoordinates) throw new Error("credential rebind unavailable");
			handlers.rebindCoordinates(passkeyRole);
			const session = rebindSessions.create(passkeyRole);
			return reply.send({
				sessionId: session.id,
				challenge: session.challenge,
				rpId: session.rpId,
				origin: session.origin,
				role: session.role,
				userVerification: "required",
			});
		},
	);

	fastify.post<{ Params: RoleParams }>(
		"/v1/credentials/:role/rebind/verify",
		async (request, reply) => {
			if (config.id !== "local") return reply.code(404).send({ error: "not found" });
			const passkeyRole = role(request.params.role);
			const input = request.body;
			if (!input || typeof input !== "object" || Array.isArray(input))
				throw new Error("credential rebind verification body must be an object");
			const value = input as Record<string, unknown>;
			if (
				Object.keys(value).length !== 2 ||
				!Object.hasOwn(value, "sessionId") ||
				!Object.hasOwn(value, "assertion") ||
				typeof value.sessionId !== "string" ||
				!value.assertion
			)
				throw new Error("credential rebind session and assertion are required");
			if (!handlers.rebindCoordinates || !handlers.storeReboundCredential)
				throw new Error("credential rebind unavailable");
			const coordinates = handlers.rebindCoordinates(passkeyRole);
			const session = rebindSessions.consume(value.sessionId, passkeyRole);
			const credential = await (handlers.verifyRebind ?? verifyPasskeyRebind)({
				role: passkeyRole,
				coordinates,
				challenge: session.challenge,
				rpId: session.rpId,
				origin: session.origin,
				response: value.assertion as AuthenticationResponseJSON,
			});
			const status = handlers.storeReboundCredential(credential);
			return reply.send({
				role: passkeyRole,
				credentialId: credential.credentialId,
				counter: credential.counter,
				credentialRebind: status,
			});
		},
	);

	fastify.post("/v1/vaults/auto-provision", async (request, reply) => {
		if (config.id !== "local") return reply.code(404).send({ error: "not found" });
		return reply.send(await handlers.autoProvisionVault(request.body));
	});

	fastify.post("/v1/submissions/prepare", async (request, reply) => {
		if (!handlers.prepareTransfer)
			return reply.code(503).send({ error: "submission runtime is not ready" });
		return reply.send(await handlers.prepareTransfer(request.body));
	});

	fastify.post<{ Params: SubmissionParams }>(
		"/v1/submissions/:id/submit",
		async (request, reply) => {
			if (!handlers.submit || !request.params.id) throw new Error("submission unavailable");
			return reply.send(await handlers.submit(request.params.id, request.body));
		},
	);

	fastify.get<{ Params: SubmissionParams }>("/v1/submissions/:id", async (request, reply) => {
		if (!handlers.submission) throw new Error("submission unavailable");
		return reply.send(await handlers.submission(request.params.id));
	});

	fastify.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: "not found" }));
}
