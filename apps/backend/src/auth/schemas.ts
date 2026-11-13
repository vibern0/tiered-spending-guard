import { array, integer, object, role, string, type Schema } from "../http/schema";

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
	Credential: object({ role, credentialId: string, counter: integer }, [
		"role",
		"credentialId",
		"counter",
	]),
};
