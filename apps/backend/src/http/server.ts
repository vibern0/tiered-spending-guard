import { AccountService } from "../accounts/service";
import type { AccountStore } from "../accounts/store";
import type { AccountGateway } from "../accounts/types";
import { registerAccountRegistrationRoutes } from "../auth/registration-routes";
import { registerAccountAuthRoutes } from "../auth/routes";
import type { BackendConfig } from "../config/config";
import { startBackgroundWorker } from "../jobs/worker";
import type { VaultHistory } from "../history/service";
import { routeSchema, object, string } from "./schema";
import { registerAccountSubmissionRoutes } from "../submissions/routes";
import { registerAccountVaultRoutes } from "../vaults/routes";
import { registerBackendDocumentation } from "./documentation";
import { accountError } from "./errors";
import { createBackendFastify } from "./fastify";
import { registerAccountHealthRoutes } from "./health";
import { AccountHttpError, AccountRouteContext, registerAccountSecurity } from "./security";
import type { BackendServerOptions } from "./types";

/** Only localhost multi-user HTTP. Public identifiers never authenticate a request. */
export function createAccountServer(
	config: BackendConfig,
	store: AccountStore,
	gateway: AccountGateway,
	options: BackendServerOptions & { history?: Pick<VaultHistory, "scan" | "page"> } = {},
) {
	if (config.id !== "local") throw new Error("multi-user provisioning is localhost-only");
	const fastify = createBackendFastify({
		logger: options.logger,
	});
	let stopping = false;
	let closing: Promise<void> | undefined;
	fastify.addHook("onRequest", async (_request, reply) => {
		if (stopping) await reply.code(503).send({ error: "backend is shutting down" });
	});
	const context = new AccountRouteContext(store);
	const accounts = new AccountService(store, gateway);
	registerAccountSecurity(fastify, config, store, context);
	registerBackendDocumentation(fastify);
	fastify.register(async (routes) => {
		registerAccountHealthRoutes(routes, config, gateway, context);
		registerAccountAuthRoutes(routes, config, store, gateway, accounts, context);
		registerAccountRegistrationRoutes(routes, config, store, context);
		registerAccountVaultRoutes(routes, gateway, context);
		registerAccountSubmissionRoutes(routes, gateway, context);
		if (options.history)
			routes.get(
				"/v1/vaults/current/history",
				{
					schema: {
						...routeSchema({
							tag: "Vaults",
							summary: "Read confirmed USDC and vault history",
							access: "authenticated",
							response: { type: "object", additionalProperties: true },
						}),
						querystring: object(
							{
								cursor: string,
								limit: { type: "string", pattern: "^(?:[1-9]|[1-9][0-9]|100)$" },
							},
							[],
						),
					},
				},
				async (request, reply) => {
					context.session(request, true);
					const account = context.account(request);
					if (account.state !== "verified")
						return reply.code(404).send({ error: "vault is not provisioned" });
					const query = request.query as { cursor?: string; limit?: string };
					return reply.send(
						options.history!.page(account.id, {
							cursor: query.cursor,
							limit: query.limit ? Number(query.limit) : undefined,
						}),
					);
				},
			);
	});
	fastify.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: "not found" }));
	fastify.setErrorHandler((error, request, reply) => {
		const mapped = accountError(error);
		const actual = error instanceof Error ? error : new Error("account request failed safely");
		let message = mapped.message;
		let code =
			mapped.status === 401
				? "authentication_required"
				: mapped.status === 403
					? "account_access_denied"
					: "account_request_failed";
		let stage = "account";
		if (!(error instanceof AccountHttpError)) {
			if (
				actual.message ===
				"automatic provisioning is still awaiting canonical confirmations for its recorded transaction"
			) {
				code = "provisioning_pending_confirmation";
				stage = "provisioning-reconciliation";
				message = "Waiting for the recorded transaction to confirm";
			} else if (/Sepolia RPC request failed/.test(actual.message)) {
				code = "rpc_request_failed";
				stage = "provisioning-rpc";
				message = "A Sepolia provider is temporarily unavailable";
			} else if (
				/provisioning (?:quote|relay) nonce mismatch|nonce drift before provisioning|deployer nonce does not equal|relay latest\/pending nonce changed/.test(
					actual.message,
				)
			) {
				code = "provisioning_nonce_mismatch";
				stage = "provisioning-recovery";
				message = "Verified deployment recovery is required before continuing";
			} else if (/unresolved|incomplete immutable deployment/.test(actual.message)) {
				code = "payer_reconciliation_required";
				stage = "payer";
				message = "Recorded transaction work must be reconciled before another submission";
			}
		}
		request.log.warn({ code, stage, statusCode: mapped.status }, message);
		return reply
			.code(mapped.status)
			.send({ error: message, code, stage, requestId: request.id });
	});
	void Promise.resolve(fastify.ready()).catch((error: Error) =>
		fastify.server.emit("error", error),
	);
	const workers: ReturnType<typeof startBackgroundWorker>[] = [];
	let historyCursor: string | undefined;
	fastify.server.once("listening", () => {
		if (gateway.reconcilePending)
			workers.push(
				startBackgroundWorker("receipt", () => gateway.reconcilePending!(() => stopping), {
					logger: fastify.log,
				}),
			);
		if (gateway.runProvisioning)
			workers.push(
				startBackgroundWorker(
					"provisioning",
					async () => {
						for (const account of store.provisioningJobs()) {
							if (stopping) break;
							try {
								await gateway.runProvisioning!(account.id, () => stopping);
							} catch {
								fastify.log.warn(
									{ code: "creation_job_blocked", stage: "provisioning" },
									"Vault creation is awaiting verified recovery",
								);
							}
						}
					},
					{ logger: fastify.log },
				),
			);
		if (options.history)
			workers.push(
				startBackgroundWorker(
					"history",
					async () => {
						let batch = store.historyAccounts(historyCursor);
						if (!batch.length) {
							historyCursor = undefined;
							batch = store.historyAccounts();
						}
						for (const account of batch) {
							if (stopping) break;
							historyCursor = account.id;
							try {
								const vault = store.historyVault(account.id);
								if (vault) await options.history!.scan(account.id, vault);
							} catch {
								fastify.log.warn(
									{ code: "history_scan_failed", stage: "history" },
									"Account history is awaiting verified observations",
								);
							}
						}
					},
					{ logger: fastify.log },
				),
			);
	});
	return {
		fastify,
		server: fastify.server,
		close: () => {
			if (!closing) {
				stopping = true;
				closing = Promise.all([
					fastify.close(),
					...workers.map((worker) => worker.stop()),
				]).then(() => undefined);
			}
			return closing;
		},
	};
}
