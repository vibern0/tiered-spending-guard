import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadBackendConfig } from "../src/config/config";
import { AccountStore } from "../src/accounts/store";
import { createBackendHandlers } from "../src/vaults/service";
import { SEPOLIA_USDC_ADDRESS } from "../src/submissions/service";
import type { BackendPwaProvisioningCompletion } from "../src/provisioning/service";
const H = `0x${"12".repeat(32)}` as const;
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const cleanup: (() => void)[] = [];
afterEach(() =>
	cleanup
		.splice(0)
		.reverse()
		.forEach((fn) => fn()),
);
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "current-handlers-"));
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	const config = loadBackendConfig({
		BACKEND_DATA_DIRECTORY: root,
		BACKEND_RELAY_PRIVATE_KEY: `0x${"11".repeat(32)}`,
		BACKEND_RPC_URL: "https://unused.invalid",
	});
	const store = new AccountStore(config);
	cleanup.push(() => store.close());
	const account = store.createAccount();
	const add = (role: "primary" | "secondary", n: number) =>
		store.storeCredential(account.id, {
			role,
			id: role,
			publicKey: Uint8Array.of(n),
			x: BigInt(n),
			y: BigInt(n + 1),
			counter: 0,
		});
	const provision = vi.fn(
		async () =>
			({
				response: {
					chainId: 11155111,
					safe: address(1),
					guard: address(2),
					delay: address(3),
					primaryPasskey: address(4),
					secondaryPasskey: address(5),
					usdc: SEPOLIA_USDC_ADDRESS,
					evidence: {
						setupTransactionHash: H,
						verificationReportHash: H,
						deploymentsHash: H,
						policyHash: H,
						blockNumber: "1",
					},
				},
				verified: {},
				plan: {},
			}) as BackendPwaProvisioningCompletion,
	);
	const prepare = vi.fn(async ({ request }: any) => ({
		id: request.idempotencyKey,
		requestHash: H,
		safeTxHash: H,
		kind: "base-transfer" as const,
		requiredApprovals: ["primary" as const],
		publicRequest: { kind: request.kind, idempotencyKey: request.idempotencyKey },
	}));
	const handlers = createBackendHandlers({
		config,
		usdc: SEPOLIA_USDC_ADDRESS,
		provisioner: { provision },
		credentialStore: {
			get: (role) => store.credentials(account.id).find((c) => c.role === role),
			updateCounter: () => {
				throw new Error("unverified assertion must not update counters");
			},
		},
		prepareTransfer: prepare,
		submit: async () => ({ state: "uncertain" }),
		submission: async () => ({ state: "confirmed" }),
	});
	return { handlers, add, provision, prepare };
}
it("requires persistent distinct credentials and never accepts browser deployment fields", async () => {
	const { handlers, add, provision } = fixture();
	await expect(handlers.autoProvisionVault({})).rejects.toThrow(/two verified/);
	add("primary", 1);
	add("secondary", 3);
	await expect(handlers.autoProvisionVault({ safe: address(9) })).rejects.toThrow(/unsupported/);
	const [a, b] = await Promise.all([
		handlers.autoProvisionVault({}),
		handlers.autoProvisionVault({}),
	]);
	expect(a.safe).toBe(address(1));
	expect(b).toEqual(a);
	expect(provision).toHaveBeenCalledOnce();
	expect(handlers.vaultRecord()?.provisioningPlan).toEqual({});
	expect(a).not.toHaveProperty("provisioningPlan");
});
it("rejects open calldata and mismatched prepared identity before submission", async () => {
	const { handlers, add, prepare } = fixture();
	add("primary", 1);
	add("secondary", 3);
	await handlers.autoProvisionVault({});
	await expect(
		handlers.prepareTransfer({
			kind: "transfer",
			recipient: address(6),
			amount: 1n,
			idempotencyKey: "one",
			calldata: "0x",
		}),
	).rejects.toThrow(/unsupported/);
	expect(prepare).not.toHaveBeenCalled();
	await expect(
		handlers.prepareTransfer({
			kind: "transfer",
			recipient: address(6),
			amount: 1n,
			idempotencyKey: "one",
		}),
	).resolves.toMatchObject({ id: "one" });
	prepare.mockImplementationOnce(async () => ({
		id: "different",
		requestHash: H,
		safeTxHash: H,
		kind: "base-transfer",
		requiredApprovals: ["primary"],
		publicRequest: { kind: "transfer", idempotencyKey: "one" },
	}));
	await expect(
		handlers.prepareTransfer({
			kind: "transfer",
			recipient: address(6),
			amount: 1n,
			idempotencyKey: "one",
		}),
	).rejects.toThrow(/does not match/);
	await expect(
		handlers.verifyApproval(H, {
			role: "primary",
			assertion: { id: "another", type: "public-key" },
		}),
	).rejects.toThrow();
});
