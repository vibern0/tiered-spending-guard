import * as namespace from "@tiered-spending-guard/security-core/pwa";
import { existsSync, readdirSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { passkeyApprovalFingerprint } from "../auth/webauthn";
import { createPayerCoordinator } from "../chain/payer-coordinator";
import type { BackendConfig } from "../config/config";
import { createConfiguredAutomaticPwaProvisioner } from "../provisioning/runtime";
import { type AutomaticPwaProvisioner } from "../provisioning/service";
import { SubmissionJournal } from "../submissions/journal";
import { createConfiguredSubmissionRuntime } from "../submissions/runtime";
import { PwaSubmissionService, SEPOLIA_USDC_ADDRESS } from "../submissions/service";
import type { ConfiguredSubmissionRuntime } from "../submissions/types";
import { createBackendHandlers } from "../vaults/service";
import { type BackendHandlerSet } from "../vaults/types";
import { AccountStore } from "./store";
import type { AccountGateway } from "./types";
const core = (namespace as unknown as { default?: typeof namespace }).default ?? namespace;
type Factories = Readonly<{
	provisioner(config: BackendConfig): Promise<AutomaticPwaProvisioner>;
	runtime(
		config: BackendConfig,
		vault: () => ReturnType<BackendHandlerSet["vaultRecord"]>,
		beforeSign: (id: string) => void,
	): ConfiguredSubmissionRuntime;
}>;
type AccountRuntime = {
	handlers: BackendHandlerSet;
	provisioner: AutomaticPwaProvisioner;
	service?: PwaSubmissionService;
};

function compose(config: BackendConfig, store: AccountStore, factories: Factories): AccountGateway {
	const payer = privateKeyToAccount(config.relayPrivateKey).address;
	const runtimes = new Map<string, Promise<AccountRuntime>>();
	const { withPayer } = createPayerCoordinator(store, payer);
	const assertSession = (accountId: string, id: string) => {
		store.validateEvidenceInventory();
		const owner = store.submissionOwner(accountId, id);
		if (!owner) throw new Error("submission has no initiating session");
		store.assertActiveSession(owner, accountId);
	};
	const load = (id: string): Promise<AccountRuntime> => {
		const previous = runtimes.get(id);
		if (previous) return previous;
		const loading = (async () => {
			const a = store.account(id);
			if (!a) throw new Error("unknown account");
			if (
				a.state === "verified" &&
				(!existsSync(a.config.provisioningJournalPath) ||
					(!a.legacy && !existsSync(a.config.journalPath)))
			)
				throw new Error("verified account evidence disappeared");
			const provisioner = await factories.provisioner(a.config);
			// Late-bound: runtime callbacks capture handlers before their construction.
			// eslint-disable-next-line prefer-const
			let handlers: BackendHandlerSet;
			const runtime = provisioner.historicalVault
				? undefined
				: factories.runtime(
						a.config,
						() => handlers?.vaultRecord(),
						(submissionId) => assertSession(id, submissionId),
					);
			const service = runtime
				? new PwaSubmissionService({
						journal: new SubmissionJournal(a.config.journalPath),
						revalidate: async (p) => {
							assertSession(id, p.id);
							await runtime.revalidate(p);
							assertSession(id, p.id);
						},
						deriveOuterHash: async (p, approvals) => {
							assertSession(id, p.id);
							const hash = await runtime.deriveOuterHash(p, approvals);
							assertSession(id, p.id);
							return hash;
						},
						broadcast: async (p, approvals, hash) => {
							assertSession(id, p.id);
							return runtime.broadcast(p, approvals, hash);
						},
						reconcile: runtime.reconcile,
						...(runtime.discard ? { discard: runtime.discard } : {}),
						verifyApproval: async (role, prepared, assertion) => {
							assertSession(id, prepared.id);
							if (!prepared.safeTxHash)
								throw new Error("exact Safe transaction hash required");
							const approved = await handlers.verifyApproval(prepared.safeTxHash, {
								role,
								assertion,
							});
							assertSession(id, prepared.id);
							return { role, payload: approved.payload };
						},
					})
				: undefined;
			handlers = createBackendHandlers({
				config: a.config,
				usdc: SEPOLIA_USDC_ADDRESS,
				provisioner,
				actionSpecificApprovals: true,
				credentialStore: {
					get: (role) => store.credentials(id).find((c) => c.role === role),
					updateCounter: (c, next, approval, hash) =>
						store.consumeApproval(
							id,
							c.id,
							c.counter,
							next,
							passkeyApprovalFingerprint(approval, hash),
						),
					learn: (c, approval, hash) =>
						store.learnApproval(
							id,
							c,
							approval.counter,
							passkeyApprovalFingerprint(approval, hash),
						),
				},
				...(service && runtime
					? {
							prepareTransfer: async (input) =>
								service.prepare(await runtime.prepare(input)),
							submit: async ({ id, body }) => service.submit(id, body as never),
							submission: async ({ id }) => service.status(id),
						}
					: {}),
			});
			if (provisioner.completedRecoveryReady) {
				await handlers.autoProvisionVault({});
				if (a.state !== "verified") service?.journal.ensurePersisted();
				store.markProvisioning(id, "verified");
			}
			// Historical verification is read-only and account-scoped. It never grants
			// any submission capability, but it is a completed preserved deployment.
			if (provisioner.historicalVault) store.markProvisioning(id, "verified");
			return { handlers, provisioner, service };
		})();
		runtimes.set(id, loading);
		void loading.catch(() => {
			if (runtimes.get(id) === loading) runtimes.delete(id);
		});
		return loading;
	};

	return {
		handlers: async (id) => (await load(id)).handlers,
		legacyCoordinates: async (id) => (await load(id)).provisioner.recoveryCredentials?.primary,
		provision: (id) =>
			withPayer(id, "provision", async () => {
				const a = store.account(id)!;
				const { handlers, provisioner, service } = await load(id);
				if (provisioner.historicalVault) throw new Error("historical vault is read-only");
				if (a.state === "verified") return handlers.autoProvisionVault({});
				const credentials = store.credentials(id);
				if (
					!provisioner.recoveryCredentials &&
					(credentials.length !== 2 ||
						!credentials.some((c) => c.role === "primary") ||
						!credentials.some((c) => c.role === "secondary"))
				)
					throw new Error(
						"two distinct verified registrations required before provisioning",
					);
				store.markProvisioning(id, "provisioning");
				try {
					const result = await handlers.autoProvisionVault({});
					service?.journal.ensurePersisted();
					store.markProvisioning(id, "verified");
					return result;
				} catch (error) {
					// Only a provably empty attempt can relinquish nonce ownership. Any
					// retained review, authorization or hash leaves the deployment blocked.
					if (
						!core.readLiveJournal(a.config.provisioningJournalPath, payer).entries
							.length &&
						(!existsSync(a.config.provisioningReviewDirectory) ||
							!readdirSync(a.config.provisioningReviewDirectory).length)
					)
						store.markProvisioning(id, "queued");
					// A failed runner can leave a cached immutable plan; discard the entire
					// account runtime and reconstruct solely from durable evidence on retry.
					runtimes.delete(id);
					throw error;
				}
			}),
		prepare: async (id, sessionId, body) => {
			store.assertActiveSession(sessionId, id);
			if (
				!body ||
				typeof body !== "object" ||
				typeof (body as { idempotencyKey?: unknown }).idempotencyKey !== "string"
			)
				throw new Error("idempotency key required");
			const key = (body as { idempotencyKey: string }).idempotencyKey;
			if (!/^[A-Za-z0-9._:-]{1,160}$/.test(key)) throw new Error("invalid idempotency key");
			store.claimSubmission(id, key, sessionId);
			const runtime = await load(id);
			store.assertActiveSession(sessionId, id);
			return runtime.handlers.prepareTransfer(body);
		},
		submit: async (id, sessionId, key, body) => {
			store.assertActiveSession(sessionId, id);
			store.assertSubmissionOwner(id, key, sessionId);
			return withPayer(
				id,
				"submit",
				async () => {
					store.assertActiveSession(sessionId, id);
					return (await load(id)).handlers.submit(key, body);
				},
				key,
			);
		},
		status: async (id, key) => (await load(id)).handlers.submission(key),
		reconcilePending: async () => {
			let failed = false;
			for (const account of store.accounts()) {
				try {
					// Scan source journals even when no browser has loaded this account.
					// Absent/empty ledgers never create a runtime or provision a vault.
					if (!existsSync(account.config.journalPath)) continue;
					const pending = new SubmissionJournal(account.config.journalPath).listPending();
					if (!pending.length) continue;
					const { service } = await load(account.id);
					// Historical profiles have no submission capability. Their evidence
					// remains pending and continues blocking the shared payer.
					if (!service) continue;
					for (const entry of pending) {
						try {
							await service.status(entry.id);
						} catch {
							failed = true;
						}
					}
				} catch {
					failed = true;
				}
			}
			// Do not expose provider errors, account identifiers or retained hashes.
			if (failed) throw new Error("pending receipt reconciliation failed safely");
		},
		submissionIds: async (id) => (await load(id)).service?.journal.recoveryIds() ?? [],
		releaseSession: (sessionId) => {
			for (const [id, promise] of runtimes)
				void promise
					.then((runtime) => {
						runtime.service?.forgetApprovalsFor(
							(key) => store.submissionOwner(id, key) === sessionId,
						);
					})
					.catch(() => undefined);
		},
	};
}
export function createAccountGateway(config: BackendConfig, store: AccountStore): AccountGateway {
	return compose(config, store, {
		provisioner: createConfiguredAutomaticPwaProvisioner,
		runtime: createConfiguredSubmissionRuntime,
	});
}
export function createAccountGatewayForTestsOnly(
	config: BackendConfig,
	store: AccountStore,
	factories: Factories,
): AccountGateway {
	if (process.env.NODE_ENV !== "test")
		throw new Error("test account runtime factories are disabled");
	return compose(config, store, factories);
}
