import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadBackendConfig } from "../src/config";
import { createConfiguredBackend } from "../src/main";
import type { BackendPwaProvisioningCompletion } from "../src/provisioner";
import type {
	PwaHistoricalVault,
	PwaProvisioningPlan,
} from "@tiered-spending-guard/security-core/pwa";

const mocks = vi.hoisted(() => ({
	factory: vi.fn(),
	prepare: vi.fn(),
	revalidate: vi.fn(),
	deriveOuterHash: vi.fn(),
	broadcast: vi.fn(),
	reconcile: vi.fn(),
}));
vi.mock("../src/submission-runtime", () => ({ createConfiguredSubmissionRuntime: mocks.factory }));
vi.mock("../src/webauthn", async (original) => ({
	...(await original<typeof import("../src/webauthn")>()),
	verifyPasskeyRegistration: vi.fn(async ({ role }: { role: "primary" | "secondary" }) => ({
		role,
		id: role,
		credentialId: role,
		publicKey: Uint8Array.of(role === "primary" ? 1 : 2),
		counter: 0,
		x: role === "primary" ? 1n : 3n,
		y: role === "primary" ? 2n : 4n,
	})),
}));

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const hash = `0x${"ab".repeat(32)}` as Hex;
const plan = { planHash: hash } as PwaProvisioningPlan;
const completion = {
	response: {
		chainId: 11155111,
		safe: address(1),
		guard: address(2),
		delay: address(3),
		primaryPasskey: address(4),
		secondaryPasskey: address(5),
		usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
		evidence: {
			setupTransactionHash: hash,
			verificationReportHash: hash,
			deploymentsHash: hash,
			policyHash: hash,
			blockNumber: "1",
		},
	},
	verified: {},
	plan,
} as unknown as BackendPwaProvisioningCompletion;

function config() {
	const directory = mkdtempSync(join(tmpdir(), "pwa-default-runtime-"));
	return {
		...loadBackendConfig({
			BACKEND_PROFILE: "local",
			BACKEND_RELAY_PRIVATE_KEY: `0x${"11".repeat(32)}`,
			BACKEND_RPC_URL: "https://unused.invalid",
			BACKEND_JOURNAL_PATH: join(directory, "submissions.json"),
			BACKEND_PROVISIONING_JOURNAL_PATH: join(directory, "provisioning.json"),
			BACKEND_PROVISIONING_REVIEW_DIRECTORY: join(directory, "reviews"),
		}),
		port: 0,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.factory.mockReturnValue({
		prepare: mocks.prepare,
		revalidate: mocks.revalidate,
		deriveOuterHash: mocks.deriveOuterHash,
		broadcast: mocks.broadcast,
		reconcile: mocks.reconcile,
	});
	mocks.prepare.mockImplementation(async ({ request }) => ({
		id: request.idempotencyKey,
		requestHash: hash,
		safeTxHash: hash,
		kind: "base-transfer",
		requiredApprovals: ["primary"],
		publicRequest: request,
	}));
});

