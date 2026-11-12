import {
	array,
	boolean,
	integer,
	object,
	ref,
	role,
	string,
	type Endpoint,
	type Schema,
} from "../http/schema";

const assertion = object(
	{
		id: string,
		rawId: string,
		type: { type: "string", enum: ["public-key"] },
		response: object(
			{
				clientDataJSON: string,
				authenticatorData: string,
				signature: string,
				userHandle: { type: "string", nullable: true },
			},
			["clientDataJSON", "authenticatorData", "signature"],
		),
		clientExtensionResults: { type: "object", additionalProperties: true },
		authenticatorAttachment: string,
	},
	["id", "rawId", "type", "response", "clientExtensionResults"],
);
const registration = object(
	{
		id: string,
		rawId: string,
		type: { type: "string", enum: ["public-key"] },
		response: object(
			{
				clientDataJSON: string,
				attestationObject: string,
				transports: array(string),
				publicKey: string,
				publicKeyAlgorithm: { type: "integer" },
				authenticatorData: string,
			},
			["clientDataJSON", "attestationObject"],
		),
		clientExtensionResults: { type: "object", additionalProperties: true },
		authenticatorAttachment: string,
	},
	["id", "rawId", "type", "response", "clientExtensionResults"],
);
export const authSchemas: Record<string, Schema> = {
	Assertion: {
		...assertion,
		description:
			"WebAuthn AuthenticationResponseJSON; binary fields are base64url. Fresh user verification is required. Login challenges cannot approve Safe transactions.",
	},
	Registration: {
		...registration,
		description:
			"WebAuthn RegistrationResponseJSON with ES256 attestation and required user verification. Only public credential metadata persists.",
	},
	Challenge: object(
		{
			sessionId: string,
			challenge: string,
			rpId: string,
			origin: string,
			userVerification: { type: "string", enum: ["required"] },
			csrfToken: string,
			accountId: string,
			credentialIds: array(string),
			role,
			userHandle: string,
			authenticatorAttachment: { type: "string", enum: ["platform", "cross-platform"] },
		},
		["sessionId", "challenge", "rpId", "origin", "userVerification"],
	),
	Credential: object(
		{ role, credentialId: string, counter: integer, credentialRebind: ref("RebindStatus") },
		["role", "credentialId", "counter"],
	),
	RebindStatus: object({
		required: boolean,
		primary: { type: "string", enum: ["required", "ready"] },
		secondary: { type: "string", enum: ["required", "ready"] },
	}),
};

export function documentAuth(add: (endpoint: Endpoint) => void, account: boolean): void {
	if (account) {
		add({
			method: "get",
			path: "/v1/auth/session",
			tag: "Authentication",
			summary: "Read the current session",
			description:
				"Unauthenticated callers receive authenticated=false. A valid cookie returns its own public account, CSRF token and, when authenticated/verified, vault and submission IDs.",
			response: ref("Session"),
		});
		add({
			method: "post",
			path: "/v1/auth/setup",
			tag: "Authentication",
			summary: "Create or resume account setup",
			description:
				"Creates a new setup account and HttpOnly SameSite=Strict cookie. An unfinished setup resumes; an authenticated user must first log out. Exact Origin required; no existing CSRF token required.",
			response: ref("Session"),
			body: ref("Empty"),
		});
		add({
			method: "post",
			path: "/v1/auth/login/options",
			tag: "Authentication",
			summary: "Request a first-passkey login challenge",
			description:
				"Creates an unauthenticated session when necessary. Optional accountId targets a first credential; otherwise discoverable first-passkey login is used. Login challenges do not authorize transactions.",
			response: ref("Challenge"),
			body: object({ accountId: string }, []),
		});
		add({
			method: "post",
			path: "/v1/auth/login/verify",
			tag: "Authentication",
			summary: "Verify the first passkey and rotate the session",
			description:
				"Consumes a fresh login challenge and verifies the registered primary key. Optional accountId must match challenge and credential. Legacy key discovery requires exact independently verified coordinates. The secondary cannot log in.",
			access: "session",
			response: ref("Session"),
			body: object({ sessionId: string, assertion: ref("Assertion"), accountId: string }, [
				"sessionId",
				"assertion",
			]),
		});
		add({
			method: "post",
			path: "/v1/auth/logout",
			tag: "Authentication",
			summary: "Revoke the current session",
			description:
				"Clears its cookie and retained approval attempt; persistent account and journals remain. Does not cancel an onchain transaction.",
			access: "session",
			response: object({ authenticated: { type: "boolean", enum: [false] } }),
			body: ref("Empty"),
		});
	}
}

export function documentCredentials(add: (endpoint: Endpoint) => void, account: boolean): void {
	add({
		method: "post",
		path: "/v1/registrations/{role}/options",
		tag: "Credentials",
		summary: "Request registration options for a signer",
		description: account
			? "Setup account only. Primary registration is followed by first-key login before secondary registration. Secondary requires an authenticated session; existing role credentials cannot be replaced. Challenge includes the role-specific userHandle."
			: "Historical singleton test harness. Primary requires platform attachment; secondary cross-platform. Registered roles cannot be replaced.",
		access: "account",
		response: ref("Challenge"),
		body: ref("Empty"),
	});
	add({
		method: "post",
		path: "/v1/registrations/{role}/verify",
		tag: "Credentials",
		summary: "Verify and store public signer metadata",
		description:
			"Consumes the role-bound registration challenge and verifies origin/RP/user verification. Persists public credential metadata only. The account surface requires first-key authentication for the secondary role.",
		access: "account",
		response: ref("Credential"),
		body: object({ sessionId: string, registration: ref("Registration") }),
	});
	if (!account) {
		add({
			method: "post",
			path: "/v1/credentials/{role}/rebind/options",
			tag: "Credentials",
			summary: "Request historical credential rebind options",
			description:
				"Local singleton test harness only; not available in the normal account API. Uses the independently recovered role coordinates and never changes a signer.",
			response: ref("Challenge"),
			body: ref("Empty"),
		});
		add({
			method: "post",
			path: "/v1/credentials/{role}/rebind/verify",
			tag: "Credentials",
			summary: "Verify a historical role rebind",
			description:
				"Consumes the single-use role challenge and proves the same recovered key. Never grants signer replacement or a new spending path.",
			response: ref("Credential"),
			body: object({ sessionId: string, assertion: ref("Assertion") }),
		});
	}
}
