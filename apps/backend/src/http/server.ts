import { AccountService } from "../accounts/service";
import type { AccountStore } from "../accounts/store";
import type { AccountGateway } from "../accounts/types";
import { registerAccountRegistrationRoutes } from "../auth/registration-routes";
import { registerAccountAuthRoutes } from "../auth/routes";
import type { BackendConfig } from "../config/config";
import { startReceiptReconciler } from "../jobs/receipt-reconciler";
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
	options: BackendServerOptions = {},
) {
	if (config.id !== "local") throw new Error("multi-user provisioning is localhost-only");
	const fastify = createBackendFastify({
		logger: options.logger,
		json: {
			strictContentType: true,
			requireObject: true,
			invalidMessage: "invalid JSON request",
			bigintKeys: ["amount", "queueNonce", "nonce"],
		},
	});
	const context = new AccountRouteContext(store);
	const accounts = new AccountService(store, gateway);
	registerAccountSecurity(fastify, config, store, context);
	registerAccountHealthRoutes(fastify, config, gateway, context);
	registerAccountAuthRoutes(fastify, config, store, gateway, accounts, context);
	registerAccountRegistrationRoutes(fastify, config, store, context);
	registerAccountVaultRoutes(fastify, gateway, context);
	registerAccountSubmissionRoutes(fastify, gateway, context);
	registerBackendDocumentation(fastify, "account");
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
	let receiptWorker: ReturnType<typeof startReceiptReconciler> | undefined;
	fastify.server.once("listening", () => {
		if (gateway.reconcilePending)
			receiptWorker = startReceiptReconciler(() => gateway.reconcilePending!(), {
				logger: fastify.log,
			});
	});
	return {
		fastify,
		server: fastify.server,
		close: async () => {
			await receiptWorker?.stop();
			await fastify.close();
		},
	};
}
