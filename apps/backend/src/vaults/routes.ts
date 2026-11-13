import type { FastifyInstance } from "fastify";
import type { AccountGateway } from "../accounts/types";
import { type AccountRouteContext } from "../http/security";
import { ref, routeSchema } from "../http/schema";

export function registerAccountVaultRoutes(
	fastify: FastifyInstance,
	gateway: AccountGateway,
	context: AccountRouteContext,
): void {
	fastify.post(
		"/v1/vaults/auto-provision",
		{
			schema: routeSchema({
				tag: "Vaults",
				summary: "Observe the account creation job",
				description:
					"Only the committed account creation job may provision. Empty request; no policy, nonce, provider or artifact overrides.",
				access: "authenticated",
				body: ref("Empty"),
				status: 202,
				response: ref("ProvisioningState"),
			}),
		},
		async (request, reply) => {
			context.session(request, true);
			const account = context.account(request);
			return reply.code(202).send(await gateway.provision(account.id));
		},
	);

	fastify.get(
		"/v1/vaults/current",
		{
			schema: routeSchema({
				tag: "Vaults",
				summary: "Read the verified current vault",
				access: "authenticated",
				response: ref("Vault"),
			}),
		},
		async (request, reply) => {
			context.session(request, true);
			const account = context.account(request);
			const current = (await gateway.handlers(account.id)).currentVault?.();
			return current
				? reply.send(current)
				: reply.code(404).send({ error: "vault is not provisioned" });
		},
	);
}
