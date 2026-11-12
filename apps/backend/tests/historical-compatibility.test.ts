import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadBackendConfig } from "../src/config/config";
import { createConfiguredBackend } from "../src/app";
import { createAutomaticPwaProvisioner } from "../src/provisioning/service";
import { createBackendHandlers } from "../src/vaults/service";
import type { PwaHistoricalVault } from "@tiered-spending-guard/security-core/pwa";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const hash = `0x${"12".repeat(32)}` as const;
const historical = Object.freeze({
	mode: "read-only",
	profileVersion: "sepolia-pwa-phase-one-allowlisted-v1",
	chainId: 11155111,
	safe: addr(1),
	guard: addr(2),
	delay: addr(3),
	primaryPasskey: addr(4),
	secondaryPasskey: addr(5),
	usdc: addr(6),
	policy: { recipientMode: "all-lanes-allowlisted", assets: [] },
	evidence: {
		originalPackageHash: hash,
		packageHash: hash,
		planHash: hash,
		policyHash: hash,
		setupTransactionHash: hash,
		topologyReportHash: hash,
		blockNumber: "100",
		blockHash: hash,
	},
}) as PwaHistoricalVault;

function config() {
	const dir = mkdtempSync(join(tmpdir(), "historical-backend-"));
	return {
		...loadBackendConfig({
			BACKEND_PROFILE: "local",
			BACKEND_RELAY_PRIVATE_KEY: `0x${"11".repeat(32)}`,
			BACKEND_RPC_URL: "https://unused.invalid",
			BACKEND_JOURNAL_PATH: join(dir, "submission.json"),
			BACKEND_PROVISIONING_JOURNAL_PATH: join(dir, "provisioning.json"),
			BACKEND_PROVISIONING_REVIEW_DIRECTORY: join(dir, "reviews"),
		}),
		port: 0,
	};
}

describe("historical vault backend compatibility", () => {
	it("never opens provisioning writers or plans for an explicitly historical vault", async () => {
		const createPlan = vi.fn(async () => {
			throw new Error("must not plan");
		});
		const executionContext = vi.fn(async () => {
			throw new Error("must not open writer");
		});
		const provisioner = createAutomaticPwaProvisioner({
			historicalVault: historical,
			reviewDirectory: "/unused",
			createPlan,
			executionContext,
		});
		expect(provisioner.historicalVault).toEqual(historical);
		await expect(provisioner.provision()).rejects.toThrow(/historical.*read-only/i);
		expect(createPlan).not.toHaveBeenCalled();
		expect(executionContext).not.toHaveBeenCalled();
	});

	it("starts the real server, reports read-only health, and serves the historical public record", async () => {
		const c = config();
		const denied = vi.fn(async () => {
			throw new Error("must not reach write callback");
		});
		const provisioner = { historicalVault: historical, provision: denied };
		const server = await createConfiguredBackend(provisioner, c, {
			prepare: denied,
			revalidate: denied,
			deriveOuterHash: denied,
			broadcast: denied,
			reconcile: denied,
		} as never);
		try {
			const port = (server.server.address() as { port: number }).port;
			const base = `http://127.0.0.1:${port}`;
			const health = await fetch(`${base}/health`).then((r) => r.json());
			expect(health).toMatchObject({
				ok: true,
				provisioningReady: false,
				writesReady: false,
				vaultCompatibility: {
					mode: "read-only",
					profileVersion: historical.profileVersion,
				},
			});
			const response = await fetch(`${base}/v1/vaults/current`);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual(historical);
			for (const path of [
				"/v1/registrations/primary/options",
				"/v1/vaults/auto-provision",
				"/v1/credentials/primary/rebind/options",
				"/v1/submissions/prepare",
				"/v1/submissions/request-1/submit",
			]) {
				const result = await fetch(`${base}${path}`, {
					method: "POST",
					headers: { "content-type": "application/json", origin: c.origin },
					body: "{}",
				});
				expect(result.status).toBe(409);
				expect(await result.json()).toMatchObject({ code: "vault_read_only" });
			}
			expect(denied).not.toHaveBeenCalled();
		} finally {
			await server.close();
		}
	});

	it("rejects direct write handlers even when submission callbacks are supplied", async () => {
		const denied = vi.fn(async () => {
			throw new Error("must not reach write callback");
		});
		const handlers = createBackendHandlers({
			config: config(),
			usdc: historical.usdc,
			provisioner: { historicalVault: historical, provision: denied },
			prepareTransfer: denied,
			submit: denied,
			submission: denied,
		});
		expect(handlers.getReadiness?.()).toEqual({ provisioningReady: false, writesReady: false });
		await expect(handlers.autoProvisionVault({})).rejects.toThrow(/historical.*read-only/i);
		await expect(
			handlers.prepareTransfer({
				kind: "transfer",
				recipient: addr(7),
				amount: "1",
				idempotencyKey: "a",
			}),
		).rejects.toThrow(/historical.*read-only/i);
		await expect(handlers.submit("a", {})).rejects.toThrow(/historical.*read-only/i);
		await expect(handlers.submission("a")).rejects.toThrow(/historical.*read-only/i);
		await expect(handlers.verifyApproval(hash, {})).rejects.toThrow(/historical.*read-only/i);
		expect(() => handlers.storeCredential({} as never)).toThrow(/historical.*read-only/i);
		expect(() => handlers.storeReboundCredential({} as never)).toThrow(
			/historical.*read-only/i,
		);
		expect(() => handlers.rebindCoordinates("primary")).toThrow(/historical.*read-only/i);
		expect(handlers.vaultRecord()).toBeUndefined();
		expect(denied).not.toHaveBeenCalled();
	});
});
