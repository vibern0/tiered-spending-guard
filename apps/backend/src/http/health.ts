import type { FastifyInstance } from "fastify";
import type { BackendConfig } from "../config/config";
import type { AccountGateway } from "../accounts/types";
import type { AccountRouteContext } from "./security";

export function registerAccountHealthRoutes(
	fastify: FastifyInstance,
	config: BackendConfig,
	gateway: AccountGateway,
	context: AccountRouteContext,
): void {
	fastify.get("/health", async (request, reply) => {
		const session = context.state(request).session;
		const handlers =
			session?.authenticated && session.accountId
				? await gateway.handlers(session.accountId)
				: undefined;
		return reply.send({
			ok: true,
			chainId: config.chainId,
			profileId: config.id,
			origin: config.origin,
			rpId: config.rpId,
			provisioningReady: true,
			writesReady: handlers?.getReadiness?.().writesReady ?? false,
		});
	});
}
