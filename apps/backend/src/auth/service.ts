import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { createHash } from "node:crypto";
import type { AccountService } from "../accounts/service";
import type { AccountStore } from "../accounts/store";
import type { AccountGateway, AccountRecord, AccountSession } from "../accounts/types";
import type { BackendConfig } from "../config/config";
import { AccountHttpError } from "./errors";
import type { AuthSessionAction, AuthSessionContext } from "./types";
import {
	type BackendPasskeyRole,
	verifyPasskeyLogin,
	verifyPasskeyRebind,
	verifyPasskeyRegistration,
} from "./webauthn";

type AuthConfig = Pick<BackendConfig, "rpId" | "origin">;
type AuthGateway = Pick<AccountGateway, "legacyCoordinates" | "releaseSession">;

function exactRegistrationFields(value: Record<string, unknown>, keys: readonly string[]): void {
	if (Object.keys(value).sort().join() !== [...keys].sort().join())
		throw new AccountHttpError(400, "unsupported request fields");
}

export class AccountAuthService {
	constructor(
		private readonly config: AuthConfig,
		private readonly store: AccountStore,
		private readonly gateway: AuthGateway,
		private readonly accounts: Pick<AccountService, "create">,
	) {}

	setup(current: AccountSession | undefined): AuthSessionAction {
		if (current?.authenticated)
			throw new AccountHttpError(409, "sign out before creating another account");
		if (current?.accountId) return { session: current };
		const created = this.accounts.create();
		return { session: created, replacement: created };
	}

	loginSession(current: AccountSession | undefined): AuthSessionAction {
		if (current) return { session: current };
		const created = this.store.createSession();
		return { session: created, replacement: created };
	}

	loginOptions(session: AccountSession, accountId?: string) {
		const challenge = this.store.createChallenge(
			session.id,
			accountId ? `login:${accountId}` : "login",
		);
		const target = accountId ? this.store.account(accountId) : undefined;
		return {
			sessionId: challenge.id,
			challenge: challenge.challenge,
			rpId: this.config.rpId,
			origin: this.config.origin,
			userVerification: "required",
			csrfToken: session.csrfToken,
			...(target
				? {
						accountId: target.id,
						credentialIds: this.store
							.credentials(target.id)
							.filter((credential) => credential.role === "primary")
							.map((credential) => credential.id),
					}
				: {}),
		};
	}

	async verifyLogin(
		context: AuthSessionContext,
		input: Readonly<{
			sessionId: string;
			assertion: AuthenticationResponseJSON;
			accountId?: unknown;
		}>,
	): Promise<AuthSessionAction> {
		const { session, token } = context;
		const challenge = this.store.consumeChallenge(
			session.id,
			input.sessionId,
			input.accountId ? `login:${input.accountId}` : "login",
		);
		const assertion = input.assertion;
		let credential = this.store.credential(assertion.id);
		if (!credential && this.gateway.legacyCoordinates) {
			const target = this.store.account(
				typeof input.accountId === "string" ? input.accountId : "legacy",
			);
			if (!target?.legacy)
				throw new AccountHttpError(400, "first passkey authentication failed");
			const coordinates = await this.gateway.legacyCoordinates(target.id);
			if (!coordinates) throw new AccountHttpError(400, "existing account proof unavailable");
			const verified = await verifyPasskeyRebind({
				role: "primary",
				coordinates,
				challenge: challenge.challenge,
				rpId: this.config.rpId,
				origin: this.config.origin,
				response: assertion,
			});
			this.store.storeCredential(target.id, verified);
			credential = this.store.credential(verified.id);
		} else {
			if (
				!credential ||
				credential.role !== "primary" ||
				(input.accountId !== undefined && credential.accountId !== input.accountId)
			)
				throw new AccountHttpError(400, "first passkey authentication failed");
			const next = await verifyPasskeyLogin({
				credential,
				response: assertion,
				challenge: challenge.challenge,
				rpId: this.config.rpId,
				origin: this.config.origin,
				userHandle: credential.userHandle,
				allowMissingUserHandle:
					session.accountId === credential.accountId ||
					input.accountId === credential.accountId,
			});
			this.store.updateCounter(credential.id, credential.counter, next);
		}
		if (this.store.session(token)?.id !== session.id)
			throw new AccountHttpError(401, "sign-in session expired or revoked");
		const created = this.store.createSession(credential!.accountId, true);
		this.store.revokeSession(token);
		this.gateway.releaseSession?.(session.id);
		return { session: created, replacement: created };
	}

	logout({ token, session }: AuthSessionContext) {
		this.store.revokeSession(token);
		this.gateway.releaseSession?.(session.id);
		return { clearCookie: true, body: { authenticated: false } } as const;
	}
}

export class AccountRegistrationService {
	constructor(
		private readonly config: AuthConfig,
		private readonly store: AccountStore,
	) {}

	private assertRegistrationAllowed(
		account: AccountRecord,
		role: BackendPasskeyRole,
		session: AccountSession,
	): void {
		if (
			account.state !== "registering" ||
			this.store.credentials(account.id).some((credential) => credential.role === role)
		)
			throw new AccountHttpError(
				409,
				"existing signer cannot be replaced through registration",
			);
		if (role === "secondary" && !session.authenticated)
			throw new AccountHttpError(401, "sign in with your first passkey");
	}

	options(
		account: AccountRecord,
		session: AccountSession,
		role: BackendPasskeyRole,
		input: Record<string, unknown>,
	) {
		this.assertRegistrationAllowed(account, role, session);
		exactRegistrationFields(input, []);
		const challenge = this.store.createChallenge(session.id, "registration", role);
		return {
			sessionId: challenge.id,
			challenge: challenge.challenge,
			rpId: this.config.rpId,
			origin: this.config.origin,
			role,
			userVerification: "required",
			userHandle:
				role === "primary"
					? account.userHandle
					: createHash("sha256")
							.update(`vault-secondary:${account.userHandle}`)
							.digest("base64url"),
			...(role === "secondary" ? { authenticatorAttachment: "cross-platform" } : {}),
		};
	}

	async verify(
		account: AccountRecord,
		session: AccountSession,
		role: BackendPasskeyRole,
		input: Record<string, unknown>,
	) {
		this.assertRegistrationAllowed(account, role, session);
		exactRegistrationFields(input, ["sessionId", "registration"]);
		if (typeof input.sessionId !== "string" || !input.registration)
			throw new AccountHttpError(400, "registration response required");
		const challenge = this.store.consumeChallenge(
			session.id,
			input.sessionId,
			"registration",
			role,
		);
		const response = input.registration as RegistrationResponseJSON;
		const verified = await verifyPasskeyRegistration(
			{
				role,
				credentialId: response.id,
				challenge: challenge.challenge,
				rpId: this.config.rpId,
				origin: this.config.origin,
				response,
			},
			undefined,
			{ allowSyncedPrimary: true },
		);
		this.store.storeCredential(
			account.id,
			verified,
			role === "primary" ? account.userHandle : undefined,
		);
		return { role, credentialId: verified.id, counter: verified.counter };
	}
}
