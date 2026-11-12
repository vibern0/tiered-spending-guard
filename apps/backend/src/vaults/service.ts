import { createVaultCredentials } from "../auth/vault-credentials";
import { type BackendPreparedSubmission } from "../submissions/types";
import type {
	BackendHandlerOptions,
	BackendHandlerSet,
	BackendIntent,
	BackendVaultRecord,
	VaultProvisioningResult,
} from "./types";

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

export function createBackendHandlers(options: BackendHandlerOptions): BackendHandlerSet {
	let vault: BackendVaultRecord | undefined;
	let publicVaultBase: Omit<VaultProvisioningResult, "credentialRebind"> | undefined;
	let provisioning: Promise<VaultProvisioningResult> | undefined;
	const getRecoveryCredentials = () => options.provisioner.recoveryCredentials;
	const historicalVault = options.provisioner.historicalVault;
	const requireWritable = () => {
		if (historicalVault)
			throw new Error(
				"historical vault is read-only; transfers and credential changes are disabled",
			);
	};

	const {
		currentCredential,
		credentialRebindStatus,
		storeCredential,
		rebindCoordinates,
		storeReboundCredential,
		verifyApproval,
	} = createVaultCredentials(
		options,
		{
			get: () => vault,
			set: (next) => {
				vault = next;
			},
		},
		() => requireReadyVault(),
		() => requireVault(),
		requireWritable,
	);

	const getReadiness = () =>
		Object.freeze({
			provisioningReady: !historicalVault && options.config.id === "local",
			writesReady:
				!historicalVault &&
				Boolean(
					vault &&
					options.prepareTransfer &&
					options.submit &&
					options.submission &&
					credentialRebindStatus().primary === "ready" &&
					(options.actionSpecificApprovals ||
						credentialRebindStatus().secondary === "ready"),
				),
		});

	const publicResult = (): VaultProvisioningResult => {
		if (!publicVaultBase) throw new Error("vault is not provisioned");
		return Object.freeze({ ...publicVaultBase, credentialRebind: credentialRebindStatus() });
	};

	const autoProvisionVault = (input: unknown): Promise<VaultProvisioningResult> => {
		if (historicalVault)
			return Promise.reject(
				new Error(
					"historical vault is read-only; current-profile provisioning is disabled",
				),
			);
		const body = record(input, "automatic vault provisioning request");
		if (Object.keys(body).length !== 0)
			return Promise.reject(
				new Error("automatic vault provisioning body contains an unsupported field"),
			);
		if (options.config.id !== "local")
			return Promise.reject(
				new Error("automatic vault provisioning is available only in the local profile"),
			);
		if (publicVaultBase) return Promise.resolve(publicResult());
		if (provisioning) return provisioning;
		const primary = currentCredential("primary");
		const secondary = currentCredential("secondary");
		const recoveryCredentials = getRecoveryCredentials();
		if (recoveryCredentials) {
			if (
				primary &&
				(primary.x !== recoveryCredentials.primary.x ||
					primary.y !== recoveryCredentials.primary.y)
			)
				return Promise.reject(
					new Error(
						"registered primary credential does not match the recovered role key",
					),
				);
			if (
				secondary &&
				(secondary.x !== recoveryCredentials.secondary.x ||
					secondary.y !== recoveryCredentials.secondary.y)
			)
				return Promise.reject(
					new Error(
						"registered secondary credential does not match the recovered role key",
					),
				);
		}
		const operation = options.provisioner
			.provision(primary && secondary ? { primary, secondary } : undefined)
			.then((completed) => {
				const recovered = getRecoveryCredentials();
				const currentPrimary = currentCredential("primary"),
					currentSecondary = currentCredential("secondary");
				if (
					recovered &&
					((currentPrimary &&
						(currentPrimary.x !== recovered.primary.x ||
							currentPrimary.y !== recovered.primary.y)) ||
						(currentSecondary &&
							(currentSecondary.x !== recovered.secondary.x ||
								currentSecondary.y !== recovered.secondary.y)))
				)
					throw new Error("registered credentials do not match the recovered role keys");
				if (
					completed.response.chainId !== options.config.chainId ||
					completed.response.usdc.toLowerCase() !== options.usdc.toLowerCase()
				)
					throw new Error("verified provisioning result does not match backend identity");
				vault = Object.freeze({
					...completed.response,
					primaryCredentialId: currentPrimary?.id ?? "",
					secondaryCredentialId: currentSecondary?.id ?? "",
					verifiedProvisioning: completed.verified,
					...(completed.plan ? { provisioningPlan: completed.plan } : {}),
				});
				publicVaultBase = completed.response;
				return publicResult();
			});
		provisioning = operation;
		void operation
			.finally(() => {
				if (!vault) provisioning = undefined;
			})
			.catch(() => undefined);
		return operation;
	};

	const requireVault = (): BackendVaultRecord => {
		if (!vault) throw new Error("vault is not provisioned");
		return vault;
	};

	const requireReadyVault = (): BackendVaultRecord => {
		requireWritable();
		const current = requireVault();
		const status = credentialRebindStatus();
		if (
			status.primary !== "ready" ||
			(!options.actionSpecificApprovals && status.secondary !== "ready")
		)
			throw new Error(
				"both recovered passkeys must be rebound before spending or reconciliation",
			);
		return current;
	};

	const prepareTransfer = async (input: unknown): Promise<BackendPreparedSubmission> => {
		requireWritable();
		if (!options.prepareTransfer) throw new Error("submission preparation unavailable");
		const request = record(input, "transfer request");
		const kind = request.kind;
		const expected =
			kind === "transfer"
				? ["kind", "recipient", "amount", "idempotencyKey"]
				: kind === "add-recipient"
					? ["kind", "recipient", "idempotencyKey"]
					: ["kind", "queueNonce", "queueFingerprint", "idempotencyKey"];
		if (
			![
				"transfer",
				"add-recipient",
				"cancel-queued",
				"execute-ready",
				"skip-expired",
			].includes(String(kind)) ||
			Object.keys(request).length !== expected.length ||
			Object.keys(request).some((key) => !expected.includes(key))
		)
			throw new Error("submission preparation body contains an unsupported field");
		const intent = (
			kind === "transfer"
				? {
						kind,
						recipient: request.recipient,
						amount: request.amount,
						idempotencyKey: request.idempotencyKey,
					}
				: kind === "add-recipient"
					? { kind, recipient: request.recipient, idempotencyKey: request.idempotencyKey }
					: {
							kind,
							queueNonce: request.queueNonce,
							queueFingerprint: request.queueFingerprint,
							idempotencyKey: request.idempotencyKey,
						}
		) as BackendIntent;
		const prepared = await options.prepareTransfer({
			vault: requireReadyVault(),
			request: intent,
		});
		if (
			prepared.id !== request.idempotencyKey ||
			prepared.publicRequest.kind !== kind ||
			prepared.publicRequest.idempotencyKey !== request.idempotencyKey
		)
			throw new Error("prepared request does not match the server-held intent");
		return prepared;
	};

	const submit = async (id: string, body: unknown): Promise<unknown> => {
		requireWritable();
		if (!options.submit) throw new Error("submission unavailable");
		return options.submit({ vault: requireReadyVault(), id, body });
	};

	const submission = async (id: string): Promise<unknown> => {
		requireWritable();
		if (!options.submission) throw new Error("submission unavailable");
		return await options.submission({ vault: requireReadyVault(), id });
	};

	return Object.freeze({
		autoProvisionVault,
		prepareTransfer,
		submit,
		submission,
		storeCredential,
		verifyApproval,
		rebindCoordinates,
		storeReboundCredential,
		credentialRebindStatus,
		vaultRecord: () => vault,
		getReadiness,
		...(historicalVault ? { historicalVault } : {}),
		currentVault: () => historicalVault ?? (publicVaultBase ? publicResult() : undefined),
	});
}
