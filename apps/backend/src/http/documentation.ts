import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance } from "fastify";
import { createBackendOpenApi, type BackendApiSurface } from "./openapi";

export function registerBackendDocumentation(
	fastify: FastifyInstance,
	surface: BackendApiSurface,
): void {
	fastify.register(swagger, {
		mode: "static",
		specification: { document: createBackendOpenApi(surface) },
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
