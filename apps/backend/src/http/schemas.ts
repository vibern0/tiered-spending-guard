import { boolean, object, ref, string, type Endpoint, type Schema } from "./schema";

export const sharedSchemas: Record<string, Schema> = {
	Empty: object({}),
	Error: object({ error: string, code: string, stage: string, requestId: string }, ["error"]),
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
};

export function documentHealth(add: (endpoint: Endpoint) => void, account: boolean): void {
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
}
