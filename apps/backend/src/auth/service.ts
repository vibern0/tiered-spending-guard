import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { createHash } from "node:crypto";
import type { AccountService } from "../accounts/service";
import type { AccountStore } from "../accounts/store";
import type { AccountGateway, AccountRecord, AccountSession } from "../accounts/types";
import type { BackendConfig } from "../config/config";
import { AccountHttpError } from "./errors";
import type { AuthSessionAction, AuthSessionContext } from "./types";
import { type BackendPasskeyRole, verifyPasskeyLogin, verifyPasskeyRegistration } from "./webauthn";

type AuthConfig = Pick<BackendConfig, "rpId" | "origin">;
type AuthGateway = Pick<AccountGateway, "releaseSession">;

/** Reject unsupported registration fields rather than accepting hidden request options. */
function exactRegistrationFields(value: Record<string, unknown>, keys: readonly string[]): void {
	if (Object.keys(value).sort().join() !== [...keys].sort().join()) {
		throw new AccountHttpError(400, "unsupported request fields");
	}
}

export class AccountAuthService {
	/** Bind login/session persistence and approval cleanup to the configured WebAuthn identity. */
	constructor(
		private readonly config: AuthConfig,
		private readonly store: AccountStore,
		private readonly gateway: AuthGateway,
		private readonly accounts: Pick<AccountService, "create">,
	) {}

	/** Resume an unfinished setup session or create one, requiring authenticated users to sign out first. */
	setup(current: AccountSession | undefined): AuthSessionAction {
		if (current?.authenticated) {
			throw new AccountHttpError(409, "sign out before creating another account");
		}
		if (current?.accountId) {
			return { session: current };
		}
		const created = this.accounts.create();
		return { session: created, replacement: created };
	}

	/** Ensure login challenges have a server-side session without granting account authentication. */
	loginSession(current: AccountSession | undefined): AuthSessionAction {
		if (current) {
			return { session: current };
		}
		const created = this.store.createSession();
		return { session: created, replacement: created };
	}

	/** Create a session-bound login challenge and optionally restrict credential discovery to an account primary key. */
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

	/** Consume the login challenge, verify the primary passkey, and rotate the live session while releasing cached approvals. */
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
		const credential = this.store.credential(assertion.id);
		if (
			!credential ||
			credential.role !== "primary" ||
			(input.accountId !== undefined && credential.accountId !== input.accountId)
		) {
			throw new AccountHttpError(400, "first passkey authentication failed");
		}
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
		if (this.store.session(token)?.id !== session.id) {
			throw new AccountHttpError(401, "sign-in session expired or revoked");
		}
		const created = this.store.createSession(credential.accountId, true);
		this.store.revokeSession(token);
		this.gateway.releaseSession?.(session.id);
		return { session: created, replacement: created };
	}

	/** Revoke the browser session and release its in-memory approvals before requesting cookie removal. */
	logout({ token, session }: AuthSessionContext) {
		this.store.revokeSession(token);
		this.gateway.releaseSession?.(session.id);
		return { clearCookie: true, body: { authenticated: false } } as const;
	}
}

export class AccountRegistrationService {
	/** Bind initial credential enrollment to the configured WebAuthn identity and account registry. */
	constructor(
		private readonly config: AuthConfig,
		private readonly store: AccountStore,
	) {}

	/** Allow only initial role enrollment and require primary-key authentication before adding the secondary key. */
	private assertRegistrationAllowed(
		account: AccountRecord,
		role: BackendPasskeyRole,
		session: AccountSession,
	): void {
		if (
			account.state !== "registering" ||
			this.store.credentials(account.id).some((credential) => credential.role === role)
		) {
			throw new AccountHttpError(
				409,
				"existing signer cannot be replaced through registration",
			);
		}
		if (role === "secondary" && !session.authenticated) {
			throw new AccountHttpError(401, "sign in with your first passkey");
		}
	}

	/** Issue initial-enrollment options with role-separated user handles and cross-platform secondary enrollment. */
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

	/** Consume a role-bound enrollment challenge, verify the public key, and store immutable credential metadata. */
	async verify(
		account: AccountRecord,
		session: AccountSession,
		role: BackendPasskeyRole,
		input: Record<string, unknown>,
	) {
		this.assertRegistrationAllowed(account, role, session);
		exactRegistrationFields(input, ["sessionId", "registration"]);
		if (typeof input.sessionId !== "string" || !input.registration) {
			throw new AccountHttpError(400, "registration response required");
		}
		const challenge = this.store.consumeChallenge(
			session.id,
			input.sessionId,
			"registration",
			role,
		);
		const response = input.registration as RegistrationResponseJSON;
		const verified = await verifyPasskeyRegistration({
			role,
			credentialId: response.id,
			challenge: challenge.challenge,
			rpId: this.config.rpId,
			origin: this.config.origin,
			response,
		});
		this.store.storeCredential(
			account.id,
			verified,
			role === "primary" ? account.userHandle : undefined,
		);
		return { role, credentialId: verified.id, counter: verified.counter };
	}
}
