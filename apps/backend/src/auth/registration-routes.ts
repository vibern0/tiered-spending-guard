import type { FastifyInstance } from "fastify";
import type { BackendConfig } from "../config/config";
import type { AccountStore } from "../accounts/store";
import { AccountRegistrationService } from "./service";
import { passkeyRole, type AccountRouteContext } from "../http/security";

import { object, ref, routeSchema, string } from "../http/schema";

type RoleParams = Readonly<{ role: string }>;

export function registerAccountRegistrationRoutes(
	fastify: FastifyInstance,
	config: BackendConfig,
	store: AccountStore,
	context: AccountRouteContext,
): void {
	const registrations = new AccountRegistrationService(config, store);
	fastify.post<{ Params: RoleParams }>(
		"/v1/registrations/:role/options",
		{
			schema: routeSchema({
				tag: "Credentials",
				summary: "Request registration options for a signer",
				description:
					"Existing role credentials cannot be replaced. Secondary registration requires first-key authentication.",
				access: "account",
				params: object({ role: string }),
				body: ref("Empty"),
				response: ref("Challenge"),
			}),
		},
		async (request, reply) => {
			const account = context.account(request);
			const role = passkeyRole(request.params.role);
			const session = context.session(request);
			return reply.send(
				registrations.options(
					account,
					session,
					role,
					request.body as Record<string, unknown>,
				),
			);
		},
	);

	fastify.post<{ Params: RoleParams }>(
		"/v1/registrations/:role/verify",
		{
			schema: routeSchema({
				tag: "Credentials",
				summary: "Verify and store public signer metadata",
				access: "account",
				params: object({ role: string }),
				body: object({ sessionId: string, registration: ref("Registration") }),
				response: ref("Credential"),
			}),
		},
		async (request, reply) => {
			const account = context.account(request);
			const role = passkeyRole(request.params.role);
			const session = context.session(request);
			return reply.send(
				await registrations.verify(
					account,
					session,
					role,
					request.body as Record<string, unknown>,
				),
			);
		},
	);
}
