import { address, hash, object, ref, string, type Endpoint, type Schema } from "../http/schema";

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
		credentialRebind: ref("RebindStatus"),
	}),
	HistoricalVault: object(
		{
			mode: { type: "string", enum: ["read-only"] },
			profileVersion: { type: "string", enum: ["sepolia-pwa-phase-one-allowlisted-v1"] },
			chainId: { type: "integer", enum: [11155111] },
			safe: address,
			guard: address,
			delay: address,
			primaryPasskey: address,
			secondaryPasskey: address,
			policy: {
				type: "object",
				description:
					"Historical all-lanes-allowlisted asset policies; bigint fields use the n suffix.",
				additionalProperties: true,
			},
			evidence: object({
				originalPackageHash: hash,
				packageHash: hash,
				planHash: hash,
				policyHash: hash,
				setupTransactionHash: hash,
				topologyReportHash: hash,
				blockNumber: string,
				blockHash: hash,
			}),
		},
		["mode", "profileVersion", "chainId", "safe", "guard", "delay", "policy", "evidence"],
		true,
	),
};

export function documentVaults(add: (endpoint: Endpoint) => void, _account: boolean): void {
	add({
		method: "get",
		path: "/v1/vaults/current",
		tag: "Vaults",
		summary: "Read the verified current vault",
		description:
			"Returns the current verified vault or historical read-only vault; 404 if not provisioned.",
		access: "authenticated",
		response: { oneOf: [ref("Vault"), ref("HistoricalVault")] },
	});
	add({
		method: "post",
		path: "/v1/vaults/auto-provision",
		tag: "Vaults",
		summary: "Provision or resume the account vault",
		description:
			"Local Sepolia only. Requires both server-held credentials and first-key authentication on the account API. Writes an unsigned review package, applies committed authorization/cost bounds, serially deploys/resumes seven exact transactions, waits six confirmations and verifies topology. Empty body; no browser policy/provider/nonce/artifact overrides. Pending work may return 400 with provisioning_pending_confirmation; retry reconciles recorded hashes.",
		access: "authenticated",
		response: ref("Vault"),
		body: ref("Empty"),
	});
}
