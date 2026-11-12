import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import type { BackendVaultRecord } from "../src/vaults/types";
import { createConfiguredBackend } from "../src/app";
import { createConfiguredAutomaticPwaProvisionerForTestsOnly } from "../src/provisioning/runtime";
import { type BackendPwaProvisioningCompletion } from "../src/provisioning/service";
import {
	createSubmissionReadClient,
	createSubmissionRuntimeForTestsOnly,
} from "../src/submissions/runtime";
import { SubmissionJournal } from "../src/submissions/journal";
import type { BackendPreparedSubmission } from "../src/submissions/types";
import type { BackendServer } from "../src/compatibility/server";
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

describe("automatic Phase One through frontend-equivalent HTTP", () => {
	it.each([
		"fresh",
		"lost-provisioning-response",
		"confirmed-signers-with-consumed-nonce",
	] as const)(
		"%s: genuine HTTP registration, automatic setup/recovery, restart rebind and X/Y/Z/recipient/cancel/expiry receipts",
		async (mode) => {
			const directory = mkdtempSync(join(tmpdir(), "automatic-http-integration-"));
			const chain = await localChain(directory);
			let backend: Pick<BackendServer, "server" | "close"> | undefined;
			let runtime: ReturnType<typeof createSubmissionRuntimeForTestsOnly> | undefined;
			let prepared: BackendPreparedSubmission | undefined;
			let confirmationMining: Promise<unknown> | undefined;
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
				let interruptQuote = mode === "confirmed-signers-with-consumed-nonce";
				let requireSuccessorBeforeQuote = false;
				let sawSuccessorBeforeQuote = false;
				let sawConfirmationWait = false;
				let transientStartupNonceFailures = 0;
				let observedStartupNonceFailures = 0;
				const provider = (source: string) => ({
					...createSubmissionReadClient(`${chain.url}/${source}`, source),
					getBlockNumber: async () => BigInt(await chain.rpc<string>("eth_blockNumber")),
					async getTransactionCount({
						address,
						blockNumber,
						blockTag,
					}: {
						address: Address;
						blockNumber?: bigint;
						blockTag?: "latest" | "pending";
					}) {
						if (source === "local-identity-a" && transientStartupNonceFailures > 0) {
							--transientStartupNonceFailures;
							++observedStartupNonceFailures;
							throw new Error(
								"identity provider 1 Sepolia RPC request failed (getTransactionCount; InvalidInputRpcError:-32000)",
							);
						}
						const nonce = await publicClient.getTransactionCount({
							address,
							...(blockNumber === undefined
								? { blockTag: blockTag ?? "latest" }
								: { blockNumber }),
						});
						if (
							source === "local-identity-a" &&
							address.toLowerCase() === payer.address.toLowerCase() &&
							requireSuccessorBeforeQuote &&
							blockNumber !== undefined &&
							nonce < 3 &&
							!sawConfirmationWait &&
							BigInt(
								await chain.rpc<string>("eth_getTransactionCount", [
									payer.address,
									"latest",
								]),
							) === 3n
						) {
							// Return the real unconfirmed historical anchor first. Later blocks
							// make the same real receipt eligible on the backend's next poll.
							sawConfirmationWait = true;
							expect(provisionSend).toHaveBeenCalledTimes(2);
							confirmationMining = new Promise((resolve) =>
								setTimeout(resolve, 100),
							).then(mine);
						}
						return nonce;
					},
					async getBlockWithTransactions({ blockNumber }: { blockNumber: bigint }) {
						const block = await publicClient.getBlock({
							blockNumber,
							includeTransactions: true,
						});
						return {
							number: block.number,
							hash: block.hash,
							transactions: block.transactions.map((transaction) => {
								if (transaction.type !== "eip1559")
									throw new Error(
										"local fixture only permits EIP-1559 transactions",
									);
								return {
									hash: transaction.hash,
									chainId: transaction.chainId!,
									type: "eip1559" as const,
									from: transaction.from,
									to: transaction.to,
									nonce: transaction.nonce,
									value: transaction.value,
									input: transaction.input,
									gas: transaction.gas,
									maxFeePerGas: transaction.maxFeePerGas!,
									maxPriorityFeePerGas: transaction.maxPriorityFeePerGas!,
								};
							}),
						};
					},
					async estimateGas(args: Parameters<typeof publicClient.estimateGas>[0]) {
						const nonce = BigInt(
							await chain.rpc<string>("eth_getTransactionCount", [
								payer.address,
								"latest",
							]),
						);
						if (interruptQuote && nonce === 2n)
							throw new Error(
								"local fixture: transient quote read unavailable after confirmed signers",
							);
						if (requireSuccessorBeforeQuote && nonce === 3n) {
							expect(readdirSync(config.provisioningReviewDirectory)).toHaveLength(2);
							sawSuccessorBeforeQuote = true;
						}
						return publicClient.estimateGas(args);
					},
				});
				const providers = [
					provider("local-identity-a"),
					provider("local-identity-b"),
				] as const;
				const relay = provider("local-relay");
				const profile = core.loadCommittedPwaPhaseOneProfile();
				const config: BackendConfig = {
					id: "local",
					host: "127.0.0.1",
					port: 0,
					chainId: 11155111,
					rpId: "localhost",
					origin: ORIGIN,
					rpcUrl: chain.url,
					relayPrivateKey: PAYER_KEY,
					journalPath: join(directory, "submissions.json"),
					provisioningJournalPath: join(directory, "provisioning.json"),
					provisioningReviewDirectory: join(directory, "reviews"),
				};
				const primary = softwareAuthenticator("primary"),
					secondary = softwareAuthenticator("secondary");
				let completion: BackendPwaProvisioningCompletion | undefined;
				let currentVault: BackendVaultRecord | undefined;
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
					async getTransactionReceipt(input: { hash: Hex }) {
						const receipt = await publicClient.getTransactionReceipt(input);
						return {
							transactionHash: receipt.transactionHash,
							status: receipt.status,
							gasUsed: receipt.gasUsed,
							effectiveGasPrice: receipt.effectiveGasPrice,
							blockNumber: receipt.blockNumber,
							blockHash: receipt.blockHash,
						};
					},
					estimateFeesPerGas: async () => {
						const fees = await publicClient.estimateFeesPerGas({ type: "eip1559" });
						return {
							maxFeePerGas: fees.maxFeePerGas!,
							maxPriorityFeePerGas: fees.maxPriorityFeePerGas!,
						};
					},
					async waitForTransactionReceipt(input: { hash: Hex; confirmations: number }) {
						const receipt = await publicClient.waitForTransactionReceipt(input);
						return {
							transactionHash: receipt.transactionHash,
							status: receipt.status,
							gasUsed: receipt.gasUsed,
							effectiveGasPrice: receipt.effectiveGasPrice,
							blockNumber: receipt.blockNumber,
							blockHash: receipt.blockHash,
						};
					},
				};
				const automatic = async () => {
					const provisioner = await createConfiguredAutomaticPwaProvisionerForTestsOnly(
						config,
						{
							providers,
							relay: executionClient,
						},
					);
					// Observe the genuine completion only to supply the existing runtime's
					// read-only restart reconstruction callback. No verifier is replaced.
					return {
						get recoveryCredentials() {
							return provisioner.recoveryCredentials;
						},
						get historicalVault() {
							return provisioner.historicalVault;
						},
						get completedRecoveryReady() {
							return provisioner.completedRecoveryReady;
						},
						preflight: provisioner.preflight,
						provision: async (...args: Parameters<typeof provisioner.provision>) => {
							completion = await provisioner.provision(...args);
							currentVault = {
								...completion.response,
								verifiedProvisioning: completion.verified,
								provisioningPlan: completion.plan,
								primaryCredentialId: primary.id,
								secondaryCredentialId: secondary.id,
							};
							return completion;
						},
					};
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
				const start = async () => {
					runtime = createSubmissionRuntimeForTestsOnly(
						config,
						{ providers, relay, sendRawTransaction: send },
						() => currentVault,
					);
					backend = await createConfiguredBackend(await automatic(), config, runtime);
				};
				const request = async <T = Record<string, unknown>>(
					path: string,
					body?: unknown,
					origin = ORIGIN,
				): Promise<{ status: number; body: T }> => {
					const port = (backend!.server.address() as { port: number }).port;
					const response = await fetch(`http://127.0.0.1:${port}${path}`, {
						method: body === undefined ? "GET" : "POST",
						headers: { origin, "content-type": "application/json" },
						...(body === undefined
							? {}
							: {
									body: JSON.stringify(body, (_key, value) =>
										typeof value === "bigint" ? `${value}n` : value,
									),
								}),
					});
					return { status: response.status, body: (await response.json()) as T };
				};
				const post = async <T = Record<string, unknown>>(
					path: string,
					body: unknown,
				): Promise<T> => {
					const result = await request<T>(path, body);
					expect(result, path).toMatchObject({ status: 200 });
					return result.body;
				};
				await start();
				expect(provisionSend).not.toHaveBeenCalled();
				expect(await request("/v1/vaults/current")).toMatchObject({ status: 404 });
				expect(await request("/v1/vaults/auto-provision", {})).toMatchObject({
					status: 400,
				});
				expect(provisionSend).not.toHaveBeenCalled();
				expect(
					await request("/v1/registrations/primary/options", {}, "https://wrong.example"),
				).toMatchObject({ status: 403 });
				// Registration checks consume bad sessions and do not install credentials.
				for (const malformed of ["origin", "challenge"] as const) {
					const options = await post<{ sessionId: string; challenge: string }>(
						"/v1/registrations/primary/options",
						{},
					);
					const registration = primary.registration(
						malformed === "challenge" ? "wrong-challenge" : options.challenge,
						malformed === "origin" ? "https://wrong.example" : ORIGIN,
					);
					const body = { sessionId: options.sessionId, registration };
					expect(await request("/v1/registrations/primary/verify", body)).toMatchObject({
						status: 400,
					});
					expect(await request("/v1/registrations/primary/verify", body)).toMatchObject({
						status: 400,
						body: { error: "unknown or already used registration session" },
					});
				}
				for (const [role, authenticator] of [
					["primary", primary],
					["secondary", secondary],
				] as const) {
					const options = await post<{
						sessionId: string;
						challenge: string;
						authenticatorAttachment: string;
					}>(`/v1/registrations/${role}/options`, {});
					expect(options.authenticatorAttachment).toBe(
						role === "primary" ? "platform" : "cross-platform",
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
					expect(await request(`/v1/registrations/${role}/verify`, body)).toMatchObject({
						status: 400,
					});
				}
				expect(
					await request("/v1/vaults/auto-provision", { safe: RECIPIENT }),
				).toMatchObject({
					status: 400,
				});
				let originalPrefix: unknown[] | undefined;
				let originalReview: Record<string, string> | undefined;
				let originalAuthorizations: Record<string, string> | undefined;
				let consumedHash: Hex | undefined;
				let pendingProvisioningHash: Hex | undefined;
				if (mode === "lost-provisioning-response") {
					const initial = await request("/v1/vaults/auto-provision", {});
					expect([200, 400]).toContain(initial.status);
					expect(provisionSend).toHaveBeenCalledTimes(initial.status === 200 ? 7 : 1);
					const journal = JSON.parse(
						readFileSync(config.provisioningJournalPath, "utf8"),
					);
					expect(journal.entries).toHaveLength(initial.status === 200 ? 7 : 1);
					expect(journal.entries[0].status).toBe(
						initial.status === 200 ? "success" : "pending",
					);
					pendingProvisioningHash = journal.entries[0].transactionHash;
					expect(pendingProvisioningHash).toBe(
						keccak256(provisionSend.mock.calls[0]![0].serializedTransaction),
					);
				}
				if (mode === "confirmed-signers-with-consumed-nonce") {
					expect(await request("/v1/vaults/auto-provision", {})).toMatchObject({
						status: 400,
					});
					expect(provisionSend).toHaveBeenCalledTimes(2);
					const journal = JSON.parse(
						readFileSync(config.provisioningJournalPath, "utf8"),
					);
					expect(
						journal.entries.map((entry: { status: string }) => entry.status),
					).toEqual(["success", "success"]);
					originalPrefix = journal.entries;
					originalReview = Object.fromEntries(
						readdirSync(config.provisioningReviewDirectory).map((name) => [
							name,
							readFileSync(join(config.provisioningReviewDirectory, name), "utf8"),
						]),
					);
					originalAuthorizations = Object.fromEntries(
						readdirSync(directory)
							.filter(
								(name) =>
									name.startsWith("provisioning.json.authorizations.") &&
									name.endsWith(".json"),
							)
							.map((name) => [name, readFileSync(join(directory, name), "utf8")]),
					);
					expect(Object.keys(originalReview)).toHaveLength(1);
					// A distinct local payer operation consumes nonce 2. The browser still
					// sends only its original empty provisioning intent.
					consumedHash = await wallet.sendTransaction({
						to: payer.address,
						value: 0n,
						type: "eip1559",
						nonce: 2,
					});
					interruptQuote = false;
					requireSuccessorBeforeQuote = true;
				}
				const [vault, duplicateVault] = await Promise.all([
					post("/v1/vaults/auto-provision", {}),
					post("/v1/vaults/auto-provision", {}),
				]);
				expect(duplicateVault).toEqual(vault);
				expect(provisionSend).toHaveBeenCalledTimes(7);
				expect(core.isVerifiedPwaProvisioningResult(completion!.verified)).toBe(true);
				expect((await request("/v1/vaults/current")).body).toEqual(vault);
				expect(vault).toMatchObject({
					credentialRebind: { required: false, primary: "ready", secondary: "ready" },
				});
				const verified = completion!.verified;
				if (pendingProvisioningHash)
					expect(
						JSON.parse(readFileSync(config.provisioningJournalPath, "utf8")).entries[0],
					).toMatchObject({
						status: "success",
						transactionHash: pendingProvisioningHash,
					});
				if (originalPrefix && originalReview) {
					expect(sawConfirmationWait).toBe(true);
					expect(sawSuccessorBeforeQuote).toBe(true);
					const journal = JSON.parse(
						readFileSync(config.provisioningJournalPath, "utf8"),
					);
					expect(journal.entries.slice(0, 2)).toEqual(originalPrefix);
					expect(journal.entries.map((entry: { nonce: number }) => entry.nonce)).toEqual([
						0, 1, 3, 4, 5, 6, 7,
					]);
					for (const [name, bytes] of Object.entries(originalReview))
						expect(
							readFileSync(join(config.provisioningReviewDirectory, name), "utf8"),
						).toBe(bytes);
					for (const [name, bytes] of Object.entries(originalAuthorizations!))
						expect(readFileSync(join(directory, name), "utf8")).toBe(bytes);
					const successorBytes = readFileSync(
						`${config.provisioningJournalPath}.successors.json`,
						"utf8",
					);
					expect(successorBytes).toContain(consumedHash!);
				}
				const authorizationFiles = readdirSync(directory).filter(
					(name) =>
						name.startsWith("provisioning.json.authorizations.") &&
						name.endsWith(".json"),
				);
				const authorizationBytes = Object.fromEntries(
					authorizationFiles.map((name) => [
						name,
						readFileSync(join(directory, name), "utf8"),
					]),
				);
				expect(
					Object.values(authorizationBytes).flatMap((bytes) => JSON.parse(bytes).records),
				).toHaveLength(7);
				const provisioningBytes = readFileSync(config.provisioningJournalPath, "utf8");
				const reviewFiles = readdirSync(config.provisioningReviewDirectory);
				expect(reviewFiles).toHaveLength(
					mode === "confirmed-signers-with-consumed-nonce" ? 2 : 1,
				);
				expect(JSON.parse(provisioningBytes).entries).toHaveLength(7);
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
					body: {
						error: "submission became uncertain; reconcile the durable outer hash",
					},
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

				// The known hash survives loss of the RPC response and process state.
				await runtime!.discard?.(prepared);
				await backend!.close();
				backend = undefined;
				if (mode === "fresh") transientStartupNonceFailures = 1;
				await start();
				expect(observedStartupNonceFailures).toBe(mode === "fresh" ? 1 : 0);
				// A normal browser reload reads its saved account. It must discover the
				// reviewed current vault and rebind roles without another provisioning POST.
				expect(provisionSend).toHaveBeenCalledTimes(7);
				expect(send).toHaveBeenCalledTimes(1);
				for (const [name, bytes] of Object.entries(authorizationBytes))
					expect(readFileSync(join(directory, name), "utf8")).toBe(bytes);
				expect(await request("/v1/vaults/current")).toMatchObject({
					status: 200,
					body: {
						safe: verified.safe,
						credentialRebind: {
							required: true,
							primary: "required",
							secondary: "required",
						},
					},
				});
				expect(await request(`/v1/submissions/${prepared.id}`)).toMatchObject({
					status: 400,
				});
				expect((await request("/health")).body).toMatchObject({ writesReady: false });
				for (const [role, authenticator] of [
					["primary", primary],
					["secondary", secondary],
				] as const) {
					const rejectedOptions = await post<{ sessionId: string; challenge: string }>(
						`/v1/credentials/${role}/rebind/options`,
						{},
					);
					expect(
						await request(`/v1/credentials/${role}/rebind/verify`, {
							sessionId: rejectedOptions.sessionId,
							assertion: (role === "primary" ? secondary : primary).assertion(
								rejectedOptions.challenge,
							),
						}),
					).toMatchObject({ status: 400 });
					const options = await post<{ sessionId: string; challenge: string }>(
						`/v1/credentials/${role}/rebind/options`,
						{},
					);
					const body = {
						sessionId: options.sessionId,
						assertion: authenticator.assertion(options.challenge),
					};
					expect(await post(`/v1/credentials/${role}/rebind/verify`, body)).toMatchObject(
						{
							role,
							credentialId: authenticator.id,
						},
					);
					expect(
						await request(`/v1/credentials/${role}/rebind/verify`, body),
					).toMatchObject({
						status: 400,
					});
				}
				expect((await request("/health")).body).toMatchObject({ writesReady: true });
				expect((await request("/v1/vaults/current")).body).toMatchObject({
					credentialRebind: { required: false, primary: "ready", secondary: "ready" },
				});
				await mine();
				const recoveredStatus = await request(`/v1/submissions/${prepared.id}`);
				expect(recoveredStatus.body).toMatchObject({
					state: "confirmed",
					transactionHash: pending.transactionHash,
				});
				expect(send).toHaveBeenCalledTimes(1);
				expect(provisionSend).toHaveBeenCalledTimes(7);
				expect(readFileSync(config.provisioningJournalPath, "utf8")).toBe(
					provisioningBytes,
				);
				for (const [name, bytes] of Object.entries(authorizationBytes))
					expect(readFileSync(join(directory, name), "utf8")).toBe(bytes);
				expect(readdirSync(config.provisioningReviewDirectory)).toEqual(reviewFiles);
				expect(readdirSync(`${config.journalPath}.observations`)).toEqual([
					`${pending.transactionHash.slice(2)}.json`,
				]);

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
								body: {
									error: "primary approval is required before secondary approval",
								},
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
									body: { error: "primary approval is already present" },
								});
						}
					}
					expect(result).toMatchObject({ state: "uncertain" });
					await mine();
					expect((await request(`/v1/submissions/${prepared.id}`)).body).toMatchObject({
						state: "confirmed",
					});
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
				const rejectExecution = async (
					binding: Awaited<ReturnType<typeof queue>>,
					error?: RegExp,
				) => {
					const before = send.mock.calls.length;
					const response = await request("/v1/submissions/prepare", {
						kind: "execute-ready",
						...binding,
						idempotencyKey: `http-denied-${nextId++}`,
					});
					expect(response.status).toBe(400);
					if (error) expect(response.body.error).toMatch(error);
					expect(send).toHaveBeenCalledTimes(before);
				};
				const advance = async (seconds: number) => {
					await chain.rpc("evm_increaseTime", [seconds]);
					await chain.rpc("evm_mine");
				};
				const initialRecipient = (profile.elevatedRecipients as readonly Address[])[0]!;
				await transfer(initialRecipient, 1_000_000n, "step-up-transfer");
				await transfer(initialRecipient, 2_000_000n, "queue-transfer");
				await rejectExecution(await queue(), /cooldown/);
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
				await rejectExecution(await queue(), /expired/);
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
			} finally {
				if (runtime && prepared) await runtime.discard?.(prepared);
				await backend?.close();
				await confirmationMining;
				await chain.close();
				rmSync(directory, { recursive: true, force: true });
			}
		},
		120_000,
	);
});
