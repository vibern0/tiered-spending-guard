import type { FastifyInstance } from "fastify";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import type { BackendConfig } from "../config/config";
import type { AccountStore } from "../accounts/store";
import type { AccountGateway } from "../accounts/types";
import type { AccountService } from "../accounts/service";
import { AccountAuthService } from "./service";
import { type AccountRouteContext } from "../http/security";
import { object, ref, routeSchema, string } from "../http/schema";

export function registerAccountAuthRoutes(
	fastify: FastifyInstance,
	config: BackendConfig,
	store: AccountStore,
	gateway: AccountGateway,
	accounts: AccountService,
	context: AccountRouteContext,
): void {
	const auth = new AccountAuthService(config, store, gateway, accounts);
	fastify.get(
		"/v1/auth/session",
		{
			schema: routeSchema({
				tag: "Authentication",
				summary: "Read the current session",
				response: ref("Session"),
			}),
		},
		async (request, reply) =>
			reply.send(await accounts.project(context.state(request).session)),
	);

	fastify.post(
		"/v1/auth/setup",
		{
			schema: routeSchema({
				tag: "Authentication",
				summary: "Create or resume account setup",
				body: ref("Empty"),
				response: ref("Session"),
			}),
		},
		async (request, reply) => {
			const action = auth.setup(context.state(request).session);
			if (action.replacement) {
				context.replaceSession(request, action.replacement);
				context.setCookie(reply, action.replacement.token);
			}
			return reply.send(await accounts.project(action.session));
		},
	);

	fastify.post(
		"/v1/auth/login/options",
		{
			schema: routeSchema({
				tag: "Authentication",
				summary: "Request a first-passkey login challenge",
				body: object({ accountId: string }, []),
				response: ref("Challenge"),
			}),
		},
		async (request, reply) => {
			const input = request.body as Record<string, unknown>;
			const action = auth.loginSession(context.state(request).session);
			if (action.replacement) {
				context.replaceSession(request, action.replacement);
				context.setCookie(reply, action.replacement.token);
			}
			return reply.send(
				auth.loginOptions(action.session, input.accountId as string | undefined),
			);
		},
	);

	fastify.post(
		"/v1/auth/login/verify",
		{
			schema: routeSchema({
				tag: "Authentication",
				summary: "Verify the first passkey and rotate the session",
				access: "session",
				body: object(
					{ sessionId: string, assertion: ref("Assertion"), accountId: string },
					["sessionId", "assertion"],
				),
				response: ref("Session"),
			}),
		},
		async (request, reply) => {
			const input = request.body as Record<string, unknown>;
			const state = context.state(request);
			const session = context.session(request);
			const action = await auth.verifyLogin(
				{ token: state.token, session },
				{
					sessionId: input.sessionId as string,
					assertion: input.assertion as AuthenticationResponseJSON,
					accountId: input.accountId,
				},
			);
			if (action.replacement) {
				context.replaceSession(request, action.replacement);
				context.setCookie(reply, action.replacement.token);
			}
			return reply.send(await accounts.project(action.session));
		},
	);

	fastify.post(
		"/v1/auth/logout",
		{
			schema: routeSchema({
				tag: "Authentication",
				summary: "Revoke the current session",
				access: "session",
				body: ref("Empty"),
				response: object({ authenticated: { type: "boolean", enum: [false] } }),
			}),
		},
		async (request, reply) => {
			const state = context.state(request);
			const session = context.session(request);
			const action = auth.logout({ token: state.token, session });
			if (action.clearCookie) context.clearCookie(reply);
			return reply.send(action.body);
		},
	);
}
