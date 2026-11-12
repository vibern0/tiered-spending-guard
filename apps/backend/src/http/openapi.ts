import type { OpenAPIV3 } from "openapi-types";
import { accountsSchemas } from "../accounts/schemas";
import { authSchemas, documentAuth, documentCredentials } from "../auth/schemas";
import { documentSubmissions, submissionsSchemas } from "../submissions/schemas";
import { documentVaults, vaultsSchemas } from "../vaults/schemas";
import { id, json, ref, role, string, type BackendApiSurface, type Endpoint } from "./schema";
import { documentHealth, sharedSchemas } from "./schemas";
export type { BackendApiSurface } from "./schema";
const schemas = {
	...sharedSchemas,
	...authSchemas,
	...accountsSchemas,
	...vaultsSchemas,
	...submissionsSchemas,
};

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

	documentAuth(add, account);
	documentHealth(add, account);
	documentCredentials(add, account);
	documentVaults(add, account);
	documentSubmissions(add, account);
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
