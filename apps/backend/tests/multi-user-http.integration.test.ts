import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { createPublicClient, createWalletClient, http, parseAbi, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { describe, expect, it, vi } from "vitest";
import * as namespace from "@tiered-spending-guard/security-core/pwa";
import { AccountStore } from "../src/account-store";
import { createAccountServer } from "../src/account-server";
import { createAccountGatewayForTestsOnly } from "../src/account-runtime";
import { createConfiguredAutomaticPwaProvisionerForTestsOnly } from "../src/provisioner";
import {
	createSubmissionReadClient,
	createSubmissionRuntimeForTestsOnly,
} from "../src/submission-runtime";
import { type BackendConfig } from "../src/config";
import {
	installPublicRuntimes,
	localChain,
	softwareAuthenticator,
	PAYER_KEY,
	RECIPIENT,
	TOKEN,
	TOKEN_ABI,
} from "./automatic-http-fixtures";
const core = (namespace as unknown as { default?: typeof namespace }).default ?? namespace;
const ORIGIN = "http://localhost:5173";
const challenge = (hash: Hex) => Buffer.from(hash.slice(2), "hex").toString("base64url");

describe("real Safe multi-user HTTP", () => {
	it("creates A/B/C, restores a synced first key after reset/restart, and retains exact base/step-up isolation", async () => {
		const directory = mkdtempSync(join(tmpdir(), "multi-user-safe-")),
			chain = await localChain(directory);
		let backend: ReturnType<typeof createAccountServer> | undefined,
			store: AccountStore | undefined;
		try {
			await installPublicRuntimes(chain.rpc);
			const payer = privateKeyToAccount(PAYER_KEY);
			await chain.rpc("hardhat_setBalance", [payer.address, toHex(100n * 10n ** 18n)]);
			const publicClient = createPublicClient({
				chain: sepolia,
				transport: http(chain.url),
				cacheTime: 0,
				pollingInterval: 10,
			});
			const wallet = createWalletClient({
				chain: sepolia,
				account: payer,
				transport: http(chain.url),
			});
			const mine = () => chain.rpc("hardhat_mine", ["0x5"]);
			const provider = (label: string) => ({
				...createSubmissionReadClient(`${chain.url}/${label}`, label),
				getBlockNumber: async () => BigInt(await chain.rpc<string>("eth_blockNumber")),
			});
			const providers = [provider("a"), provider("b")] as const,
				relay = provider("relay");
			const provisionSend = vi.fn(
				async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
					const hash = await publicClient.sendRawTransaction({
						serializedTransaction,
					});
					await mine();
					return hash;
				},
			);
			const execution = {
				...relay,
				sendRawTransaction: provisionSend,
				estimateGas: (args: Parameters<typeof publicClient.estimateGas>[0]) =>
					publicClient.estimateGas(args),
				getTransactionReceipt: async (args: { hash: Hex }) =>
					publicClient.getTransactionReceipt(args),
				estimateFeesPerGas: async () => {
					const fee = await publicClient.estimateFeesPerGas({
						type: "eip1559",
					});
					return {
						maxFeePerGas: fee.maxFeePerGas!,
						maxPriorityFeePerGas: fee.maxPriorityFeePerGas!,
					};
				},
				waitForTransactionReceipt: async (args: { hash: Hex; confirmations: number }) =>
					publicClient.waitForTransactionReceipt(args),
			};
			const send = vi.fn(async (raw: Hex) =>
				publicClient.sendRawTransaction({ serializedTransaction: raw }),
			);
			const config: BackendConfig = {
				id: "local",
				host: "127.0.0.1",
				port: 0,
				chainId: 11155111,
				rpId: "localhost",
				origin: ORIGIN,
				rpcUrl: chain.url,
				relayPrivateKey: PAYER_KEY,
				journalPath: join(directory, "legacy-s.json"),
				provisioningJournalPath: join(directory, "legacy-p.json"),
				provisioningReviewDirectory: join(directory, "legacy-r"),
			};
			const start = async () => {
				store = new AccountStore(config);
				const gateway = createAccountGatewayForTestsOnly(config, store, {
					provisioner: (c) =>
						createConfiguredAutomaticPwaProvisionerForTestsOnly(c, {
							providers,
							relay: execution,
						}),
					runtime: (c, vault, beforeSign) =>
						createSubmissionRuntimeForTestsOnly(
							c,
							{ providers, relay, sendRawTransaction: send, beforeSign },
							vault,
						),
				});
				backend = createAccountServer(config, store, gateway);
				await backend!.fastify.listen({ port: 0, host: "127.0.0.1" });
			};
			function browser() {
				let cookie = "",
					csrf = "",
					account = "";
				return {
					clear() {
						cookie = "";
						csrf = "";
						account = "";
					},
					async request(
						path: string,
						value?: unknown,
						headers: Record<string, string> = {},
					) {
						const port = (backend!.server.address() as { port: number }).port;
						const response = await fetch(`http://127.0.0.1:${port}${path}`, {
							method: value === undefined ? "GET" : "POST",
							headers: {
								origin: ORIGIN,
								"content-type": "application/json",
								...(cookie ? { cookie } : {}),
								...(csrf ? { "x-csrf-token": csrf } : {}),
								...(account ? { "x-vault-account": account } : {}),
								...headers,
							},
							...(value === undefined
								? {}
								: {
										body: JSON.stringify(value, (_key, v) =>
											typeof v === "bigint" ? `${v}n` : v,
										),
									}),
						});
						const set = response.headers.get("set-cookie");
						if (set) cookie = set.split(";", 1)[0]!;
						const body = await response.json();
						if (body.csrfToken) csrf = body.csrfToken;
						if (body.account) account = body.account.id;
						return { status: response.status, body };
					},
					async post(path: string, value: unknown) {
						const result = await this.request(path, value);
						expect(result.status, `${path}: ${JSON.stringify(result.body)}`).toBe(200);
						return result.body;
					},
				};
			}
			await start();
			const people = await Promise.all(
				[0, 1, 2].map(async () => {
					const client = browser(),
						setup = await client.post("/v1/auth/setup", {}),
						primary = softwareAuthenticator("primary", { synced: true }),
						secondary = softwareAuthenticator("secondary");
					const registration = await client.post("/v1/registrations/primary/options", {});
					expect(registration.authenticatorAttachment).toBeUndefined();
					await client.post("/v1/registrations/primary/verify", {
						sessionId: registration.sessionId,
						registration: primary.registration(registration.challenge),
					});
					const login = await client.post("/v1/auth/login/options", {}),
						assertion = primary.assertion(login.challenge);
					assertion.response.userHandle = setup.account.userHandle;
					await client.post("/v1/auth/login/verify", {
						sessionId: login.sessionId,
						assertion,
					});
					const second = await client.post("/v1/registrations/secondary/options", {});
					await client.post("/v1/registrations/secondary/verify", {
						sessionId: second.sessionId,
						registration: secondary.registration(second.challenge),
					});
					return { client, primary, secondary, account: setup.account };
				}),
			);
			const vaults = await Promise.all(
				people.map((p) => p.client.post("/v1/vaults/auto-provision", {})),
			);
			expect(new Set(vaults.map((v) => v.safe)).size).toBe(3);
			expect(provisionSend).toHaveBeenCalledTimes(21);
			const [a, b] = people;
			const vault = vaults[0]!;
			expect(store!.credential(a!.primary.id)).toMatchObject({
				counter: 0,
				backupEligible: true,
				backedUp: true,
			});
			const mint = await wallet.writeContract({
				address: TOKEN,
				abi: TOKEN_ABI,
				functionName: "mint",
				args: [vault.safe, 10_000_000n],
			});
			await publicClient.waitForTransactionReceipt({ hash: mint });
			const beforeRestart = readFileSync(
				store!.account(a!.account.id)!.config.provisioningJournalPath,
				"utf8",
			);
			const aConfig = store!.account(a!.account.id)!.config;
			const authorization = readdirSync(dirname(aConfig.provisioningJournalPath)).find(
				(name) =>
					name.startsWith(
						basename(aConfig.provisioningJournalPath) + ".authorizations.",
					) && name.endsWith(".json"),
			)!;
			const authorizationLock = join(
				dirname(aConfig.provisioningJournalPath),
				`${authorization}.lock`,
			);
			writeFileSync(authorizationLock, `${process.pid}\n`);
			await backend!.close();
			store!.close();
			await start();
			a!.client.clear();
			const login = await a!.client.post("/v1/auth/login/options", {}),
				assertion = a!.primary.assertion(login.challenge);
			assertion.response.userHandle = a!.account.userHandle;
			const session = await a!.client.post("/v1/auth/login/verify", {
				sessionId: login.sessionId,
				assertion,
			});
			expect(session).toMatchObject({
				authenticated: true,
				account: { id: a!.account.id, vault: { safe: vault.safe } },
			});
			expect(provisionSend).toHaveBeenCalledTimes(21);
			expect(readFileSync(authorizationLock, "utf8")).toBe(`${process.pid}\n`);
			expect(
				(
					await a!.client.request("/v1/vaults/current", undefined, {
						"x-vault-account": b!.account.id,
					})
				).status,
			).toBe(403);
			const prepared = await a!.client.post("/v1/submissions/prepare", {
				kind: "transfer",
				recipient: RECIPIENT,
				amount: 500_000n,
				idempotencyKey: "base",
			});
			expect(prepared.kind).toBe("base-transfer");
			const base = await a!.client.post("/v1/submissions/base/submit", {
				role: "primary",
				assertion: a!.primary.assertion(challenge(prepared.safeTxHash)),
			});
			expect(base.state).toBe("uncertain");
			a!.client.clear();
			const lostLogin = await a!.client.post("/v1/auth/login/options", {}),
				lostAssertion = a!.primary.assertion(lostLogin.challenge);
			lostAssertion.response.userHandle = a!.account.userHandle;
			const restored = await a!.client.post("/v1/auth/login/verify", {
				sessionId: lostLogin.sessionId,
				assertion: lostAssertion,
			});
			expect(restored.account.submissionIds).toContain("base");

			await mine();
			expect((await a!.client.request("/v1/submissions/base")).body.state).toBe("confirmed");
			const recipient = (
				core.loadCommittedPwaPhaseOneProfile().elevatedRecipients as readonly string[]
			)[0]!;
			const step = await a!.client.post("/v1/submissions/prepare", {
				kind: "transfer",
				recipient,
				amount: 1_000_000n,
				idempotencyKey: "step",
			});
			expect(step.kind).toBe("step-up-transfer");
			const oldApproval = a!.primary.assertion(challenge(step.safeTxHash));
			expect(
				(
					await a!.client.post("/v1/submissions/step/submit", {
						role: "primary",
						assertion: oldApproval,
					})
				).state,
			).toBe("awaiting-secondary");
			await a!.client.post("/v1/auth/logout", {});
			const nextLogin = await a!.client.post("/v1/auth/login/options", {}),
				nextAssertion = a!.primary.assertion(nextLogin.challenge);
			nextAssertion.response.userHandle = a!.account.userHandle;
			await a!.client.post("/v1/auth/login/verify", {
				sessionId: nextLogin.sessionId,
				assertion: nextAssertion,
			});
			const replacement = await a!.client.post("/v1/submissions/prepare", {
				kind: "transfer",
				recipient,
				amount: 1_000_000n,
				idempotencyKey: "step-new",
			});
			expect(replacement.safeTxHash).toBe(step.safeTxHash);
			expect(
				(
					await a!.client.request("/v1/submissions/step-new/submit", {
						role: "primary",
						assertion: oldApproval,
					})
				).status,
			).toBe(400);
			expect(
				(
					await a!.client.post("/v1/submissions/step-new/submit", {
						role: "primary",
						assertion: a!.primary.assertion(challenge(replacement.safeTxHash)),
					})
				).state,
			).toBe("awaiting-secondary");
			const count = send.mock.calls.length;
			expect(
				(
					await a!.client.request("/v1/submissions/step-new/submit", {
						role: "secondary",
						assertion: b!.secondary.assertion(challenge(step.safeTxHash)),
					})
				).status,
			).toBe(400);
			expect(send.mock.calls.length).toBe(count);
			expect(
				(
					await a!.client.post("/v1/submissions/step-new/submit", {
						role: "secondary",
						assertion: a!.secondary.assertion(challenge(step.safeTxHash)),
					})
				).state,
			).toBe("uncertain");
			await mine();
			expect((await a!.client.request("/v1/submissions/step-new")).body.state).toBe(
				"confirmed",
			);
			expect(
				await publicClient.readContract({
					address: TOKEN,
					abi: TOKEN_ABI,
					functionName: "balanceOf",
					args: [vault.safe],
				}),
			).toBe(8_500_000n);
			expect(
				await publicClient.readContract({
					address: TOKEN,
					abi: TOKEN_ABI,
					functionName: "balanceOf",
					args: [vaults[1]!.safe],
				}),
			).toBe(0n);
			expect(
				await publicClient.readContract({
					address: vault.guard,
					abi: parseAbi([
						"function spendState(address) view returns (uint256,uint256,uint256)",
					]),
					functionName: "spendState",
					args: [TOKEN],
				}),
			).toMatchObject([expect.any(BigInt), 500_000n, 1_500_000n]);
			expect(
				readFileSync(store!.account(a!.account.id)!.config.provisioningJournalPath, "utf8"),
			).toBe(beforeRestart);
		} finally {
			await backend?.close();
			store?.close();
			await chain.close();
			rmSync(directory, { recursive: true, force: true });
		}
	}, 120_000);
});
