import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import type { Hex } from "viem";
import type {
	BackendHandlerOptions,
	BackendVaultRecord,
	CredentialRebindStatus,
} from "../vaults/types";
import { challengeForDigest, verifyPasskeyAssertion, type BackendPasskeyRole } from "./webauthn";

/** Public metadata comes from SQLite; reviewed onchain keys remain the spending authority. */
export function createVaultCredentials(
	options: BackendHandlerOptions,
	requireVault: () => BackendVaultRecord,
) {
	const currentCredential = (role: BackendPasskeyRole) => {
		const stored = options.credentialStore.get(role);
		const expected = options.provisioner.recoveryCredentials?.[role];
		if (stored && expected && (stored.x !== expected.x || stored.y !== expected.y))
			throw new Error("credential does not match the reviewed role key");
		return stored;
	};
	const credentialRebindStatus = (): CredentialRebindStatus => {
		const primary = currentCredential("primary") ? ("ready" as const) : ("required" as const);
		const secondary = currentCredential("secondary")
			? ("ready" as const)
			: ("required" as const);
		return { required: primary !== "ready", primary, secondary };
	};
	const verifyApproval = async (safeTxHash: Hex, input: unknown) => {
		if (!/^0x[0-9a-fA-F]{64}$/.test(safeTxHash))
			throw new Error("server-held Safe transaction hash is invalid");
		if (!input || typeof input !== "object" || Array.isArray(input))
			throw new Error("passkey approval must be an object");
		const { role, assertion } = input as { role?: unknown; assertion?: unknown };
		if (role !== "primary" && role !== "secondary") throw new Error("unsupported passkey role");
		if (!assertion || typeof assertion !== "object" || Array.isArray(assertion))
			throw new Error("passkey assertion must be an object");
		const stored = currentCredential(role);
		if (!stored) throw new Error(`${role} credential is not registered`);
		const vault = requireVault();
		const approval = await verifyPasskeyAssertion({
			role,
			safe: vault.safe,
			chainId: options.config.chainId,
			safeTxHash,
			challenge: challengeForDigest(safeTxHash),
			binding: { safe: vault.safe, chainId: options.config.chainId, safeTxHash },
			rpId: options.config.rpId,
			origin: options.config.origin,
			credentialId: stored.id,
			credential: stored,
			response: assertion as AuthenticationResponseJSON,
		});
		if (
			approval.role !== role ||
			approval.credentialId !== stored.id ||
			approval.counter < stored.counter
		)
			throw new Error("verified passkey approval does not match stored credential metadata");
		options.credentialStore.updateCounter(stored, approval.counter, approval, safeTxHash);
		return approval;
	};
	return { currentCredential, credentialRebindStatus, verifyApproval };
}
