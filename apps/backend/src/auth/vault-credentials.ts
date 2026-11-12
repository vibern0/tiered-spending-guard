import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import type { Hex } from "viem";
import type {
	BackendHandlerOptions,
	BackendVaultRecord,
	CredentialRebindStatus,
} from "../vaults/types";
import {
	challengeForDigest,
	encodeP256CosePublicKey,
	verifyPasskeyAssertion,
	type BackendPasskeyRole,
	type StoredCredential,
	type VerifiedPasskeyApproval,
} from "./webauthn";

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function role(value: unknown): BackendPasskeyRole {
	if (value !== "primary" && value !== "secondary") throw new Error("unsupported passkey role");
	return value;
}

/** Credential readiness and exact approval verification for one verified vault. */
export function createVaultCredentials(
	options: BackendHandlerOptions,
	state: { get(): BackendVaultRecord | undefined; set(value: BackendVaultRecord): void },
	requireReadyVault: () => BackendVaultRecord,
	requireVault: () => BackendVaultRecord,
	requireWritable: () => void,
) {
	const getRecoveryCredentials = () => options.provisioner.recoveryCredentials;
	const credentials = new Map<
		BackendPasskeyRole,
		StoredCredential & Readonly<{ role: BackendPasskeyRole; credentialId: string }>
	>();
	const currentCredential = (role: BackendPasskeyRole) => {
		const c = options.credentialStore
			? options.credentialStore.get(role)
			: credentials.get(role);
		return c && { ...c, credentialId: c.id };
	};
	const credentialRebindStatus = (): CredentialRebindStatus => {
		const matches = (role: BackendPasskeyRole) => {
			const actual = currentCredential(role),
				expected = getRecoveryCredentials()?.[role];
			return (
				actual !== undefined &&
				(!expected || (actual.x === expected.x && actual.y === expected.y))
			);
		};
		const primary = matches("primary") ? ("ready" as const) : ("required" as const);
		const secondary = matches("secondary") ? ("ready" as const) : ("required" as const);
		return Object.freeze({
			required:
				getRecoveryCredentials() !== undefined &&
				(primary === "required" ||
					(!options.actionSpecificApprovals && secondary === "required")),
			primary,
			secondary,
		});
	};

	const storeCredential = (
		credential: StoredCredential & Readonly<{ role: BackendPasskeyRole; credentialId: string }>,
	): void => {
		requireWritable();
		const passkeyRole = role(credential.role);
		if (!credential.id || credential.id !== credential.credentialId)
			throw new Error("credential metadata is not self-consistent");
		const recovered = getRecoveryCredentials()?.[passkeyRole];
		if (recovered && (credential.x !== recovered.x || credential.y !== recovered.y))
			throw new Error("credential does not match the recovered role key");
		const existing = credentials.get(passkeyRole);
		if (existing) throw new Error(`${passkeyRole} credential is already registered`);
		for (const [existingRole, current] of credentials) {
			if (
				existingRole !== passkeyRole &&
				(current.id === credential.id ||
					Buffer.from(current.publicKey).equals(Buffer.from(credential.publicKey)) ||
					(current.x === credential.x && current.y === credential.y))
			) {
				throw new Error("primary and secondary credentials must be distinct");
			}
		}
		credentials.set(passkeyRole, Object.freeze({ ...credential, role: passkeyRole }));
	};

	const rebindCoordinates = (
		passkeyRole: BackendPasskeyRole,
	): Readonly<{ x: bigint; y: bigint }> => {
		requireWritable();
		role(passkeyRole);
		const normalized = passkeyRole;
		requireVault();
		const recoveryCredentials = getRecoveryCredentials();
		if (options.config.id !== "local" || !recoveryCredentials)
			throw new Error("credential rebind is unavailable");
		if (credentials.has(normalized))
			throw new Error(`${normalized} credential is already ready`);
		return recoveryCredentials[normalized];
	};

	const storeReboundCredential = (
		credential: StoredCredential & Readonly<{ role: BackendPasskeyRole; credentialId: string }>,
	): CredentialRebindStatus => {
		const expected = rebindCoordinates(credential.role);
		if (credential.x !== expected.x || credential.y !== expected.y)
			throw new Error("rebound credential does not match the reviewed role key");
		storeCredential(credential);
		const vault = state.get();
		if (vault)
			state.set(
				Object.freeze({
					...vault,
					...(credential.role === "primary"
						? { primaryCredentialId: credential.id }
						: { secondaryCredentialId: credential.id }),
				}),
			);
		return credentialRebindStatus();
	};

	const verifyApproval = async (
		safeTxHash: Hex,
		input: unknown,
	): Promise<VerifiedPasskeyApproval> => {
		requireWritable();
		if (!/^0x[0-9a-fA-F]{64}$/.test(safeTxHash))
			throw new Error("server-held Safe transaction hash is invalid");
		const body = record(input, "passkey approval");
		const passkeyRole = role(body.role);
		const assertion = record(
			body.assertion,
			"passkey assertion",
		) as unknown as AuthenticationResponseJSON;
		requireReadyVault();
		let stored = currentCredential(passkeyRole);
		const expected = getRecoveryCredentials()?.[passkeyRole];
		const learned = !stored && options.actionSpecificApprovals && expected;
		if (learned)
			stored = {
				role: passkeyRole,
				id: assertion.id,
				credentialId: assertion.id,
				publicKey: encodeP256CosePublicKey(expected!),
				counter: 0,
				...expected!,
			};
		if (stored && expected && (stored.x !== expected.x || stored.y !== expected.y))
			throw new Error("credential does not match the reviewed role key");
		if (!stored) throw new Error(`${passkeyRole} credential is not registered`);
		const currentVault = requireReadyVault();
		const approval = await (options.verifyAssertion ?? verifyPasskeyAssertion)({
			role: passkeyRole,
			safe: currentVault.safe,
			chainId: options.config.chainId,
			safeTxHash,
			challenge: challengeForDigest(safeTxHash),
			binding: { safe: currentVault.safe, chainId: options.config.chainId, safeTxHash },
			rpId: options.config.rpId,
			origin: options.config.origin,
			credentialId: stored.id,
			response: assertion,
			credential: stored,
		});
		if (
			approval.role !== passkeyRole ||
			approval.credentialId !== stored.id ||
			approval.counter < stored.counter
		)
			throw new Error("verified passkey approval does not match stored credential metadata");
		if (learned) options.credentialStore?.learn(stored, approval, safeTxHash);
		else options.credentialStore?.updateCounter(stored, approval.counter, approval, safeTxHash);
		credentials.set(passkeyRole, Object.freeze({ ...stored, counter: approval.counter }));
		const vault = state.get();
		if (vault && learned)
			state.set(
				Object.freeze({
					...vault,
					...(passkeyRole === "primary"
						? { primaryCredentialId: stored.id }
						: { secondaryCredentialId: stored.id }),
				}),
			);
		return approval;
	};

	return {
		currentCredential,
		credentialRebindStatus,
		storeCredential,
		rebindCoordinates,
		storeReboundCredential,
		verifyApproval,
	};
}
