import type { AccountGateway } from "./types";
import { type AccountSession, type NewAccountSession } from "./types";
import { AccountStore } from "./store";

type AccountProjectionGateway = Pick<AccountGateway, "handlers" | "submissionIds">;

export class AccountService {
	/** Bind account metadata and runtime projections used to build browser session responses. */
	constructor(
		private readonly store: AccountStore,
		private readonly gateway: AccountProjectionGateway,
	) {}

	/** Create an account registration record and its initial unauthenticated setup session. */
	create(): NewAccountSession {
		const account = this.store.createAccount();
		return this.store.createSession(account.id);
	}

	/** Build the browser session view, exposing vault and recovery submission details only after authentication and verification. */
	async project(session: AccountSession | undefined): Promise<Record<string, unknown>> {
		if (!session) {
			return { authenticated: false };
		}
		const account = session.accountId ? this.store.account(session.accountId) : undefined;
		const credentials = account ? this.store.credentials(account.id) : [];
		const vault =
			session.authenticated && account?.state === "verified"
				? (await this.gateway.handlers(account.id)).currentVault?.()
				: undefined;
		return {
			authenticated: session.authenticated,
			csrfToken: session.csrfToken,
			...(account
				? {
						account: {
							id: account.id,
							userHandle: account.userHandle,
							state: account.state,
							primaryCredentialId: credentials.find(
								(credential) => credential.role === "primary",
							)?.id,
							secondaryCredentialId: credentials.find(
								(credential) => credential.role === "secondary",
							)?.id,
							...(session.authenticated && account.state === "verified"
								? {
										submissionIds:
											(await this.gateway.submissionIds?.(account.id)) ?? [],
									}
								: {}),
							...(vault ? { vault } : {}),
						},
					}
				: {}),
		};
	}
}
