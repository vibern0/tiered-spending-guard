import { boolean, object, routeSchema, ref, string, type Schema } from "./schema";

export const sharedSchemas: Record<string, Schema> = {
	Empty: object({}),
	Error: object({ error: string, code: string, stage: string, requestId: string }, ["error"]),
	Health: object({
		ok: boolean,
		chainId: { type: "integer", enum: [11155111] },
		profileId: { type: "string", enum: ["local"] },
		origin: string,
		rpId: string,
		provisioningReady: boolean,
		writesReady: boolean,
	}),
};

export const healthSchema = routeSchema({
	tag: "Health",
	summary: "Read backend readiness",
	description: "Public readiness. writesReady reflects only the authenticated caller's account.",
	response: ref("Health"),
});
