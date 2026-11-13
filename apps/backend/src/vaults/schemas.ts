import { address, hash, object, string, type Schema } from "../http/schema";

export const vaultsSchemas: Record<string, Schema> = {
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
	}),
	ProvisioningState: object(
		{
			state: {
				type: "string",
				enum: ["registering", "queued", "provisioning", "verified", "blocked"],
			},
			error: string,
		},
		["state"],
	),
};
