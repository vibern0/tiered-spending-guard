import type { OpenAPIV3 } from "openapi-types";

type Schema = OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject;
export type BackendApiSurface = "account" | "legacy";
const string: Schema = { type: "string" };
const boolean: Schema = { type: "boolean" };
const integer: Schema = { type: "integer", minimum: 0 };
const address: Schema = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" };
const hash: Schema = { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" };
const bigint: Schema = {
	type: "string",
	pattern: "^[0-9]+n$",
	example: "1000000n",
	description:
		"Unsigned bigint JSON wire representation. Amounts use token base units (Sepolia USDC: 6 decimals).",
};
const inputUint: Schema = {
	oneOf: [bigint, { type: "string", pattern: "^(0|[1-9][0-9]{0,77})$", example: "1000000" }],
	description:
		"Unsigned uint256 input: an n-suffixed decimal string or a canonical decimal string without leading zeros. The runtime rejects values outside uint256; transfer amounts must be positive.",
};
const role: Schema = { type: "string", enum: ["primary", "secondary"] };
const id: Schema = { type: "string", pattern: "^[A-Za-z0-9._:-]{1,160}$" };
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
function object(
	properties: Record<string, Schema>,
	required = Object.keys(properties),
	additionalProperties = false,
): OpenAPIV3.SchemaObject {
	return { type: "object", properties, required, additionalProperties };
}
const array = (items: Schema): Schema => ({ type: "array", items });
const json = (schema: Schema) => ({ "application/json": { schema } });

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
const queueIntent = (kind: string): Schema =>
	object({
		kind: { type: "string", enum: [kind] },
		queueNonce: inputUint,
		queueFingerprint: hash,
		idempotencyKey: id,
	});

const schemas: Record<string, Schema> = {
	Empty: object({}),
	Error: object({ error: string, code: string, stage: string, requestId: string }, ["error"]),
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
	Health: object(
		{
			ok: boolean,
			chainId: { type: "integer", enum: [11155111] },
			profileId: { type: "string", enum: ["local", "https"] },
			origin: string,
			rpId: string,
			provisioningReady: boolean,
			writesReady: boolean,
			vaultCompatibility: object({ mode: string, profileVersion: string, reason: string }),
		},
		["ok", "chainId", "profileId", "origin", "rpId", "provisioningReady", "writesReady"],
	),
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
	Vault: object({
		chainId: { type: "integer", enum: [11155111] },
		safe: address,
		guard: address,
		delay: address,
		primaryPasskey: address,
		secondaryPasskey: address,
		usdc: address,
		evidence: object({
			setupTransactionHash: hash,
			verificationReportHash: hash,
			deploymentsHash: hash,
			policyHash: hash,
			blockNumber: string,
		}),
		credentialRebind: ref("RebindStatus"),
	}),
	HistoricalVault: object(
		{
			mode: { type: "string", enum: ["read-only"] },
			profileVersion: { type: "string", enum: ["sepolia-pwa-phase-one-allowlisted-v1"] },
			chainId: { type: "integer", enum: [11155111] },
			safe: address,
			guard: address,
			delay: address,
			primaryPasskey: address,
			secondaryPasskey: address,
			policy: {
				type: "object",
				description:
					"Historical all-lanes-allowlisted asset policies; bigint fields use the n suffix.",
				additionalProperties: true,
			},
			evidence: object({
				originalPackageHash: hash,
				packageHash: hash,
				planHash: hash,
				policyHash: hash,
				setupTransactionHash: hash,
				topologyReportHash: hash,
				blockNumber: string,
				blockHash: hash,
			}),
		},
		["mode", "profileVersion", "chainId", "safe", "guard", "delay", "policy", "evidence"],
		true,
	),
	Session: object(
		{
			authenticated: boolean,
			csrfToken: string,
			account: object(
				{
					id: string,
					userHandle: string,
					state: {
						type: "string",
						enum: ["registering", "queued", "provisioning", "verified"],
					},
					primaryCredentialId: string,
					secondaryCredentialId: string,
					submissionIds: array(id),
					vault: { oneOf: [ref("Vault"), ref("HistoricalVault")] },
				},
				["id", "userHandle", "state"],
			),
		},
		["authenticated"],
	),
	Prepare: {
		oneOf: [
			object({
				kind: { type: "string", enum: ["transfer"] },
				recipient: address,
				amount: inputUint,
				idempotencyKey: id,
			}),
			object({
				kind: { type: "string", enum: ["add-recipient"] },
				recipient: address,
				idempotencyKey: id,
			}),
			queueIntent("cancel-queued"),
			queueIntent("execute-ready"),
			queueIntent("skip-expired"),
		],
		description:
			"Closed intents only. Backend derives policy, nonce, providers, fees and calldata. Transfers classify into base, step-up or delayed. Queue actions bind the exact queue nonce and fingerprint.",
	},
	Prepared: object(
		{
			id,
			requestHash: hash,
			safeTxHash: hash,
			kind: {
				type: "string",
				enum: [
					"base-transfer",
					"step-up-transfer",
					"queue-transfer",
					"add-recipient",
					"cancel-queued",
					"execute-ready",
					"skip-expired",
				],
			},
			requiredApprovals: array(role),
			publicRequest: {
				type: "object",
				additionalProperties: true,
				description:
					"Public immutable prepared intent including idempotency key, verified snapshot/policy bindings, transaction and queue details. Bigints use decimal strings suffixed n. Never contains private signing material.",
			},
		},
		["id", "requestHash", "kind", "requiredApprovals", "publicRequest"],
	),
	Submit: {
		oneOf: [
			object({ role, assertion: ref("Assertion") }),
			object({ role: { type: "string", enum: ["none"] } }),
		],
		description:
			"Primary assertion first; secondary only when required. Assertions approve the exact prepared Safe digest. role=none only executes an already-ready queue head or skips an expired head; it grants no new approval.",
	},
	Submission: object(
		{
			id,
			state: {
				type: "string",
				enum: [
					"prepared",
					"awaiting-primary",
					"awaiting-secondary",
					"submitting",
					"uncertain",
					"confirmed",
					"reverted",
					"superseded",
				],
			},
			kind: string,
			requestHash: hash,
			requiredApprovals: array(role),
			approvals: object({ primary: boolean, secondary: boolean }),
			transactionHash: hash,
			receipt: object({ transactionHash: hash, blockNumber: bigint, blockHash: hash }),
		},
		["id", "state", "kind", "requestHash", "requiredApprovals", "approvals"],
	),
};

type Access = "public" | "session" | "account" | "authenticated";
type Endpoint = Readonly<{
	method: "get" | "post";
	path: string;
	summary: string;
	description: string;
	tag: string;
	response: Schema;
	body?: Schema;
	access?: Access;
}>;

/** Describes the existing contract only; these schemas are never attached to runtime routes. */
export function createBackendOpenApi(surface: BackendApiSurface): OpenAPIV3.Document {
	const account = surface === "account";
	const paths: OpenAPIV3.PathsObject = {};
	function add(endpoint: Endpoint): void {
		const access = endpoint.access ?? "public";
		const parameters: OpenAPIV3.ParameterObject[] = [];
		for (const match of endpoint.path.matchAll(/\{([^}]+)\}/g))
			parameters.push({
				name: match[1],
				in: "path",
				required: true,
				schema: match[1] === "role" ? role : id,
			});
		if (endpoint.method === "post" && account)
			parameters.push({
				name: "Origin",
				in: "header",
				required: true,
				schema: { type: "string", enum: ["http://localhost:5173"] },
				description: "Exact configured browser origin; required independently of cookies.",
			});
		if (account && access !== "public" && endpoint.method === "post")
			parameters.push({
				name: "x-csrf-token",
				in: "header",
				required: true,
				schema: string,
				description: "Current server-issued session CSRF token; rotates with login.",
			});
		if (account && ["account", "authenticated"].includes(access))
			parameters.push({
				name: "x-vault-account",
				in: "header",
				required: true,
				schema: string,
				description: "Must exactly match the cookie session's selected account.",
			});
		const descriptions: Record<string, string> = account
			? {
					"400": "Malformed input, failed verification, unavailable runtime or safely rejected action.",
					"401": "Session missing, expired or insufficiently authenticated.",
					"403": "Loopback, Host, Origin, CSRF or selected-account check failed.",
					"404": "Unknown resource, role, submission or unprovisioned vault.",
					"409": "Account/signer lifecycle conflict.",
					"413": "JSON body exceeds 256 KiB.",
					"415": "POST requires application/json.",
				}
			: {
					"400": "Malformed input, failed verification, body too large or safely rejected action.",
					"403": "Non-loopback client or disallowed Origin.",
					"404": "Unknown resource; local-only operations unavailable in HTTPS profile.",
					"409": "Historical read-only vault rejects all POST requests.",
					"503": "Submission preparation runtime is not ready.",
				};
		const responses: OpenAPIV3.ResponsesObject = {
			"200": { description: "Success", content: json(endpoint.response) },
		};
		for (const [status, description] of Object.entries(descriptions))
			responses[status] = { description, content: json(ref("Error")) };
		const operation: OpenAPIV3.OperationObject = {
			operationId: `${surface}_${endpoint.method}_${endpoint.path.replace(/[^A-Za-z0-9]+/g, "_")}`,
			summary: endpoint.summary,
			description: endpoint.description,
			tags: [endpoint.tag],
			security: account && access !== "public" ? [{ sessionCookie: [] }] : [],
			parameters,
			responses,
			...(endpoint.body
				? { requestBody: { required: true, content: json(endpoint.body) } }
				: {}),
		};
		paths[endpoint.path] = { ...paths[endpoint.path], [endpoint.method]: operation };
	}
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
	add({
		method: "get",
		path: "/health",
		tag: "Health",
		summary: "Read backend readiness",
		description: account
			? "Public readiness; writesReady reflects only the authenticated caller's account. No other account readiness is disclosed."
			: "Read-only singleton/HTTPS compatibility readiness. Historical vaults never become writable.",
		response: ref("Health"),
	});
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
	add({
		method: "get",
		path: "/v1/vaults/current",
		tag: "Vaults",
		summary: "Read the verified current vault",
		description:
			"Returns the current verified vault or historical read-only vault; 404 if not provisioned.",
		access: "authenticated",
		response: { oneOf: [ref("Vault"), ref("HistoricalVault")] },
	});
	add({
		method: "post",
		path: "/v1/vaults/auto-provision",
		tag: "Vaults",
		summary: "Provision or resume the account vault",
		description:
			"Local Sepolia only. Requires both server-held credentials and first-key authentication on the account API. Writes an unsigned review package, applies committed authorization/cost bounds, serially deploys/resumes seven exact transactions, waits six confirmations and verifies topology. Empty body; no browser policy/provider/nonce/artifact overrides. Pending work may return 400 with provisioning_pending_confirmation; retry reconciles recorded hashes.",
		access: "authenticated",
		response: ref("Vault"),
		body: ref("Empty"),
	});
	add({
		method: "post",
		path: "/v1/submissions/prepare",
		tag: "Submissions",
		summary: "Prepare a closed vault intent",
		description:
			"Verifies current state, classifies and simulates the intent. Returns exact digest and required approval roles without broadcasting. Amount and queueNonce use n-suffixed decimal strings. Account and session own the prepared attempt.",
		access: "authenticated",
		response: ref("Prepared"),
		body: schemas.Prepare,
	});
	add({
		method: "post",
		path: "/v1/submissions/{id}/submit",
		tag: "Submissions",
		summary: "Approve or execute the exact prepared submission",
		description:
			"Verifies each required passkey assertion over the exact Safe digest, primary first, then secondary when required. Revalidates state before bounded outer signing and one broadcast. Durable hashes reconcile after uncertainty without resubmission. Ready/expired queue actions require role=none and cannot authorize a new withdrawal.",
		access: "authenticated",
		response: ref("Submission"),
		body: ref("Submit"),
	});
	add({
		method: "get",
		path: "/v1/submissions/{id}",
		tag: "Submissions",
		summary: "Read and reconcile submission status",
		description:
			"Looks up only the account-owned recorded submission and its exact durable transaction hash. Reconciliation observes receipts without signing or broadcasting.",
		access: "authenticated",
		response: ref("Submission"),
	});
	return {
		openapi: "3.0.3",
		info: {
			title: `Tiered Spending Guard — ${account ? "local account" : "legacy singleton / HTTPS compatibility"} API`,
			version: "1.0.0",
			description:
				"Security research; Ethereum Sepolia testnet prototype. Backend binds to loopback. Documentation is read-only; Try it out and external validation are disabled. GET/POST application endpoints are listed below; OPTIONS preflight is handled by the existing boundary with 204. Account POST requires exact Origin and application/json, 256 KiB maximum. Bigints use decimal strings suffixed n. Cookies authenticate browser sessions only; fresh exact passkey approvals and onchain policy authorize spending. /documentation/ serves this UI; /documentation/json and /documentation/yaml serve this specification; /documentation/static/* serves bundled assets. These read-only routes inherit the server boundary and no-store policy.",
		},
		servers: [{ url: "/", description: "This loopback backend" }],
		tags: ["Health", "Authentication", "Credentials", "Vaults", "Submissions"].map((name) => ({
			name,
		})),
		paths,
		components: {
			schemas,
			...(account
				? {
						securitySchemes: {
							sessionCookie: {
								type: "apiKey",
								in: "cookie",
								name: "vault_local_session",
								description:
									"Opaque HttpOnly SameSite=Strict session. Never a Safe transaction approval.",
							} as OpenAPIV3.SecuritySchemeObject,
						},
					}
				: {}),
		},
	};
}
