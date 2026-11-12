import type { BackendPasskeyRole, StoredCredential } from "../auth/webauthn";
import type { BackendConfig } from "../config/config";
import type { BackendHandlerSet, VaultProvisioningResult } from "../vaults/types";

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

export type AccountRecord = Readonly<{
	id: string;
	userHandle: string;
	state: "registering" | "queued" | "provisioning" | "verified";
	legacy: boolean;
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
