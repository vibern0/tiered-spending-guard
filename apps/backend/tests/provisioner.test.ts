import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, type Address, type Hex } from "viem";
import {
	brandPwaProvisioningExecutionContextForTestsOnly,
	type PwaProvisioningPlan,
	type PwaProvisioningTransaction,
} from "@tiered-spending-guard/security-core/pwa";
import {
	createAutomaticPwaProvisioner,
	pwaProvisioningAuthorizationPath,
} from "../src/provisioning/service";
import type { StoredCredential } from "../src/auth/webauthn";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const hex = (n: number) => `0x${n.toString(16).padStart(2, "0")}` as Hex;
const hash = (n: number) => keccak256(hex(n));
const ids = [
	"primary-signer",
	"secondary-signer",
	"setup-helper",
	"guard",
	"delay",
	"maintenance",
	"safe-proxy",
] as const;
const publicKey = new Uint8Array([1, 2, 3]);
const credentials = Object.freeze({
	primary: Object.freeze({
		role: "primary",
		id: "primary-id",
		publicKey,
		counter: 0,
		x: 1n,
		y: 2n,
	}) as StoredCredential,
	secondary: Object.freeze({
		role: "secondary",
		id: "secondary-id",
		publicKey,
		counter: 0,
		x: 3n,
		y: 4n,
	}) as StoredCredential,
});

function plan(chainId = 11155111): PwaProvisioningPlan {
	return {
		formatVersion: 1,
		chainId,
		deployer: address(1),
		primaryPasskey: address(2),
		secondaryPasskey: address(3),
		safe: address(4),
		guard: address(5),
		delay: address(6),
		usdc: address(7),
		deploymentsHash: hash(8),
		policyHash: hash(9),
		planHash: hash(10),
		policy: {},
		infrastructure: {},
		transactions: ids.map((id, index) => ({
			id,
			nonce: 1n + BigInt(index),
			to: address(10),
			value: 0n,
			data: hex(1),
			operation: 0,
			description: id,
			expectedCreatedAddress: address(20 + index),
			creationCodeHash: hash(30 + index),
			expectedRuntimeCodeHash: hash(40 + index),
		})),
		vaultPlan: { safeProxySaltNonce: 0n, review: { policyHash: hash(9) } },
	} as unknown as PwaProvisioningPlan;
}

function approved(transaction: PwaProvisioningTransaction) {
	return Object.freeze({
		...transaction,
		gasLimit: 1_000_000n,
		maxFeePerGas: 2_000_000_000n,
		maxPriorityFeePerGas: 1_000_000_000n,
	});
}

