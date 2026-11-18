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

/** Compose per-account runtimes with shared payer serialization, session checks and durable approval consumption. */
function compose(config: BackendConfig, store: AccountStore, factories: Factories): AccountGateway {
	const payer = privateKeyToAccount(config.relayPrivateKey).address;
	const runtimes = new Map<string, Promise<AccountRuntime>>();
	const { withPayer } = createPayerCoordinator(store, payer);
	/** Recheck retained evidence and the initiating session before a submission reaches signing or broadcast. */
	const assertSession = (accountId: string, id: string) => {
		store.validateEvidenceInventory();
		const owner = store.submissionOwner(accountId, id);
		if (!owner) {
			throw new Error("submission has no initiating session");
		}
		store.assertActiveSession(owner, accountId);
	};
	/** Cache account runtimes, require retained verified evidence, and recover completed provisioning from its journal. */
	const load = (id: string): Promise<AccountRuntime> => {
		const previous = runtimes.get(id);
		if (previous) {
			return previous;
		}
		const loading = (async () => {
			const a = store.account(id);
			if (!a) {
				throw new Error("unknown account");
			}
			if (
				a.state === "verified" &&
				(!existsSync(a.config.provisioningJournalPath) || !existsSync(a.config.journalPath))
			) {
				throw new Error("verified account evidence disappeared");
			}
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
				/** Revalidate prepared chain state between checks that the initiating session remains active. */
				revalidate: async (p) => {
					assertSession(id, p.id);
					await runtime.revalidate(p);
					assertSession(id, p.id);
				},
				/** Derive the outer transaction hash while preventing an expired session from progressing afterward. */
				deriveOuterHash: async (p, approvals) => {
					assertSession(id, p.id);
					const hash = await runtime.deriveOuterHash(p, approvals);
					assertSession(id, p.id);
					return hash;
				},
				/** Require the initiating session immediately before handing the signed transaction to the chain runtime. */
				broadcast: async (p, approvals, hash) => {
					assertSession(id, p.id);
					return runtime.broadcast(p, approvals, hash);
				},
				reconcile: runtime.reconcile,
				discard: runtime.discard,
				/** Verify a fresh assertion against the prepared Safe hash and retain only its role and contract payload. */
				verifyApproval: async (role, prepared, assertion) => {
					assertSession(id, prepared.id);
					if (!prepared.safeTxHash) {
						throw new Error("exact Safe transaction hash required");
					}
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
					/** Resolve public signer metadata exclusively from this account role registry. */
					get: (role) => store.credentials(id).find((c) => c.role === role),
					/** Consume the verified approval atomically using a signature-normalized replay fingerprint. */
					updateCounter: (c, next, approval, hash) =>
						store.consumeApproval(
							id,
							c.id,
							c.counter,
							next,
							passkeyApprovalFingerprint(approval, hash),
						),
				},
				/** Prepare and journal a transfer using this account runtime configuration. */
				prepareTransfer: async (input) => service.prepare(await runtime.prepare(input)),
				/** Route a prepared submission through the approval and broadcast state machine. */
				submit: async ({ id, body }) => service.submit(id, body as never),
				/** Read and reconcile the submission state from this account journal. */
				submission: async ({ id }) => service.status(id),
			});
			if (provisioner.completedRecoveryReady) {
				const completed = await handlers.autoProvisionVault({});
				if (a.state !== "verified") {
					service.journal.ensurePersisted();
				}
				store.completeCreation(id, completed);
			}
			return { handlers, provisioner, service };
		})();
		runtimes.set(id, loading);
		void loading.catch(() => {
			if (runtimes.get(id) === loading) {
				runtimes.delete(id);
			}
		});
		return loading;
	};

	return {
		/** Load the account runtime and expose its vault and credential operations. */
		handlers: async (id) => (await load(id)).handlers,
		/** Read registry provisioning status without initiating a deployment. */
		provision: async (id) => {
			const account = store.account(id);
			if (!account) {
				throw new Error("unknown account");
			}
			return {
				state: account.state,
				...(account.creationError ? { error: account.creationError } : {}),
			};
		},
		/** Serialize a bounded creation attempt with the shared payer and preserve recoverable failure state. */
		runProvisioning: (id, stopping) =>
			withPayer(id, "provision", async () => {
				if (stopping?.()) {
					return;
				}
				const account = store.account(id);
				if (!account || !["queued", "provisioning"].includes(account.state)) {
					return;
				}
				if (account.creationAttempts < 3) {
					store.beginCreation(id);
				}
				try {
					const { handlers, service } = await load(id);
					if (store.account(id)?.state === "verified") {
						runtimes.delete(id);
						return;
					}
					if (account.creationAttempts >= 3) {
						throw new Error("creation retry budget exhausted");
					}
					const credentials = store.credentials(id);
					if (
						credentials.length !== 2 ||
						!credentials.some((c) => c.role === "primary") ||
						!credentials.some((c) => c.role === "secondary")
					) {
						throw new Error("two verified registrations required before provisioning");
					}
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
		/** Bind an idempotent transfer preparation to its authenticated initiating session before loading the runtime. */
		prepare: async (id, sessionId, body) => {
			store.assertActiveSession(sessionId, id);
			if (
				!body ||
				typeof body !== "object" ||
				typeof (body as { idempotencyKey?: unknown }).idempotencyKey !== "string"
			) {
				throw new Error("idempotency key required");
			}
			const key = (body as { idempotencyKey: string }).idempotencyKey;
			if (!/^[A-Za-z0-9._:-]{1,160}$/.test(key)) {
				throw new Error("invalid idempotency key");
			}
			store.claimSubmission(id, key, sessionId);
			const runtime = await load(id);
			store.assertActiveSession(sessionId, id);
			return runtime.handlers.prepareTransfer(body);
		},
		/** Require session ownership and serialize payer access before submitting the account transaction. */
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
		/** Resolve a submission status through its account-specific runtime and journal. */
		status: async (id, key) => (await load(id)).handlers.submission(key),
		/** Reconcile retained pending submissions across accounts without loading runtimes for empty journals. */
		reconcilePending: async (stopping) => {
			let failed = false;
			for (const account of store.accounts()) {
				if (stopping?.()) {
					break;
				}
				try {
					// Scan source journals even when no browser has loaded this account.
					// Absent/empty ledgers never create a runtime or provision a vault.
					if (!existsSync(account.config.journalPath)) {
						continue;
					}
					const pending = new SubmissionJournal(account.config.journalPath).listPending();
					if (!pending.length) {
						continue;
					}
					const { service } = await load(account.id);
					for (const entry of pending) {
						if (stopping?.()) {
							break;
						}
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
			if (failed) {
				throw new Error("pending receipt reconciliation failed safely");
			}
		},
		/** Expose retained recovery identifiers from the account submission journal. */
		submissionIds: async (id) => (await load(id)).service.journal.recoveryIds() ?? [],
		/** Remove cached approvals owned by a revoked session from every already-loaded account runtime. */
		releaseSession: (sessionId) => {
			for (const [id, promise] of runtimes) {
				void promise
					.then((runtime) => {
						runtime.service.forgetApprovalsFor(
							(key) => store.submissionOwner(id, key) === sessionId,
						);
					})
					.catch(() => undefined);
			}
		},
	};
}
/** Build the account gateway using the configured provisioning and submission implementations. */
export function createAccountGateway(config: BackendConfig, store: AccountStore): AccountGateway {
	return compose(config, store, {
		provisioner: createConfiguredAutomaticPwaProvisioner,
		runtime: createConfiguredSubmissionRuntime,
	});
}
/** Allow injected runtime factories exclusively under the test environment guard. */
export function createAccountGatewayForTestsOnly(
	config: BackendConfig,
	store: AccountStore,
	factories: Factories,
): AccountGateway {
	if (process.env.NODE_ENV !== "test") {
		throw new Error("test account runtime factories are disabled");
	}
	return compose(config, store, factories);
}
