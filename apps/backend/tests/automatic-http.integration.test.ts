import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import {
	createPublicClient,
	createWalletClient,
	http,
	keccak256,
	parseAbi,
	toHex,
	type Address,
	type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { describe, expect, it, vi } from "vitest";
import * as namespace from "@tiered-spending-guard/security-core/pwa";
import type { BackendConfig } from "../src/config/config";
import { AccountStore } from "../src/accounts/store";
import { VaultHistory } from "../src/history/service";
import { createHistoryReadClient } from "../src/history/read-client";
import { createAccountServer } from "../src/http/server";
import { createAccountGatewayForTestsOnly } from "../src/accounts/runtime";
import { createConfiguredAutomaticPwaProvisionerForTestsOnly } from "../src/provisioning/runtime";
import { type BackendPwaProvisioningCompletion } from "../src/provisioning/service";
import {
	createSubmissionReadClient,
	createSubmissionRuntimeForTestsOnly,
} from "../src/submissions/runtime";
import { SubmissionJournal } from "../src/submissions/journal";
import type { BackendPreparedSubmission } from "../src/submissions/types";
import {
	installPublicRuntimes,
	localChain,
	PAYER_KEY,
	RECIPIENT,
	softwareAuthenticator,
	TOKEN,
	TOKEN_ABI,
} from "./automatic-http-fixtures";

const core = (namespace as unknown as { default?: typeof namespace }).default ?? namespace;
const ORIGIN = "http://localhost:5173";
const digestChallenge = (digest: Hex) => Buffer.from(digest.slice(2), "hex").toString("base64url");

describe("automatic account creation through frontend-equivalent HTTP", () => {
	it.each(["fresh", "lost-provisioning-response"] as const)(
		"%s: genuine account registration, background creation, first-key restart login and X/Y/Z/recipient/cancel/expiry receipts",
		async (mode) => {
			const directory = mkdtempSync(join(tmpdir(), "automatic-http-integration-"));
			const chain = await localChain(directory);
			let backend: ReturnType<typeof createAccountServer> | undefined;
			let store: AccountStore | undefined;
			let runtime: ReturnType<typeof createSubmissionRuntimeForTestsOnly> | undefined;
			let prepared: BackendPreparedSubmission | undefined;
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
					account: payer,
					chain: sepolia,
					transport: http(chain.url),
				});
				const mine = () => chain.rpc("hardhat_mine", ["0x5"]);
				const provider = (source: string) => ({
					...createSubmissionReadClient(`${chain.url}/${source}`, source),
					getBlockNumber: async () => BigInt(await chain.rpc<string>("eth_blockNumber")),
					estimateGas: (args: Parameters<typeof publicClient.estimateGas>[0]) =>
						publicClient.estimateGas(args),
				});
				const providers = [provider("identity-a"), provider("identity-b")] as const;
				const relay = provider("relay");
				const profile = core.loadCommittedPwaPhaseOneProfile();
				const rootConfig: BackendConfig = {
					id: "local",
					host: "127.0.0.1",
					port: 0,
					chainId: 11155111,
					rpId: "localhost",
					origin: ORIGIN,
					rpcUrl: chain.url,
					relayPrivateKey: PAYER_KEY,
					dataRoot: join(directory, "account-data"),
					accountDatabasePath: join(directory, "account-data", "accounts.sqlite"),
					journalPath: join(directory, "unused-submissions.json"),
					provisioningJournalPath: join(directory, "unused-provisioning.json"),
					provisioningReviewDirectory: join(directory, "unused-reviews"),
				};
				const primary = softwareAuthenticator("primary", { synced: true }),
					secondary = softwareAuthenticator("secondary");
				let completion: BackendPwaProvisioningCompletion | undefined;
				let loseProvisioningResponse = mode === "lost-provisioning-response";
				const provisionSend = vi.fn(
					async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
						expect(
							core
								.readLiveJournal(config.provisioningJournalPath, payer.address)
								.entries.at(-1),
						).toMatchObject({
							status: "pending",
							transactionHash: keccak256(serializedTransaction),
						});
						const hash = await publicClient.sendRawTransaction({
							serializedTransaction,
						});
						await mine();
						if (loseProvisioningResponse) {
							loseProvisioningResponse = false;
							throw new Error(
								"local fixture: connection lost after provisioning broadcast",
							);
						}
						return hash;
					},
				);
				const executionClient = {
					...relay,
					sendRawTransaction: provisionSend,
					getTransactionReceipt: (args: { hash: Hex }) =>
						publicClient.getTransactionReceipt(args),
					estimateFeesPerGas: async () => {
						const fees = await publicClient.estimateFeesPerGas({ type: "eip1559" });
						return {
							maxFeePerGas: fees.maxFeePerGas!,
							maxPriorityFeePerGas: fees.maxPriorityFeePerGas!,
						};
					},
					waitForTransactionReceipt: (args: { hash: Hex; confirmations: number }) =>
						publicClient.waitForTransactionReceipt(args),
				};
				let loseSubmissionResponse = true;
				const send = vi.fn(async (raw: Hex) => {
					expect(
						new SubmissionJournal(config.journalPath).findByOuterHash(keccak256(raw))
							?.state,
					).toBe("submitting");
					const hash = await publicClient.sendRawTransaction({
						serializedTransaction: raw,
					});
					if (loseSubmissionResponse) {
						loseSubmissionResponse = false;
						throw new Error("local fixture: connection lost after exact broadcast");
					}
					return hash;
				});
				const creationErrors: unknown[] = [];
				let gateway!: ReturnType<typeof createAccountGatewayForTestsOnly>;
				const start = async () => {
					store = new AccountStore(rootConfig);
					gateway = createAccountGatewayForTestsOnly(rootConfig, store, {
						provisioner: async (accountConfig) => {
							const provisioner =
								await createConfiguredAutomaticPwaProvisionerForTestsOnly(
									accountConfig,
									{ providers, relay: executionClient },
								);
							return {
								...provisioner,
								provision: async (
									...args: Parameters<typeof provisioner.provision>
								) => {
									completion = await provisioner.provision(...args);
									return completion;
								},
							};
						},
						runtime: (accountConfig, vault, beforeSign) => {
							runtime = createSubmissionRuntimeForTestsOnly(
								accountConfig,
								{ providers, relay, sendRawTransaction: send, beforeSign },
								vault,
							);
							return runtime;
						},
					});
					backend = createAccountServer(rootConfig, store, {
						...gateway,
						runProvisioning: async (id) => {
							try {
								await gateway.runProvisioning!(id);
							} catch (error) {
								creationErrors.push(error);
								throw error;
							}
						},
					});
					await backend.fastify.listen({ port: 0, host: "127.0.0.1" });
				};
				let cookie = "",
					csrf = "",
					accountId = "",
					userHandle = "";
				const request = async <T = any>(
					path: string,
					body?: unknown,
					origin = ORIGIN,
				): Promise<{ status: number; body: T }> => {
					const port = (backend!.server.address() as { port: number }).port;
					const response = await fetch(`http://127.0.0.1:${port}${path}`, {
						method: body === undefined ? "GET" : "POST",
						headers: {
							origin,
							"content-type": "application/json",
							...(cookie ? { cookie } : {}),
							...(csrf ? { "x-csrf-token": csrf } : {}),
							...(accountId ? { "x-vault-account": accountId } : {}),
						},
						...(body === undefined
							? {}
							: {
									body: JSON.stringify(body, (_key, value) =>
										typeof value === "bigint" ? `${value}n` : value,
									),
								}),
					});
					const set = response.headers.get("set-cookie");
					if (set) cookie = set.split(";", 1)[0]!;
					const data = await response.json();
					if (data.csrfToken) csrf = data.csrfToken;
					if (data.account) {
						accountId = data.account.id;
						userHandle = data.account.userHandle;
					}
					return { status: response.status, body: data as T };
				};
				const post = async <T = any>(path: string, body: unknown): Promise<T> => {
					const result = await request<T>(path, body);
					expect(result, path).toMatchObject({ status: 200 });
					return result.body;
				};
				const login = async () => {
					const options = await post("/v1/auth/login/options", {});
					const assertion = primary.assertion(options.challenge);
					assertion.response.userHandle = userHandle;
					return post("/v1/auth/login/verify", {
						sessionId: options.sessionId,
						assertion,
					});
				};
				await start();
				expect(provisionSend).not.toHaveBeenCalled();
				expect(await request("/v1/vaults/current")).toMatchObject({ status: 401 });
				await post("/v1/auth/setup", {});
				const config = store!.account(accountId)!.config;
				expect(
					await request("/v1/registrations/primary/options", {}, "https://wrong.example"),
				).toMatchObject({ status: 403 });
				// Invalid registrations consume their fresh challenges without installing a key.
				for (const fault of ["challenge", "origin"] as const) {
					const options = await post("/v1/registrations/primary/options", {});
					const registration = primary.registration(
						fault === "challenge" ? "wrong" : options.challenge,
						fault === "origin" ? "https://wrong.example" : ORIGIN,
					);
					const body = { sessionId: options.sessionId, registration };
					expect((await request("/v1/registrations/primary/verify", body)).status).toBe(
						400,
					);
					expect((await request("/v1/registrations/primary/verify", body)).status).toBe(
						400,
					);
				}
				for (const [role, authenticator] of [
					["primary", primary],
					["secondary", secondary],
				] as const) {
					const options = await post(`/v1/registrations/${role}/options`, {});
					expect(options.authenticatorAttachment).toBe(
						role === "primary" ? undefined : "cross-platform",
					);
					const body = {
						sessionId: options.sessionId,
						registration: authenticator.registration(options.challenge),
					};
					expect(await post(`/v1/registrations/${role}/verify`, body)).toMatchObject({
						role,
						credentialId: authenticator.id,
						counter: 0,
					});
					expect((await request(`/v1/registrations/${role}/verify`, body)).status).toBe(
						409,
					);
					if (role === "primary") await login();
				}
				expect(
					(await request("/v1/vaults/auto-provision", { safe: RECIPIENT })).status,
				).toBe(400);
				const observations = await Promise.all([
					request("/v1/vaults/auto-provision", {}),
					request("/v1/vaults/auto-provision", {}),
				]);
				for (const result of observations)
					expect(result).toMatchObject({
						status: 202,
						body: { state: expect.stringMatching(/queued|provisioning|verified/) },
					});
				// The request only observes. The committed worker completes independently.
				await vi.waitFor(
					() =>
						expect(
							store!.account(accountId)!.state,
							creationErrors
								.map((error) =>
									error instanceof Error ? error.stack : String(error),
								)
								.join("\n"),
						).toBe("verified"),
					{
						timeout: 60_000,
						interval: 50,
					},
				);
				const vault = (await request("/v1/vaults/current")).body;
				expect(provisionSend).toHaveBeenCalledTimes(7);
				expect(core.isVerifiedPwaProvisioningResult(completion!.verified)).toBe(true);
				const verified = completion!.verified;
				const provisionJournal = JSON.parse(
					readFileSync(config.provisioningJournalPath, "utf8"),
				);
				expect(provisionJournal.entries).toHaveLength(7);
				expect(provisionJournal.entries[0]).toMatchObject({
					status: "success",
					transactionHash: keccak256(
						provisionSend.mock.calls[0]![0].serializedTransaction,
					),
				});
				expect(vault.safe).toBe(verified.safe);
				const authorizationDirectory = dirname(config.provisioningJournalPath);
				const authorizationFiles = readdirSync(authorizationDirectory).filter(
					(name) =>
						name.startsWith(
							basename(config.provisioningJournalPath) + ".authorizations.",
						) && name.endsWith(".json"),
				);
				const authorizationBytes = Object.fromEntries(
					authorizationFiles.map((name) => [
						name,
						readFileSync(join(authorizationDirectory, name), "utf8"),
					]),
				);
				expect(
					Object.values(authorizationBytes).flatMap((bytes) => JSON.parse(bytes).records),
				).toHaveLength(7);
				const provisioningBytes = readFileSync(config.provisioningJournalPath, "utf8");
				const reviewFiles = readdirSync(config.provisioningReviewDirectory);
				expect(reviewFiles).toHaveLength(1);
				const minted = await wallet.writeContract({
					address: TOKEN,
					abi: TOKEN_ABI,
					functionName: "mint",
					args: [verified.safe, 20_000_000n],
				});
				await publicClient.waitForTransactionReceipt({ hash: minted });
				const baseIntent = {
					kind: "transfer",
					recipient: RECIPIENT,
					amount: 500_000n,
					idempotencyKey: "http-base-1",
				};
				prepared = await post<BackendPreparedSubmission>(
					"/v1/submissions/prepare",
					baseIntent,
				);
				expect(prepared.kind).toBe("base-transfer");
				expect(await post("/v1/submissions/prepare", baseIntent)).toEqual(prepared);
				expect(
					await request("/v1/submissions/prepare", { ...baseIntent, amount: 1n }),
				).toMatchObject({ status: 400 });
				const challenge = digestChallenge(prepared.safeTxHash!);
				for (const assertion of [
					primary.assertion("wrong-challenge"),
					primary.assertion(challenge, "https://wrong.example"),
					secondary.assertion(challenge),
				]) {
					expect(
						await request(`/v1/submissions/${prepared.id}/submit`, {
							role: "primary",
							assertion,
						}),
					).toMatchObject({ status: 400 });
				}
				expect(send).not.toHaveBeenCalled();
				const approval = { role: "primary", assertion: primary.assertion(challenge) };
				expect(
					await request(`/v1/submissions/${prepared.id}/submit`, approval),
				).toMatchObject({
					status: 400,
				});
				const pending = (
					await request<{ state: string; transactionHash: Hex }>(
						`/v1/submissions/${prepared.id}`,
					)
				).body;
				expect(pending.state).toBe("uncertain");
				expect(await post(`/v1/submissions/${prepared.id}/submit`, approval)).toMatchObject(
					{
						state: "uncertain",
						transactionHash: pending.transactionHash,
					},
				);
				expect(send).toHaveBeenCalledTimes(1);
				expect(
					await publicClient.readContract({
						address: TOKEN,
						abi: TOKEN_ABI,
						functionName: "balanceOf",
						args: [RECIPIENT],
					}),
				).toBe(500_000n);

				// A persisted outer hash reconciles after browser storage loss and process restart.
				await runtime!.discard?.(prepared);
				await backend!.close();
				backend = undefined;
				store!.close();
				store = undefined;
				cookie = "";
				csrf = "";
				accountId = "";
				await start();
				expect((await request("/v1/vaults/current")).status).toBe(401);
				const restored = await login();
				expect(restored).toMatchObject({
					authenticated: true,
					account: { vault: { safe: verified.safe } },
				});
				expect((await request("/health")).body).toMatchObject({ writesReady: true });
				expect(provisionSend).toHaveBeenCalledTimes(7);
				expect(send).toHaveBeenCalledTimes(1);
				await mine();
				await vi.waitFor(
					async () => {
						expect(
							(await request(`/v1/submissions/${prepared!.id}`)).body,
						).toMatchObject({
							state: "confirmed",
							transactionHash: pending.transactionHash,
						});
					},
					{ timeout: 10_000, interval: 50 },
				);
				expect(send).toHaveBeenCalledTimes(1);
				expect(readFileSync(config.provisioningJournalPath, "utf8")).toBe(
					provisioningBytes,
				);
				for (const [name, bytes] of Object.entries(authorizationBytes))
					expect(readFileSync(join(authorizationDirectory, name), "utf8")).toBe(bytes);
				expect(readdirSync(config.provisioningReviewDirectory)).toEqual(reviewFiles);
				expect(readdirSync(`${config.journalPath}.observations`)).toContain(
					`${pending.transactionHash.slice(2)}.json`,
				);

				let nextId = 1;
				const act = async (intent: Record<string, unknown>, expectedKind: string) => {
					prepared = await post<BackendPreparedSubmission>("/v1/submissions/prepare", {
						...intent,
						idempotencyKey: `http-flow-${nextId++}`,
					});
					expect(prepared.kind).toBe(expectedKind);
					let result: unknown;
					if (!prepared.requiredApprovals.length)
						result = await post(`/v1/submissions/${prepared.id}/submit`, {
							role: "none",
						});
					else {
						if (prepared.requiredApprovals.includes("secondary")) {
							expect(
								await request(`/v1/submissions/${prepared.id}/submit`, {
									role: "secondary",
									assertion: secondary.assertion(
										digestChallenge(prepared.safeTxHash!),
									),
								}),
							).toMatchObject({
								status: 400,
							});
						}
						for (const role of prepared.requiredApprovals) {
							const approval = {
								role,
								assertion: (role === "primary" ? primary : secondary).assertion(
									digestChallenge(prepared.safeTxHash!),
								),
							};
							result = await post(`/v1/submissions/${prepared.id}/submit`, approval);
							if (
								role === "primary" &&
								prepared.requiredApprovals.includes("secondary")
							)
								expect(
									await request(
										`/v1/submissions/${prepared.id}/submit`,
										approval,
									),
								).toMatchObject({
									status: 400,
								});
						}
					}
					expect(result).toMatchObject({ state: "uncertain" });
					await mine();
					await vi.waitFor(
						async () => {
							expect(
								(await request(`/v1/submissions/${prepared!.id}`)).body,
							).toMatchObject({ state: "confirmed" });
						},
						{ timeout: 10_000, interval: 50 },
					);
				};
				const transfer = (recipient: Address, amount: bigint, kind: string) =>
					act({ kind: "transfer", recipient, amount }, kind);
				const queue = async () => {
					const queueNonce = await publicClient.readContract({
						address: verified.delay,
						abi: parseAbi(["function txNonce() view returns (uint256)"]),
						functionName: "txNonce",
					});
					const queueFingerprint = await publicClient.readContract({
						address: verified.delay,
						abi: parseAbi(["function getTxHash(uint256) view returns (bytes32)"]),
						functionName: "getTxHash",
						args: [queueNonce],
					});
					return { queueNonce, queueFingerprint };
				};
				const lifecycle = async (
					kind: "cancel-queued" | "execute-ready" | "skip-expired",
				) => act({ kind, ...(await queue()) }, kind);
				const rejectExecution = async (binding: Awaited<ReturnType<typeof queue>>) => {
					const before = send.mock.calls.length;
					const response = await request("/v1/submissions/prepare", {
						kind: "execute-ready",
						...binding,
						idempotencyKey: `http-denied-${nextId++}`,
					});
					expect(response.status).toBe(400);
					expect(send).toHaveBeenCalledTimes(before);
				};
				const advance = async (seconds: number) => {
					await chain.rpc("evm_increaseTime", [seconds]);
					await chain.rpc("evm_mine");
				};
				const initialRecipient = (profile.elevatedRecipients as readonly Address[])[0]!;
				await transfer(initialRecipient, 1_000_000n, "step-up-transfer");
				await transfer(initialRecipient, 2_000_000n, "queue-transfer");
				await rejectExecution(await queue());
				await advance(121);
				await lifecycle("execute-ready");
				await act({ kind: "add-recipient", recipient: RECIPIENT }, "add-recipient");
				await advance(121);
				await lifecycle("execute-ready");
				await transfer(RECIPIENT, 750_000n, "step-up-transfer");
				await transfer(RECIPIENT, 2_000_000n, "queue-transfer");
				const cancelled = await queue();
				await lifecycle("cancel-queued");
				await rejectExecution(cancelled);
				await transfer(RECIPIENT, 2_000_000n, "queue-transfer");
				await advance(721);
				await rejectExecution(await queue());
				await lifecycle("skip-expired");
				await transfer(RECIPIENT, 2_000_000n, "queue-transfer");
				await advance(121);
				await lifecycle("execute-ready");
				expect(
					await publicClient.readContract({
						address: TOKEN,
						abi: TOKEN_ABI,
						functionName: "balanceOf",
						args: [verified.safe],
					}),
				).toBe(13_750_000n);
				expect(
					await publicClient.readContract({
						address: TOKEN,
						abi: TOKEN_ABI,
						functionName: "balanceOf",
						args: [RECIPIENT],
					}),
				).toBe(3_250_000n);
				const counters = await publicClient.readContract({
					address: verified.guard,
					abi: parseAbi([
						"function spendState(address) view returns (uint256,uint256,uint256)",
					]),
					functionName: "spendState",
					args: [TOKEN],
				});
				expect(counters.slice(1)).toEqual([500_000n, 2_250_000n]);
				expect(readFileSync(config.journalPath, "utf8")).not.toMatch(
					/assertion|signature|privateKey|authenticatorData|clientDataJSON/,
				);
				// A genuine outside-app transfer exercises the raw RPC/log history adapters.
				const payerMint = await wallet.writeContract({
					address: TOKEN,
					abi: TOKEN_ABI,
					functionName: "mint",
					args: [payer.address, 17n],
				});
				await publicClient.waitForTransactionReceipt({ hash: payerMint });
				const deposit = await wallet.writeContract({
					address: TOKEN,
					abi: parseAbi(["function transfer(address,uint256) returns (bool)"]),
					functionName: "transfer",
					args: [verified.safe, 17n],
				});
				await publicClient.waitForTransactionReceipt({ hash: deposit });
				await mine();
				const clients = [
					createHistoryReadClient(`${chain.url}/history-a`, "a"),
					createHistoryReadClient(`${chain.url}/history-b`, "b"),
				] as const;
				const openHistory = () =>
					new VaultHistory({ databasePath: store!.databasePath, clients, maxBlocks: 32 });
				const trustedVault = (await gateway.handlers(accountId)).vaultRecord()!;
				const indexedThrough = (await publicClient.getBlockNumber()) - 5n;
				let history = openHistory();
				try {
					const maxScans =
						Number((indexedThrough - BigInt(trustedVault.evidence.blockNumber)) / 32n) +
						2;
					for (
						let scan = 0;
						scan < maxScans &&
						history.page(accountId).indexedThrough !== indexedThrough;
						scan++
					)
						await history.scan(accountId, trustedVault);
					const page = history.page(accountId, { limit: 100 });
					expect(page.indexedThrough).toBe(indexedThrough);
					expect(page.nextCursor).toBeUndefined();
					expect(
						page.items.filter((item) => item.transactionHash === deposit),
					).toMatchObject([
						{
							kind: "transfer",
							direction: "in",
							amount: 17n,
							counterparty: payer.address,
						},
					]);
					const withdrawals = page.items.filter(
						(item) =>
							item.kind === "transfer" &&
							item.direction === "out" &&
							item.readyAt === undefined,
					);
					expect(withdrawals).toHaveLength(5);
					expect(withdrawals.reduce((sum, item) => sum + item.amount, 0n)).toBe(
						6_250_000n,
					);
					expect(withdrawals.map((item) => item.lane).sort()).toEqual([
						"base",
						"delayed",
						"delayed",
						"step-up",
						"step-up",
					]);
					expect(
						page.items
							.filter(
								(item) => item.kind === "transfer" && item.readyAt !== undefined,
							)
							.map((item) => item.status)
							.sort(),
					).toEqual(["cancelled", "executed", "executed", "expired"]);
					expect(
						page.items.filter((item) => item.kind === "recipient-addition"),
					).toMatchObject([{ status: "executed", counterparty: RECIPIENT }]);
					expect(page.items.filter((item) => item.kind === "cancel")).toHaveLength(1);
					expect(page.items.filter((item) => item.kind === "skip")).toHaveLength(1);
					expect(page.items.filter((item) => item.kind === "execute")).toHaveLength(3);
					history.close();
					history = openHistory();
					expect(history.page(accountId, { limit: 100 }).items).toEqual(page.items);
					await history.scan(accountId, trustedVault);
					expect(history.page(accountId, { limit: 100 }).items).toEqual(page.items);
				} finally {
					history.close();
				}
			} finally {
				if (runtime && prepared) await runtime.discard?.(prepared);
				await backend?.close();
				store?.close();
				await chain.close();
				rmSync(directory, { recursive: true, force: true });
			}
		},
		120_000,
	);
});
