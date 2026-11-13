import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance } from "fastify";
import { accountsSchemas } from "../accounts/schemas";
import { authSchemas } from "../auth/schemas";
import { submissionsSchemas } from "../submissions/schemas";
import { vaultsSchemas } from "../vaults/schemas";
import { sharedSchemas } from "./schemas";

export function registerBackendDocumentation(fastify: FastifyInstance): void {
	for (const [name, schema] of Object.entries({
		...sharedSchemas,
		...authSchemas,
		...accountsSchemas,
		...vaultsSchemas,
		...submissionsSchemas,
	}))
		fastify.addSchema({ $id: name, ...schema });
	fastify.register(swagger, {
		transform: ({ schema, url }) => ({
			url,
			schema: schema.headers
				? {
						...schema,
						// Security hooks own header rejection order; describe their requirements here.
						headers: {
							...schema.headers,
							required: Object.keys(
								(schema.headers as { properties: object }).properties,
							),
						},
					}
				: schema,
		}),
		openapi: {
			openapi: "3.0.3",
			info: {
				title: "Tiered Spending Guard — local account API",
				version: "1.0.0",
				description:
					"Security research; Ethereum Sepolia testnet prototype. Loopback only. Read-only documentation. Exact Origin, Host, CSRF and account/session checks apply. JSON bodies are limited to 256 KiB. Bigints use decimal strings suffixed n. Sessions never authorize Safe spending; exact passkey approvals and onchain policy do.",
			},
			servers: [{ url: "/" }],
			components: {
				securitySchemes: {
					sessionCookie: {
						type: "apiKey",
						in: "cookie",
						name: "vault_local_session",
						description:
							"Opaque HttpOnly SameSite=Strict browser session. Never a transaction approval.",
					},
				},
			},
		},
	});
	fastify.register(swaggerUi, {
		routePrefix: "/documentation",
		staticCSP: true,
		uiConfig: {
			supportedSubmitMethods: [],
			validatorUrl: null,
			persistAuthorization: false,
			deepLinking: true,
		},
	});
}
