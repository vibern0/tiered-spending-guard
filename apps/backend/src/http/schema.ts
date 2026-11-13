import type { OpenAPIV3 } from "openapi-types";
import type { FastifySchema } from "fastify";

export type Schema = OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject;
export const string: Schema = { type: "string" };
export const boolean: Schema = { type: "boolean" };
export const integer: Schema = { type: "integer", minimum: 0 };
export const address: Schema = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" };
export const hash: Schema = { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" };
export const bigint: Schema = {
	type: "string",
	pattern: "^[0-9]+n$",
	description:
		"Unsigned bigint JSON wire representation. Amounts use token base units (Sepolia USDC: 6 decimals).",
};
export const inputUint: Schema = {
	oneOf: [bigint, { type: "string", pattern: "^(0|[1-9][0-9]{0,77})$" }],
	description:
		"Unsigned uint256 input: an n-suffixed decimal string or a canonical decimal string without leading zeros. The runtime rejects values outside uint256; transfer amounts must be positive.",
};
export const role: Schema = { type: "string", enum: ["primary", "secondary"] };
export const id: Schema = { type: "string", pattern: "^[A-Za-z0-9._:-]{1,160}$" };
export const ref = (name: string): Schema => ({ $ref: `${name}#` });
export function object(
	properties: Record<string, Schema>,
	required = Object.keys(properties),
	additionalProperties = false,
): OpenAPIV3.SchemaObject {
	return { type: "object", properties, required, additionalProperties };
}
export const array = (items: Schema): Schema => ({ type: "array", items });
export type Access = "public" | "session" | "account" | "authenticated";

/** Shared boundary documentation; security hooks independently enforce these headers. */
export function routeSchema(
	input: Readonly<{
		summary: string;
		description?: string;
		tag: string;
		access?: Access;
		body?: Schema;
		params?: Schema;
		response: Schema;
		status?: number;
	}>,
): FastifySchema {
	const access = input.access ?? "public";
	const headers: Record<string, Schema> = {};
	if (input.body) {
		headers.origin = { type: "string", description: "Exact configured browser origin." };
		if (access !== "public") headers["x-csrf-token"] = string;
	}
	if (access === "account" || access === "authenticated") headers["x-vault-account"] = string;
	return {
		summary: input.summary,
		description: input.description,
		tags: [input.tag],
		security: access === "public" ? [] : [{ sessionCookie: [] }],
		...(Object.keys(headers).length ? { headers: object(headers, [], true) } : {}),
		...(input.body ? { body: input.body } : {}),
		...(input.params ? { params: input.params } : {}),
		response: {
			[input.status ?? 200]: input.response,
			...Object.fromEntries(
				[400, 401, 403, 404, 409, 413, 415].map((status) => [status, ref("Error")]),
			),
		},
	};
}
