import { array, boolean, id, object, ref, string, type Schema } from "../http/schema";

export const accountsSchemas: Record<string, Schema> = {
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
};
