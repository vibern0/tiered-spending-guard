import type {
	PwaProvisioningPlan,
	PwaProvisioningResult,
} from "@tiered-spending-guard/security-core/pwa";
import type { Address, Hex } from "viem";
import type { VerifiedPasskeyApproval } from "../auth/webauthn";
import { type BackendPasskeyRole, type StoredCredential } from "../auth/webauthn";
import type { BackendConfig } from "../config/config";
import type { AutomaticPwaProvisioner } from "../provisioning/service";
import type { BackendPreparedSubmission } from "../submissions/types";

export type VaultProvisioningResult = Readonly<{
	chainId: 11155111;
	safe: `0x${string}`;
	guard: `0x${string}`;
	delay: `0x${string}`;
	primaryPasskey: `0x${string}`;
	secondaryPasskey: `0x${string}`;
	usdc: `0x${string}`;
	evidence: Readonly<{
		setupTransactionHash: `0x${string}`;
		verificationReportHash: `0x${string}`;
		deploymentsHash: `0x${string}`;
		policyHash: `0x${string}`;
		blockNumber: string;
	}>;
	credentialRebind: Readonly<{
		required: boolean;
		primary: "required" | "ready";
		secondary: "required" | "ready";
	}>;
}>;

export type CredentialRebindStatus = Readonly<{
	required: boolean;
	primary: "required" | "ready";
	secondary: "required" | "ready";
}>;

export type BackendVaultRecord = Readonly<
	Omit<VaultProvisioningResult, "credentialRebind"> & {
		primaryCredentialId: string;
		secondaryCredentialId: string;
		verifiedProvisioning: PwaProvisioningResult;
		provisioningPlan?: PwaProvisioningPlan;
	}
>;

export type BackendIntent =
	| Readonly<{ kind: "transfer"; recipient: unknown; amount: unknown; idempotencyKey: unknown }>
	| Readonly<{ kind: "add-recipient"; recipient: unknown; idempotencyKey: unknown }>
	| Readonly<{
			kind: "cancel-queued" | "execute-ready" | "skip-expired";
			queueNonce: unknown;
			queueFingerprint: unknown;
			idempotencyKey: unknown;
	  }>;

export type BackendPreparation = (
	input: Readonly<{ vault: BackendVaultRecord; request: BackendIntent }>,
) => Promise<BackendPreparedSubmission>;

export type BackendSubmission = (
	input: Readonly<{ vault: BackendVaultRecord; id: string; body: unknown }>,
) => Promise<unknown>;

export type BackendSubmissionReader = (
	input: Readonly<{ vault: BackendVaultRecord; id: string }>,
) => Promise<unknown>;

export type BackendHandlerOptions = Readonly<{
	config: BackendConfig;
	usdc: Address;
	provisioner: AutomaticPwaProvisioner;
	prepareTransfer?: BackendPreparation;
	submit?: BackendSubmission;
	submission?: BackendSubmissionReader;
	credentialStore: Readonly<{
		get(role: BackendPasskeyRole): StoredCredential | undefined;
		updateCounter(
			credential: StoredCredential,
			next: number,
			approval: VerifiedPasskeyApproval,
			safeTxHash: Hex,
		): void;
	}>;
}>;

export type BackendHandlerSet = Readonly<{
	autoProvisionVault(body: unknown): Promise<VaultProvisioningResult>;
	prepareTransfer(body: unknown): Promise<BackendPreparedSubmission>;
	submit(id: string, body: unknown): Promise<unknown>;
	submission(id: string): Promise<unknown>;
	verifyApproval(safeTxHash: Hex, body: unknown): Promise<VerifiedPasskeyApproval>;
	vaultRecord(): BackendVaultRecord | undefined;
	currentVault(): VaultProvisioningResult | undefined;
	getReadiness(): Readonly<{ provisioningReady: boolean; writesReady: boolean }>;
}>;
