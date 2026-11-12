import type { FastifyInstance } from "fastify";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import type { BackendConfig } from "../config/config";
import type { AccountStore } from "../accounts/store";
import type { AccountGateway } from "../accounts/types";
import type { AccountService } from "../accounts/service";
import { AccountAuthService } from "./service";
import { AccountHttpError } from "./errors";
import { exact, type AccountRouteContext } from "../http/security";

export function registerAccountAuthRoutes(
	fastify: FastifyInstance,
	config: BackendConfig,
	store: AccountStore,
	gateway: AccountGateway,
	accounts: AccountService,
	context: AccountRouteContext,
): void {
	const auth = new AccountAuthService(config, store, gateway, accounts);
	fastify.get("/v1/auth/session", async (request, reply) =>
		reply.send(await accounts.project(context.state(request).session)),
	);

	fastify.post("/v1/auth/setup", async (request, reply) => {
		const input = request.body as Record<string, unknown>;
		exact(input, []);
		const action = auth.setup(context.state(request).session);
		if (action.replacement) {
			context.replaceSession(request, action.replacement);
			context.setCookie(reply, action.replacement.token);
		}
		return reply.send(await accounts.project(action.session));
	});

	fastify.post("/v1/auth/login/options", async (request, reply) => {
		const input = request.body as Record<string, unknown>;
		if (
			Object.keys(input).some((key) => key !== "accountId") ||
			(input.accountId !== undefined && typeof input.accountId !== "string")
		)
			throw new AccountHttpError(400, "unsupported login fields");
		const action = auth.loginSession(context.state(request).session);
		if (action.replacement) {
			context.replaceSession(request, action.replacement);
			context.setCookie(reply, action.replacement.token);
		}
		return reply.send(auth.loginOptions(action.session, input.accountId as string | undefined));
	});

	fastify.post("/v1/auth/login/verify", async (request, reply) => {
		const input = request.body as Record<string, unknown>;
		if (
			Object.keys(input).some(
				(key) => !["sessionId", "assertion", "accountId"].includes(key),
			) ||
			typeof input.sessionId !== "string" ||
			!input.assertion
		)
			throw new AccountHttpError(400, "login session and assertion required");
		const state = context.state(request);
		const session = context.session(request);
		const action = await auth.verifyLogin(
			{ token: state.token, session },
			{
				sessionId: input.sessionId,
				assertion: input.assertion as AuthenticationResponseJSON,
				accountId: input.accountId,
			},
		);
		if (action.replacement) {
			context.replaceSession(request, action.replacement);
			context.setCookie(reply, action.replacement.token);
		}
		return reply.send(await accounts.project(action.session));
	});

	fastify.post("/v1/auth/logout", async (request, reply) => {
		const input = request.body as Record<string, unknown>;
		exact(input, []);
		const state = context.state(request);
		const session = context.session(request);
		const action = auth.logout({ token: state.token, session });
		if (action.clearCookie) context.clearCookie(reply);
		return reply.send(action.body);
	});
}
