import type { OpenAPIV3 } from "openapi-types";

export type Schema = OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject;
export type BackendApiSurface = "account" | "legacy";
export const string: Schema = { type: "string" };
export const boolean: Schema = { type: "boolean" };
export const integer: Schema = { type: "integer", minimum: 0 };
export const address: Schema = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" };
export const hash: Schema = { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" };
export const bigint: Schema = {
	type: "string",
	pattern: "^[0-9]+n$",
	example: "1000000n",
	description:
		"Unsigned bigint JSON wire representation. Amounts use token base units (Sepolia USDC: 6 decimals).",
};
export const inputUint: Schema = {
	oneOf: [bigint, { type: "string", pattern: "^(0|[1-9][0-9]{0,77})$", example: "1000000" }],
	description:
		"Unsigned uint256 input: an n-suffixed decimal string or a canonical decimal string without leading zeros. The runtime rejects values outside uint256; transfer amounts must be positive.",
};
export const role: Schema = { type: "string", enum: ["primary", "secondary"] };
export const id: Schema = { type: "string", pattern: "^[A-Za-z0-9._:-]{1,160}$" };
export const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
export function object(
	properties: Record<string, Schema>,
	required = Object.keys(properties),
	additionalProperties = false,
): OpenAPIV3.SchemaObject {
	return { type: "object", properties, required, additionalProperties };
}
export const array = (items: Schema): Schema => ({ type: "array", items });
export const json = (schema: Schema) => ({ "application/json": { schema } });

export type Access = "public" | "session" | "account" | "authenticated";
export type Endpoint = Readonly<{
	method: "get" | "post";
	path: string;
	summary: string;
	description: string;
	tag: string;
	response: Schema;
	body?: Schema;
	access?: Access;
}>;