describe("configured submission runtime composition", () => {
	it("restores an already completed verified vault before serving HTTP without requiring another provisioning request", async () => {
		const configured = config(),
			provision = vi.fn().mockResolvedValue(completion);
		const backend = await createConfiguredBackend(
			{
				completedRecoveryReady: true,
				recoveryCredentials: { primary: { x: 1n, y: 2n }, secondary: { x: 3n, y: 4n } },
				provision,
			},
			configured,
		);
		try {
			const port = (backend.server.address() as { port: number }).port;
			const response = await fetch(`http://127.0.0.1:${port}/v1/vaults/current`);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				safe: completion.response.safe,
				credentialRebind: { required: true, primary: "required", secondary: "required" },
			});
			expect(provision).toHaveBeenCalledTimes(1);
			expect(
				await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()),
			).toMatchObject({
				provisioningReady: true,
				writesReady: false,
			});
			expect(mocks.prepare).not.toHaveBeenCalled();
		} finally {
			await backend.close();
		}
	});
	it("uses the concrete default after fresh setup, with no sending-readiness deadlock or public plan leakage", async () => {
		const configured = config();
		const backend = await createConfiguredBackend(
			{ provision: vi.fn().mockResolvedValue(completion) },
			configured,
		);
		try {
			expect(mocks.factory).toHaveBeenCalledExactlyOnceWith(configured, expect.any(Function));
			const port = (backend.server.address() as { port: number }).port;
			const origin = `http://127.0.0.1:${port}`;
			const post = (path: string, body: unknown) =>
				fetch(`${origin}${path}`, {
					method: "POST",
					headers: { origin: configured.origin, "content-type": "application/json" },
					body: JSON.stringify(body),
				});
			expect(await fetch(`${origin}/health`).then((r) => r.json())).toMatchObject({
				provisioningReady: true,
				writesReady: false,
			});
			for (const role of ["primary", "secondary"]) {
				const options = (await post(`/v1/registrations/${role}/options`, {}).then((r) =>
					r.json(),
				)) as { sessionId: string };
				expect(
					(
						await post(`/v1/registrations/${role}/verify`, {
							sessionId: options.sessionId,
							registration: { id: role },
						})
					).status,
				).toBe(200);
			}
			const provisioned = await post("/v1/vaults/auto-provision", {});
			expect(provisioned.status).toBe(200);
			expect(await provisioned.json()).not.toHaveProperty("plan");
			expect(await fetch(`${origin}/health`).then((r) => r.json())).toMatchObject({
				provisioningReady: true,
				writesReady: true,
			});
			const prepared = await post("/v1/submissions/prepare", {
				kind: "transfer",
				recipient: address(6),
				amount: "1",
				idempotencyKey: "default-1",
			});
			expect(prepared.status).toBe(200);
			expect(await prepared.json()).toMatchObject({ id: "default-1" });
			expect(mocks.prepare).toHaveBeenCalledWith(
				expect.objectContaining({
					vault: expect.objectContaining({ provisioningPlan: plan }),
					request: expect.objectContaining({ amount: "1" }),
				}),
			);
			expect(mocks.factory.mock.calls[0]![1]()).toMatchObject({ provisioningPlan: plan });
		} finally {
			await backend.close();
		}
	});

	it("keeps the injected runtime seam without constructing the default", async () => {
		const injected = {
			prepare: vi.fn(),
			revalidate: vi.fn(),
			deriveOuterHash: vi.fn(),
			broadcast: vi.fn(),
			reconcile: vi.fn(),
		};
		const backend = await createConfiguredBackend(
			{ provision: vi.fn().mockResolvedValue(completion) },
			config(),
			injected,
		);
		try {
			expect(mocks.factory).not.toHaveBeenCalled();
		} finally {
			await backend.close();
		}
	});

	it("constructs neither default nor injected submission services for historical vaults", async () => {
		const historical = {
			...completion.response,
			mode: "read-only",
			profileVersion: "sepolia-pwa-phase-one-allowlisted-v1",
			policy: { recipientMode: "all-lanes-allowlisted", assets: [] },
			evidence: {
				originalPackageHash: hash,
				packageHash: hash,
				planHash: hash,
				policyHash: hash,
				setupTransactionHash: hash,
				topologyReportHash: hash,
				blockNumber: "12",
				blockHash: hash,
			},
		} as PwaHistoricalVault;
		const injected = {
			prepare: vi.fn(),
			revalidate: vi.fn(),
			deriveOuterHash: vi.fn(),
			broadcast: vi.fn(),
			reconcile: vi.fn(),
		};
		const backend = await createConfiguredBackend(
			{ historicalVault: historical, provision: vi.fn() },
			config(),
			injected,
		);
		try {
			const port = (backend.server.address() as { port: number }).port;
			expect(
				await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()),
			).toMatchObject({
				provisioningReady: false,
				writesReady: false,
			});
			expect(
				(
					await fetch(`http://127.0.0.1:${port}/v1/submissions/prepare`, {
						method: "POST",
						body: "{}",
					})
				).status,
			).toBe(409);
			expect(mocks.factory).not.toHaveBeenCalled();
			for (const callback of Object.values(injected)) expect(callback).not.toHaveBeenCalled();
		} finally {
			await backend.close();
		}
	});
});
