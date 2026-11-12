import type { FastifyInstance } from "fastify";
import type { AccountGateway } from "../accounts/types";
import { exact, type AccountRouteContext } from "../http/security";

export function registerAccountVaultRoutes(
	fastify: FastifyInstance,
	gateway: AccountGateway,
	context: AccountRouteContext,
): void {
	fastify.post("/v1/vaults/auto-provision", async (request, reply) => {
		context.session(request, true);
		const account = context.account(request);
		exact(request.body as Record<string, unknown>, []);
		return reply.send(await gateway.provision(account.id));
	});

	fastify.get("/v1/vaults/current", async (request, reply) => {
		context.session(request, true);
		const account = context.account(request);
		const current = (await gateway.handlers(account.id)).currentVault?.();
		return current
			? reply.send(current)
			: reply.code(404).send({ error: "vault is not provisioned" });
	});
}
