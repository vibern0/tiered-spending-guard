import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, http, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { describe, expect, it } from "vitest";
import * as namespace from "@tiered-spending-guard/security-core/pwa";
import { profileVerification } from "../scripts/profile-verification";
import type { BackendConfig } from "../src/config";
import {
	createConfiguredAutomaticPwaProvisionerForTestsOnly,
	createReadClient,
	createRelayClient,
} from "../src/provisioner";
import { verifyPasskeyRegistration } from "../src/webauthn";
import {
	installPublicRuntimes,
	localChain,
	PAYER_KEY,
	softwareAuthenticator,
} from "./automatic-http-fixtures";

const core = (namespace as unknown as { default?: typeof namespace }).default ?? namespace;

function evidenceBytes(directory: string, prefix = ""): Record<string, string> {
	return Object.fromEntries(
		readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
			const name = join(prefix, entry.name),
				path = join(directory, entry.name);
			return entry.isDirectory()
				? Object.entries(evidenceBytes(path, name))
				: [[name, readFileSync(path).toString("base64")]];
		}),
	);
}

describe("read-only verification profiling completed local deployment", () => {
	it("profiles genuine recovery, restoration and two verification samples without changing custody or source evidence", async () => {
		const directory = mkdtempSync(join(tmpdir(), "verification-profile-integration-"));
		const accountDirectory = join(directory, "account"),
			outputDirectory = join(directory, "profile");
		mkdirSync(accountDirectory);
		const originalFetch = globalThis.fetch;
		const chain = await localChain(directory);
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
			const provider = (label: string) => ({
				...createReadClient(`${chain.url}/${label}`, label),
				getBlockNumber: async () => BigInt(await chain.rpc<string>("eth_blockNumber")),
			});
			const relay = {
				...createRelayClient(chain.url),
				getBlockNumber: async () => BigInt(await chain.rpc<string>("eth_blockNumber")),
				async sendRawTransaction({
					serializedTransaction,
				}: {
					serializedTransaction: Hex;
				}) {
					const hash = await publicClient.sendRawTransaction({ serializedTransaction });
					await chain.rpc("hardhat_mine", ["0x5"]);
					return hash;
				},
				async waitForTransactionReceipt({ hash }: { hash: Hex; confirmations: number }) {
					const receipt = await publicClient.getTransactionReceipt({ hash });
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
			const config: BackendConfig = {
				id: "local",
				host: "127.0.0.1",
				port: 0,
				chainId: 11155111,
				rpId: "localhost",
				origin: "http://localhost:5173",
				rpcUrl: chain.url,
				relayPrivateKey: PAYER_KEY,
				journalPath: join(accountDirectory, "submissions.json"),
				provisioningJournalPath: join(accountDirectory, "provisioning.json"),
				provisioningReviewDirectory: join(accountDirectory, "reviews"),
			};
			const credential = async (role: "primary" | "secondary") => {
				const authenticator = softwareAuthenticator(role);
				const challenge = Buffer.from(`local-profile-${role}`).toString("base64url");
				return verifyPasskeyRegistration({
					role,
					rpId: "localhost",
					origin: config.origin,
					credentialId: authenticator.id,
					challenge,
					response: authenticator.registration(challenge),
				});
			};
			const provisioner = await createConfiguredAutomaticPwaProvisionerForTestsOnly(config, {
				providers: [provider("identity-a"), provider("identity-b")],
				relay,
			});
			const completed = await provisioner.provision({
				primary: await credential("primary"),
				secondary: await credential("secondary"),
			});
			expect(core.isVerifiedPwaProvisioningResult(completed.verified)).toBe(true);
			const source = evidenceBytes(accountDirectory);
			const journal = JSON.parse(readFileSync(config.provisioningJournalPath, "utf8"));
			expect(journal.entries).toHaveLength(7);
			expect(
				journal.entries.every(
					(entry: { status: string; receipt?: unknown }) =>
						entry.status === "success" && entry.receipt,
				),
			).toBe(true);
			expect(readdirSync(config.provisioningReviewDirectory)).toHaveLength(1);
			const nonceBefore = await chain.rpc<string>("eth_getTransactionCount", [
				payer.address,
				"latest",
			]);
			expect(BigInt(nonceBefore)).toBe(7n);

			const archiveKey = "f02af653abc17e994d8206e10cf431b9";
			const archiveUrl = `https://sepolia.infura.io/v3/${archiveKey}`;
			const evidenceConfigPath = join(directory, "private-evidence-readers.json");
			const configBytes = JSON.stringify({
				version: 1,
				profile: "infura-archive",
				rpcUrl: archiveUrl,
			});
			writeFileSync(evidenceConfigPath, configBytes, { mode: 0o600 });
			const committedProfile = core.canonicalSubmissionJson(
				core.loadCommittedPwaPhaseOneProfile(),
			);
			const evidenceCases = [
				{
					evidenceProfile: "publicnode-tenderly",
					operators: ["publicnode", "tenderly"],
					urls: core.PWA_IDENTITY_PROVIDERS,
					outputDirectory,
					evidenceConfigPath: undefined,
				},
				{
					evidenceProfile: "infura-archive",
					operators: ["infura", "tenderly"],
					urls: [archiveUrl, core.PWA_IDENTITY_PROVIDERS[1]],
					outputDirectory: join(directory, "archive-profile"),
					evidenceConfigPath,
				},
			];
			for (const evidenceCase of evidenceCases) {
				// Replace transport routing only: the command, batching, strict profiler,
				// recovery, receipt checks and onchain topology verifier all stay real.
				const requests: { provider: number; methods: string[] }[] = [];
				const routeApprovedProviders: typeof fetch = async (input, init) => {
					const endpoint = input instanceof Request ? input.url : String(input);
					const index = evidenceCase.urls.findIndex(
						(provider) => new URL(provider).href === new URL(endpoint).href,
					);
					if (index < 0)
						throw new Error("profile test forbids all unselected provider endpoints");
					if (typeof init?.body !== "string")
						throw new Error("profile test requires explicit JSON-RPC");
					const payload = JSON.parse(init.body);
					const calls = Array.isArray(payload) ? payload : [payload];
					requests.push({
						provider: index,
						methods: calls.map((call: { method: string }) => call.method),
					});
					return originalFetch(chain.url, init);
				};
				globalThis.fetch = routeApprovedProviders;
				const result = await profileVerification({
					accountDirectory,
					outputDirectory: evidenceCase.outputDirectory,
					evidenceConfigPath: evidenceCase.evidenceConfigPath,
					samples: 2,
				});
				expect(globalThis.fetch).toBe(routeApprovedProviders);
				globalThis.fetch = originalFetch;

				const summary = JSON.parse(
					readFileSync(join(result.outputDirectory, "summary.json"), "utf8"),
				);
				expect(summary.completed).toBe(true);
				expect(summary).toMatchObject({
					evidenceProfile: evidenceCase.evidenceProfile,
					operators: evidenceCase.operators,
				});
				expect(result).toMatchObject({
					evidenceProfile: evidenceCase.evidenceProfile,
					operators: evidenceCase.operators,
				});
				expect(summary.phases).toMatchObject([
					{ name: "recovery", status: "ok" },
					{ name: "restore", status: "ok" },
					{ name: "verification", sample: 1, status: "ok" },
					{ name: "verification", sample: 2, status: "ok" },
				]);
				expect(summary.phases).toHaveLength(4);
				for (const phase of summary.phases) {
					expect(phase.wallMs).toBeGreaterThan(0);
					expect(phase.cpuUserMs + phase.cpuSystemMs).toBeGreaterThan(0);
				}
				const allowed = new Set([
					"eth_chainId",
					"eth_blockNumber",
					"eth_getBlockByNumber",
					"eth_getCode",
					"eth_getStorageAt",
					"eth_call",
					"eth_getTransactionCount",
					"eth_getTransactionByHash",
					"eth_getTransactionReceipt",
					"eth_getBalance",
					"eth_estimateGas",
					"eth_maxPriorityFeePerGas",
					"eth_gasPrice",
					"eth_feeHistory",
				]);
				expect(requests.length).toBeGreaterThan(0);
				expect(
					requests
						.flatMap((request) => request.methods)
						.every((method) => allowed.has(method)),
				).toBe(true);
				for (const [index, total] of summary.http.entries()) {
					const observed = requests.filter((request) => request.provider === index);
					expect(total).toMatchObject({
						provider: `provider-${index + 1}`,
						requests: observed.length,
						rpcCalls: observed.flatMap((request) => request.methods).length,
						failures: 0,
						cancelled: 0,
					});
					expect(total.bytes).toBeGreaterThan(0);
					expect(total.wallMs).toBeGreaterThan(0);
				}
				expect(summary.rpcMethods.eth_call).toBeGreaterThan(0);
				expect(summary.rpcMethods.eth_getTransactionReceipt).toBeGreaterThanOrEqual(14);
				expect(summary.rpcMethods.eth_getTransactionByHash).toBeGreaterThanOrEqual(14);
				expect(
					Object.values(summary.rpcMethods).reduce(
						(sum: number, count) => sum + Number(count),
						0,
					),
				).toBe(requests.flatMap((request) => request.methods).length);
				const trace = JSON.parse(
					readFileSync(join(result.outputDirectory, "verification.trace.json"), "utf8"),
				);
				expect(
					trace.traceEvents.filter((event: { ph: string }) => event.ph === "X"),
				).toHaveLength(4);
				expect(
					trace.traceEvents.filter((event: { ph: string }) => event.ph === "b"),
				).toHaveLength(requests.length);
				expect(
					trace.traceEvents.filter((event: { ph: string }) => event.ph === "e"),
				).toHaveLength(requests.length);
				const cpu = JSON.parse(
					readFileSync(join(result.outputDirectory, "verification.cpuprofile"), "utf8"),
				);
				expect(cpu.nodes.length).toBeGreaterThan(0);
				expect(cpu.samples.length).toBeGreaterThan(0);
				expect(cpu.endTime).toBeGreaterThan(cpu.startTime);
				const diagnostics = JSON.stringify({ summary, trace, cpu, result });
				expect(diagnostics).not.toMatch(/0x[a-f0-9]{40}/i);
				for (const privateValue of [
					payer.address.toLowerCase(),
					completed.response.safe.toLowerCase(),
					chain.url,
					PAYER_KEY,
					archiveKey,
					archiveUrl,
					evidenceConfigPath,
					...core.PWA_IDENTITY_PROVIDERS,
				])
					expect(diagnostics.toLowerCase()).not.toContain(privateValue.toLowerCase());
				expect(evidenceBytes(accountDirectory)).toEqual(source);
				expect(
					await chain.rpc<string>("eth_getTransactionCount", [payer.address, "latest"]),
				).toBe(nonceBefore);
				expect(readFileSync(evidenceConfigPath, "utf8")).toBe(configBytes);
				expect(core.canonicalSubmissionJson(core.loadCommittedPwaPhaseOneProfile())).toBe(
					committedProfile,
				);
			}
		} finally {
			globalThis.fetch = originalFetch;
			await chain.close();
			rmSync(directory, { recursive: true, force: true });
		}
	}, 120_000);
});
