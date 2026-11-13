import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccountService } from "../src/accounts/service";
import { AccountStore } from "../src/accounts/store";
import { AccountAuthService, AccountRegistrationService } from "../src/auth/service";
import { encodeP256CosePublicKey } from "./webauthn-fixtures";
import { loadBackendConfig } from "../src/config/config";
import { softwareAuthenticator } from "./automatic-http-fixtures";

const stores: AccountStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "vault-auth-service-"));
	const config = loadBackendConfig({
		BACKEND_PROFILE: "local",
		BACKEND_RELAY_PRIVATE_KEY: `0x${"11".repeat(32)}`,
		BACKEND_RPC_URL: "https://unused.invalid",
		BACKEND_DATA_DIRECTORY: directory,
	});
	const store = new AccountStore(config);
	stores.push(store);
	const accounts = new AccountService(store, {
		handlers: async () => {
			throw new Error("chain projection unavailable in authentication-only test");
		},
	});
	return { config, store, accounts };
}

describe("account authentication workflow", () => {
	it("keeps first-key and immutable-registration gates ahead of registration input validation", async () => {
		const { config, store } = fixture();
		const account = store.createAccount();
		const session = store.createSession(account.id);
		const registrations = new AccountRegistrationService(config, store);
		expect(() =>
			registrations.options(account, session, "secondary", { unexpected: true }),
		).toThrow("sign in with your first passkey");
		await expect(registrations.verify(account, session, "secondary", {})).rejects.toMatchObject(
			{ status: 401 },
		);
		const key = softwareAuthenticator("primary");
		const options = registrations.options(account, session, "primary", {});
		await registrations.verify(account, session, "primary", {
			sessionId: options.sessionId,
			registration: key.registration(options.challenge),
		});
		expect(() =>
			registrations.options(account, session, "primary", { unexpected: true }),
		).toThrow("existing signer cannot be replaced through registration");
		await expect(registrations.verify(account, session, "primary", {})).rejects.toMatchObject({
			status: 409,
		});
	});

	it("updates a proven credential counter before rejecting a session revoked during verification", async () => {
		const { config, store, accounts } = fixture();
		const key = softwareAuthenticator("primary");
		const account = store.createAccount();
		store.storeCredential(
			account.id,
			{
				id: key.id,
				role: "primary",
				publicKey: encodeP256CosePublicKey(key.coordinates),
				counter: 0,
				...key.coordinates,
			},
			account.userHandle,
		);
		const released = new Set<string>();
		const auth = new AccountAuthService(
			config,
			store,
			{ releaseSession: (id) => released.add(id) },
			accounts,
		);
		const session = store.createSession();
		const options = auth.loginOptions(session);
		const assertion = key.assertion(options.challenge);
		assertion.response.userHandle = account.userHandle;
		const verification = auth.verifyLogin(
			{ token: session.token, session },
			{ sessionId: options.sessionId, assertion },
		);
		store.revokeSession(session.token);
		await expect(verification).rejects.toMatchObject({
			status: 401,
			message: "sign-in session expired or revoked",
		});
		expect(store.credential(key.id)?.counter).toBe(1);
		expect(store.session(session.token)).toBeUndefined();
		expect(released.size).toBe(0);
	});

	it("authenticates the registered first key, rotates the session and releases approvals on logout", async () => {
		const { config, store, accounts } = fixture();
		const account = store.createAccount();
		const key = softwareAuthenticator("primary");
		store.storeCredential(
			account.id,
			{
				role: "primary",
				id: key.id,
				publicKey: encodeP256CosePublicKey(key.coordinates),
				counter: 0,
				...key.coordinates,
			},
			account.userHandle,
		);
		const retainedApprovals = new Set<string>();
		const auth = new AccountAuthService(
			config,
			store,
			{
				releaseSession: (id) => {
					retainedApprovals.delete(id);
				},
			},
			accounts,
		);
		const session = store.createSession();
		retainedApprovals.add(session.id);
		const options = auth.loginOptions(session, account.id);
		expect(store.credential(key.id)?.counter).toBe(0);
		const action = await auth.verifyLogin(
			{ token: session.token, session },
			{
				sessionId: options.sessionId,
				accountId: account.id,
				assertion: key.assertion(options.challenge),
			},
		);
		expect(store.credential(key.id)).toMatchObject({ accountId: account.id, counter: 1 });
		expect(action.replacement).toMatchObject({ accountId: account.id, authenticated: true });
		expect(store.session(session.token)).toBeUndefined();
		expect(retainedApprovals.has(session.id)).toBe(false);
		const replacement = action.replacement!;
		retainedApprovals.add(replacement.id);
		expect(auth.logout({ token: replacement.token, session: replacement })).toEqual({
			clearCookie: true,
			body: { authenticated: false },
		});
		expect(store.session(replacement.token)).toBeUndefined();
		expect(retainedApprovals.size).toBe(0);
	});
});
