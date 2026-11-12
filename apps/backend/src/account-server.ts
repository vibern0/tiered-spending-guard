import type { BackendHandlerSet } from "./handlers";
import type { BackendServerOptions, VaultProvisioningResult } from "./server";
import type { AccountStore } from "./account-store";
import type { BackendConfig } from "./config";
import { startReceiptReconciler } from "./receipt-reconciler";
import { createBackendFastify } from "./http/fastify";
import { registerBackendDocumentation } from "./http/documentation";
import { AccountService } from "./services/account-service";
import { TransactionService } from "./services/transaction-service";
import {
	AccountHttpError,
	AccountRouteContext,
	registerAccountSecurity,
} from "./routes/account-context";
import { registerAccountHealthRoutes } from "./routes/account-health";
import { registerAccountAuthRoutes } from "./routes/account-auth";
import { registerAccountRegistrationRoutes } from "./routes/account-registrations";
import { registerAccountVaultRoutes } from "./routes/account-vaults";
import { registerAccountSubmissionRoutes } from "./routes/account-submissions";

export type AccountGateway = Readonly<{
	handlers(accountId: string): Promise<BackendHandlerSet>;
	provision(accountId: string): Promise<VaultProvisioningResult>;
	prepare(accountId: string, sessionId: string, body: unknown): Promise<unknown>;
	submit(accountId: string, sessionId: string, id: string, body: unknown): Promise<unknown>;
	status(accountId: string, id: string): Promise<unknown>;
	reconcilePending?(): Promise<void>;
	legacyCoordinates?(accountId: string): Promise<Readonly<{ x: bigint; y: bigint }> | undefined>;
	submissionIds?(accountId: string): Promise<readonly string[]>;
	releaseSession?(sessionId: string): void;
}>;

function accountError(error: unknown): Readonly<{ status: number; message: string }> {
	if (error instanceof AccountHttpError) return error;
	const status = (error as { statusCode?: number }).statusCode;
	if (status === 413) return { status, message: "request too large" };
	if (status === 415) return { status, message: "JSON request required" };
	return { status: 400, message: "account request failed safely" };
}

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
	const transactions = new TransactionService(gateway);
	registerAccountSecurity(fastify, config, store, context);
	registerAccountHealthRoutes(fastify, config, gateway, context);
	registerAccountAuthRoutes(fastify, config, store, gateway, accounts, context);
	registerAccountRegistrationRoutes(fastify, config, store, context);
	registerAccountVaultRoutes(fastify, gateway, context);
	registerAccountSubmissionRoutes(fastify, transactions, context);
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
