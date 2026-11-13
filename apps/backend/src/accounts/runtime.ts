import { existsSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { passkeyApprovalFingerprint } from "../auth/webauthn";
import { createPayerCoordinator } from "../chain/payer-coordinator";
import type { BackendConfig } from "../config/config";
import { createConfiguredAutomaticPwaProvisioner } from "../provisioning/runtime";
import {
	recoverableProvisioningFailure,
	type AutomaticPwaProvisioner,
} from "../provisioning/service";
import { SubmissionJournal } from "../submissions/journal";
import { createConfiguredSubmissionRuntime } from "../submissions/runtime";
import { PwaSubmissionService, SEPOLIA_USDC_ADDRESS } from "../submissions/service";
import type { ConfiguredSubmissionRuntime } from "../submissions/types";
import { createBackendHandlers } from "../vaults/service";
import { type BackendHandlerSet } from "../vaults/types";
import { AccountStore } from "./store";
import type { AccountGateway } from "./types";
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
	service: PwaSubmissionService;
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
				(!existsSync(a.config.provisioningJournalPath) || !existsSync(a.config.journalPath))
			)
				throw new Error("verified account evidence disappeared");
			const provisioner = await factories.provisioner(a.config);
			// Late-bound: runtime callbacks capture handlers before their construction.
			// eslint-disable-next-line prefer-const
			let handlers: BackendHandlerSet;
			const runtime = factories.runtime(
				a.config,
				() => handlers?.vaultRecord(),
				(key) => assertSession(id, key),
			);
			const service = new PwaSubmissionService({
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
				discard: runtime.discard,
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
			});
			handlers = createBackendHandlers({
				config: a.config,
				usdc: SEPOLIA_USDC_ADDRESS,
				provisioner,
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
				},
				prepareTransfer: async (input) => service.prepare(await runtime.prepare(input)),
				submit: async ({ id, body }) => service.submit(id, body as never),
				submission: async ({ id }) => service.status(id),
			});
			if (provisioner.completedRecoveryReady) {
				const completed = await handlers.autoProvisionVault({});
				if (a.state !== "verified") service.journal.ensurePersisted();
				store.completeCreation(id, completed);
			}
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
		provision: async (id) => {
			const account = store.account(id);
			if (!account) throw new Error("unknown account");
			return {
				state: account.state,
				...(account.creationError ? { error: account.creationError } : {}),
			};
		},
		runProvisioning: (id, stopping) =>
			withPayer(id, "provision", async () => {
				if (stopping?.()) return;
				const account = store.account(id);
				if (!account || !["queued", "provisioning"].includes(account.state)) return;
				if (account.creationAttempts < 3) store.beginCreation(id);
				try {
					const { handlers, service } = await load(id);
					if (store.account(id)?.state === "verified") {
						runtimes.delete(id);
						return;
					}
					if (account.creationAttempts >= 3)
						throw new Error("creation retry budget exhausted");
					const credentials = store.credentials(id);
					if (
						credentials.length !== 2 ||
						!credentials.some((c) => c.role === "primary") ||
						!credentials.some((c) => c.role === "secondary")
					)
						throw new Error("two verified registrations required before provisioning");
					const completed = await handlers.autoProvisionVault({});
					service.journal.ensurePersisted();
					store.completeCreation(id, completed);
					runtimes.delete(id);
				} catch (error) {
					runtimes.delete(id);
					store.creationFailed(
						id,
						recoverableProvisioningFailure(error) ||
							(error instanceof Error &&
								error.message.includes("awaiting canonical confirmations")),
					);
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
		reconcilePending: async (stopping) => {
			let failed = false;
			for (const account of store.accounts()) {
				if (stopping?.()) break;
				try {
					// Scan source journals even when no browser has loaded this account.
					// Absent/empty ledgers never create a runtime or provision a vault.
					if (!existsSync(account.config.journalPath)) continue;
					const pending = new SubmissionJournal(account.config.journalPath).listPending();
					if (!pending.length) continue;
					const { service } = await load(account.id);
					for (const entry of pending) {
						if (stopping?.()) break;
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
		submissionIds: async (id) => (await load(id)).service.journal.recoveryIds() ?? [],
		releaseSession: (sessionId) => {
			for (const [id, promise] of runtimes)
				void promise
					.then((runtime) => {
						runtime.service.forgetApprovalsFor(
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
