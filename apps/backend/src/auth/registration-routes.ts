import type { FastifyInstance } from "fastify";
import type { BackendConfig } from "../config/config";
import type { AccountStore } from "../accounts/store";
import { AccountRegistrationService } from "./service";
import { passkeyRole, type AccountRouteContext } from "../http/security";

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