describe("automatic PWA provisioner", () => {
	it("automatically refreshes verified recovery after a transient read before trying execution again", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pwa-automatic-read-retry-"));
		const reloadRecovery = vi.fn().mockResolvedValue(undefined);
		const close = vi.fn();
		let unavailable = true;
		const provisioner = createAutomaticPwaProvisioner({
			reviewDirectory: join(directory, "reviews"),
			reloadRecovery,
			createPlan: async () => plan(),
			executionContext: async () => ({
				close,
				context: brandPwaProvisioningExecutionContextForTestsOnly({
					confirmedPrefixLength: async () => 0,
					currentDeployerNonce: async () => 1n,
					authorize: async (transaction) => {
						if (unavailable) {
							unavailable = false;
							throw new Error(
								"identity provider 1 Sepolia RPC request failed (estimateGas; ResourceNotFoundRpcError)",
							);
						}
						return approved(transaction);
					},
					submit: async (transaction) => ({
						transactionHash: hash(Number(transaction.nonce)),
						receipt: { status: "success" as const, blockNumber: 1n },
					}),
					verifyFinalTopology: async () => hash(99),
				}),
			}),
		});
		expect((await provisioner.provision(credentials)).response.safe).toBe(plan().safe);
		expect(reloadRecovery).toHaveBeenCalledTimes(2);
		expect(close).toHaveBeenCalledTimes(2);
	});
	it("separates append-only authorization ledgers by reviewed package", () => {
		expect(pwaProvisioningAuthorizationPath("/tmp/provisioning.json", hash(50))).toBe(
			`/tmp/provisioning.json.authorizations.${hash(50).slice(2)}.json`,
		);
		expect(pwaProvisioningAuthorizationPath("/tmp/provisioning.json", hash(51))).not.toBe(
			pwaProvisioningAuthorizationPath("/tmp/provisioning.json", hash(50)),
		);
	});

	it("writes review before per-transaction authorization and single-flights duplicate fresh calls", async () => {
		const directory = mkdtempSync(join(tmpdir(), "automatic-pwa-provisioner-"));
		const reviews = join(directory, "reviews");
		const value = plan();
		const events: string[] = [];
		let releasePlan: (() => void) | undefined;
		const waitForRelease = new Promise<void>((resolve) => {
			releasePlan = resolve;
		});
		const createPlan = vi.fn(async () => {
			events.push("plan");
			await waitForRelease;
			return value;
		});
		const close = vi.fn();
		const executionContext = vi.fn(async () => ({
			context: brandPwaProvisioningExecutionContextForTestsOnly({
				async confirmedPrefixLength() {
					return 0;
				},
				async currentDeployerNonce() {
					return 1n;
				},
				async authorize(transaction) {
					expect(readdirSync(reviews)).toHaveLength(1);
					events.push(`authorize:${transaction.id}`);
					return approved(transaction);
				},
				async submit(transaction) {
					events.push(`sign:${transaction.id}`);
					return {
						transactionHash: hash(events.length),
						receipt: { status: "success" as const, blockNumber: 100n },
					};
				},
				async verifyFinalTopology() {
					events.push("verify-topology");
					return hash(99);
				},
			}),
			close,
		}));
		const provisioner = createAutomaticPwaProvisioner({
			reviewDirectory: reviews,
			createPlan,
			executionContext,
		});

		const first = provisioner.provision(credentials);
		const second = provisioner.provision(credentials);
		expect(first).toBe(second);
		releasePlan!();
		const [firstResult, secondResult] = await Promise.all([first, second]);

		expect(firstResult).toBe(secondResult);
		expect(firstResult.response.safe).toBe(value.safe);
		expect(firstResult.response.evidence.blockNumber).toBe("100");
		expect(events.slice(0, 3)).toEqual([
			"plan",
			"authorize:primary-signer",
			"sign:primary-signer",
		]);
		expect(events.at(-1)).toBe("verify-topology");
		expect(createPlan).toHaveBeenCalledTimes(1);
		expect(executionContext).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledOnce();
		await expect(
			provisioner.provision({
				...credentials,
				secondary: { ...credentials.secondary, id: "changed" },
			}),
		).rejects.toThrow(/credential/i);
	});

	it("requires credentials only for a fresh plan and rejects non-Sepolia before authorization", async () => {
		const directory = mkdtempSync(join(tmpdir(), "automatic-pwa-chain-"));
		const authorize = vi.fn();
		const provisioner = createAutomaticPwaProvisioner({
			reviewDirectory: join(directory, "reviews"),
			createPlan: async () => plan(1),
			executionContext: async () => ({
				context: brandPwaProvisioningExecutionContextForTestsOnly({
					confirmedPrefixLength: async () => 0,
					currentDeployerNonce: async () => 1n,
					authorize,
					submit: vi.fn(),
					verifyFinalTopology: vi.fn(),
				}),
				close: vi.fn(),
			}),
		});
		await expect(provisioner.provision()).rejects.toThrow(/credentials/i);
		await expect(provisioner.provision(credentials)).rejects.toThrow(/Sepolia/i);
		expect(authorize).not.toHaveBeenCalled();
	});

	it("resumes a prepared recovery with no credentials and never authorizes or submits its confirmed prefix", async () => {
		const directory = mkdtempSync(join(tmpdir(), "automatic-pwa-recovery-"));
		const value = plan();
		const events: string[] = [];
		const createPlan = vi.fn();
		const provisioner = createAutomaticPwaProvisioner({
			reviewDirectory: join(directory, "reviews"),
			recovery: {
				plan: value,
				confirmedPrefixLength: 2,
				credentials: { primary: { x: 1n, y: 2n }, secondary: { x: 3n, y: 4n } },
			},
			createPlan,
			executionContext: async () => ({
				context: brandPwaProvisioningExecutionContextForTestsOnly({
					confirmedPrefixLength: async () => 2,
					currentDeployerNonce: async () => 3n,
					async authorize(transaction) {
						events.push(`authorize:${transaction.id}`);
						return approved(transaction);
					},
					async submit(transaction) {
						events.push(`submit:${transaction.id}`);
						return {
							transactionHash: hash(Number(transaction.nonce)),
							receipt: { status: "success" as const, blockNumber: 100n },
						};
					},
					async verifyFinalTopology() {
						return hash(99);
					},
				}),
				close: vi.fn(),
			}),
		});

		const first = provisioner.provision();
		const second = provisioner.provision();
		expect(first).toBe(second);
		await expect(first).resolves.toMatchObject({ response: { safe: value.safe } });
		expect(createPlan).not.toHaveBeenCalled();
		expect(events[0]).toBe("authorize:setup-helper");
		expect(events).not.toContain("authorize:primary-signer");
		expect(events).not.toContain("submit:secondary-signer");
	});

	it("exposes a read-only recovery preflight without planning, signing, or opening execution", async () => {
		const directory = mkdtempSync(join(tmpdir(), "automatic-pwa-preflight-"));
		const value = plan();
		const createPlan = vi.fn();
		const executionContext = vi.fn();
		const preflightResult = Object.freeze({
			confirmedPrefixLength: 2,
			nextTransactionId: "setup-helper" as const,
			nextTransactionNonce: "3",
			packageHash: hash(50),
			planHash: value.planHash,
			quoteBlockNumber: "100",
			quoteBlockHash: hash(51),
			gasEstimateA: "100000",
			gasEstimateB: "101000",
			gasLimit: "131300",
			maxFeePerGas: "3000000000",
			maxPriorityFeePerGas: "1000000000",
			confirmedActualCost: "200000",
			resultingOutlayWei: "394100000000000",
			relayBalance: "10000000000000000",
		});
		const preflight = vi.fn(async () => preflightResult);
		const provisioner = createAutomaticPwaProvisioner({
			reviewDirectory: join(directory, "reviews"),
			recovery: {
				plan: value,
				confirmedPrefixLength: 2,
				credentials: { primary: { x: 1n, y: 2n }, secondary: { x: 3n, y: 4n } },
			},
			createPlan,
			executionContext,
			preflight,
		});

		await expect(provisioner.preflight!()).resolves.toBe(preflightResult);
		expect(preflight).toHaveBeenCalledOnce();
		expect(createPlan).not.toHaveBeenCalled();
		expect(executionContext).not.toHaveBeenCalled();
	});
});
