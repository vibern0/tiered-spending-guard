import type { BackendPasskeyRole, StoredCredential } from "../auth/webauthn";
import type { BackendConfig } from "../config/config";
import type { BackendHandlerSet } from "../vaults/types";

export type AccountGateway = Readonly<{
	handlers(accountId: string): Promise<BackendHandlerSet>;
	provision(accountId: string): Promise<ProvisioningStatus>;
	runProvisioning?(accountId: string, stopping?: () => boolean): Promise<void>;
	prepare(accountId: string, sessionId: string, body: unknown): Promise<unknown>;
	submit(accountId: string, sessionId: string, id: string, body: unknown): Promise<unknown>;
	status(accountId: string, id: string): Promise<unknown>;
	reconcilePending?(stopping?: () => boolean): Promise<void>;
	submissionIds?(accountId: string): Promise<readonly string[]>;
	releaseSession?(sessionId: string): void;
}>;

export type AccountRecord = Readonly<{
	id: string;
	userHandle: string;
	state: "registering" | "queued" | "provisioning" | "verified" | "blocked";
	creationAttempts: number;
	creationError?: string;
	config: BackendConfig;
}>;

export type AccountCredential = StoredCredential &
	Readonly<{ accountId: string; userHandle?: string }>;

export type AccountSession = Readonly<{
	id: string;
	accountId?: string;
	authenticated: boolean;
	csrfToken: string;
}>;

export type NewAccountSession = AccountSession & Readonly<{ token: string }>;

export type AccountChallenge = Readonly<{
	id: string;
	challenge: string;
	role?: BackendPasskeyRole;
}>;

export type ProvisioningStatus = Readonly<{ state: AccountRecord["state"]; error?: string }>;
