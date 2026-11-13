import { AccountStore } from "../src/accounts/store";
import { passkeyApprovalFingerprint } from "../src/auth/webauthn";
import { createHash, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createPublicClient,
	createWalletClient,
	http,
	keccak256,
	parseAbi,
	stringToHex,
	toHex,
	type Address,
	type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { describe, expect, it, vi } from "vitest";
import * as namespace from "@tiered-spending-guard/security-core/pwa";
import type { PwaProvisioningResult } from "@tiered-spending-guard/security-core/pwa";
import {
	createSubmissionReadClient,
	createSubmissionRuntimeForTestsOnly,
} from "../src/submissions/runtime";
import { createBackendHandlers } from "../src/vaults/service";
import { type BackendIntent, type BackendVaultRecord } from "../src/vaults/types";
import { SubmissionJournal } from "../src/submissions/journal";
import { PwaSubmissionService } from "../src/submissions/service";
import type { StoredCredential } from "../src/auth/webauthn";
import { encodeP256CosePublicKey } from "./webauthn-fixtures";
import type { BackendConfig } from "../src/config/config";

const core = (namespace as unknown as { default?: typeof namespace }).default ?? namespace;
const coreDirectory = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../../packages/security-core",
);
const requireCore = createRequire(join(coreDirectory, "package.json"));
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const TOKEN = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Address;
const RECIPIENT = "0x0000000000000000000000000000000000000a11" as Address;
// Public, ephemeral test payer; never used outside the temporary local chain.
const PAYER_KEY = `0x${"11".repeat(32)}` as Hex;
const TOKEN_ABI = parseAbi([
	"function mint(address,uint256)",
	"function balanceOf(address) view returns (uint256)",
]);

async function unusedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

async function localChain(directory: string) {
	const port = await unusedPort();
	const configPath = join(directory, "hardhat.config.cjs");
	writeFileSync(
		configPath,
		'module.exports = { networks: { hardhat: { chainId: 11155111, accounts: [], hardfork: "cancun", initialDate: "2026-11-05T12:00:00.000Z", initialBaseFeePerGas: 100000000 } } };\n',
	);
	const child = spawn(
		process.execPath,
		[
			requireCore.resolve("hardhat/internal/cli/bootstrap"),
			"node",
			"--config",
			configPath,
			"--hostname",
			"127.0.0.1",
			"--port",
			String(port),
		],
		{
			cwd: coreDirectory,
			env: { PATH: process.env.PATH, HARDHAT_DISABLE_TELEMETRY_PROMPT: "true" },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let errors = "";
	child.stdout?.resume();
	child.stderr?.on("data", (chunk) => {
		errors = `${errors}${chunk}`.slice(-3000);
	});
	const url = `http://127.0.0.1:${port}`;
	let serial = 0;
	const rpc = async <T>(method: string, params: unknown[] = []): Promise<T> => {
		const response = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: ++serial, method, params }),
		});
		const result = (await response.json()) as { result: T; error?: { message: string } };
		if (result.error) throw new Error(`local ${method}: ${result.error.message}`);
		return result.result;
	};
	for (let attempt = 0; ; attempt++) {
		try {
			if ((await rpc<string>("eth_chainId")) === "0xaa36a7") break;
		} catch {
			/* Wait only for the fresh local test node. */
		}
		if (child.exitCode !== null || attempt > 200) {
			child.kill();
			throw new Error(`local EVM startup failed: ${errors}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return {
		url,
		rpc,
		async close() {
			child.kill("SIGTERM");
			if (child.exitCode === null) await once(child, "exit");
		},
	};
}

async function installPublicRuntimes(rpc: <T>(method: string, params?: unknown[]) => Promise<T>) {
	const fixture = JSON.parse(
		readFileSync(
			join(
				coreDirectory,
				"test/fixtures/ordinary-usdc-recycle-continuation-runtimes.public.json",
			),
			"utf8",
		),
	) as { runtimes: Record<Address, { runtimeHash: Hex; bytecode: Hex }> };
	for (const [address, record] of Object.entries(fixture.runtimes)) {
		expect(keccak256(record.bytecode)).toBe(record.runtimeHash);
		await rpc("hardhat_setCode", [address, record.bytecode]);
	}
	// The public capture predates this transitive singleton fixture. Both fixed
	// Sepolia providers returned this exact release-artifact hash on 2026-11-05.
	const signerSingleton = requireCore(
		"@safe-global/safe-passkey/build/artifacts/contracts/SafeWebAuthnSignerSingleton.sol/SafeWebAuthnSignerSingleton.json",
	) as { deployedBytecode: Hex };
	expect(keccak256(signerSingleton.deployedBytecode)).toBe(
		"0x180871920494795a32a7516c60dcc9c4237f435c86681a5d2dd79ea36897d080",
	);
	await rpc("hardhat_setCode", [
		"0x270d7e4a57e6322f336261f3eae2bade72e68d72",
		signerSingleton.deployedBytecode,
	]);
	const multiSend = requireCore(
		"@safe-global/safe-smart-account/build/artifacts/contracts/libraries/MultiSendCallOnly.sol/MultiSendCallOnly.json",
	) as { deployedBytecode: Hex };
	const registry = requireCore(
		"@safe-global/safe-deployments/dist/assets/v1.5.0/multi_send_call_only.json",
	) as { deployments: { canonical: { address: Address; codeHash: Hex } } };
	expect(keccak256(multiSend.deployedBytecode)).toBe(registry.deployments.canonical.codeHash);
	await rpc("hardhat_setCode", [
		registry.deployments.canonical.address,
		multiSend.deployedBytecode,
	]);
	const token = JSON.parse(
		readFileSync(join(coreDirectory, "test/fixtures/sepolia-usdc-runtime.public.json"), "utf8"),
	) as { address: Address; runtimeCodeHash: Hex; bytecode: Hex };
	expect(token.address.toLowerCase()).toBe(TOKEN.toLowerCase());
	expect(keccak256(token.bytecode)).toBe(token.runtimeCodeHash);
	await rpc("hardhat_setCode", [TOKEN, token.bytecode]);

	// Token behavior is a local test double behind the genuine hash-pinned proxy.
	// The custody, guard, signer, Delay, transaction and observer paths stay real.
	const source =
		'pragma solidity ^0.8.24; contract LocalToken { mapping(address=>uint256) public balanceOf; string public constant name="USDC"; string public constant symbol="USDC"; uint8 public constant decimals=6; event Transfer(address indexed from,address indexed to,uint256 value); function mint(address to,uint256 amount) external {balanceOf[to]+=amount; emit Transfer(address(0),to,amount);} function transfer(address to,uint256 amount) external returns(bool){require(balanceOf[msg.sender]>=amount);balanceOf[msg.sender]-=amount;balanceOf[to]+=amount;emit Transfer(msg.sender,to,amount);return true;} }';
	const solc = requireCore("solc") as { compile(input: string): string };
	const compiled = JSON.parse(
		solc.compile(
			JSON.stringify({
				language: "Solidity",
				sources: { "LocalToken.sol": { content: source } },
				settings: {
					evmVersion: "cancun",
					optimizer: { enabled: true, runs: 200 },
					outputSelection: { "*": { "*": ["evm.deployedBytecode.object"] } },
				},
			}),
		),
	) as {
		errors?: { severity: string; formattedMessage: string }[];
		contracts: Record<
			string,
			Record<string, { evm: { deployedBytecode: { object: string } } }>
		>;
	};
	expect(compiled.errors?.filter((error) => error.severity === "error") ?? []).toEqual([]);
	const implementation = "0x000000000000000000000000000000000000e001" as Address;
	await rpc("hardhat_setCode", [
		implementation,
		`0x${compiled.contracts["LocalToken.sol"]!["LocalToken"]!.evm.deployedBytecode.object}`,
	]);
	await rpc("hardhat_setStorageAt", [
		TOKEN,
		keccak256(stringToHex("org.zeppelinos.proxy.implementation")),
		toHex(BigInt(implementation), { size: 32 }),
	]);
	await rpc("hardhat_setStorageAt", [
		TOKEN,
		keccak256(stringToHex("org.zeppelinos.proxy.admin")),
		toHex(0xdeadn, { size: 32 }),
	]);
}

function softwareCredential(role: "primary" | "secondary") {
	const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const jwk = createPublicKey(pair.privateKey).export({ format: "jwk" });
	const coordinates = {
		x: BigInt(toHex(Buffer.from(jwk.x!, "base64url"))),
		y: BigInt(toHex(Buffer.from(jwk.y!, "base64url"))),
	};
	const id = Buffer.from(`${role}-local-credential`).toString("base64url");
	const stored: StoredCredential & { credentialId: string } = {
		role,
		id,
		credentialId: id,
		publicKey: encodeP256CosePublicKey(coordinates),
		counter: 0,
		...coordinates,
	};
	let counter = 0;
	const assertion = (digest: Hex): AuthenticationResponseJSON => {
		const clientData = Buffer.from(
			JSON.stringify({
				type: "webauthn.get",
				challenge: Buffer.from(digest.slice(2), "hex").toString("base64url"),
				origin: "http://localhost:5173",
				crossOrigin: false,
			}),
		);
		const counterBytes = Buffer.alloc(4);
		counterBytes.writeUInt32BE(++counter);
		const authenticatorData = Buffer.concat([
			createHash("sha256").update("localhost").digest(),
			Buffer.from([0x05]),
			counterBytes,
		]);
		const message = Buffer.concat([
			authenticatorData,
			createHash("sha256").update(clientData).digest(),
		]);
		const signature = sign("sha256", message, { key: pair.privateKey, dsaEncoding: "der" });
		return {
			id,
			rawId: id,
			type: "public-key",
			authenticatorAttachment: role === "primary" ? "platform" : "cross-platform",
			response: {
				authenticatorData: authenticatorData.toString("base64url"),
				clientDataJSON: clientData.toString("base64url"),
				signature: signature.toString("base64url"),
			},
			clientExtensionResults: {},
		};
	};
	return { stored, coordinates, assertion };
}

describe("concrete PWA submission runtime on a real local Sepolia EVM", () => {
	it("provisions the current vault, executes every tier and recipient lifecycle with real passkeys, and reconciles durable hashes after restart", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pwa-runtime-integration-"));
		const chain = await localChain(directory);
		let runtime: ReturnType<typeof createSubmissionRuntimeForTestsOnly> | undefined;
		let prepared: Awaited<ReturnType<NonNullable<typeof runtime>["prepare"]>> | undefined;
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
			let topologyCollections = 0;
			const provider = (source: string) => {
				const base = createSubmissionReadClient(`${chain.url}/${source}`, source);
				return {
					...base,
					readContract: async (args: Parameters<typeof base.readContract>[0]) => {
						if (source === "identity-a" && args.functionName === "VERSION")
							topologyCollections++;
						return base.readContract(args);
					},
					getBlockNumber: async () => BigInt(await chain.rpc<string>("eth_blockNumber")),
					estimateGas: async (args: Parameters<typeof publicClient.estimateGas>[0]) => {
						try {
							return await publicClient.estimateGas(args);
						} catch (error) {
							throw new Error(
								`local signed estimate failed: ${(error as { details?: string }).details ?? "unknown"}`,
							);
						}
					},
				};
			};
			const providers = [provider("identity-a"), provider("identity-b")] as const;
			const relay = provider("relay");
			const primary = softwareCredential("primary"),
				secondary = softwareCredential("secondary");
			const plan = await core.resolvePwaProvisioningPlan({
				profile: core.loadCommittedPwaPhaseOneProfile(),
				deployer: payer.address,
				expectedDeployerNonce: 0n,
				safeProxySaltNonce:
					core.loadCommittedPwaProvisioningAutomationPolicy().safeProxySaltNonce,
				primaryCredential: primary.coordinates,
				secondaryCredential: secondary.coordinates,
				client: relay,
			});
			const config: BackendConfig = {
				id: "local",
				host: "127.0.0.1",
				port: 0,
				chainId: 11155111,
				rpId: "localhost",
				origin: "http://localhost:5173",
				rpcUrl: chain.url,
				relayPrivateKey: PAYER_KEY,
				dataRoot: directory,
				accountDatabasePath: join(directory, "accounts.sqlite"),
				journalPath: join(directory, "submissions.json"),
				provisioningJournalPath: join(directory, "provisioning.json"),
				provisioningReviewDirectory: join(directory, "reviews"),
			};
			const provisioningClient = {
				...relay,
				estimateFeesPerGas: async () => {
					const fees = await publicClient.estimateFeesPerGas({ type: "eip1559" });
					return {
						maxFeePerGas: fees.maxFeePerGas!,
						maxPriorityFeePerGas: fees.maxPriorityFeePerGas!,
					};
				},
				sendRawTransaction: async ({
					serializedTransaction,
				}: {
					serializedTransaction: Hex;
				}) => {
					const hash = await publicClient.sendRawTransaction({ serializedTransaction });
					await mine();
					return hash;
				},
				waitForTransactionReceipt: publicClient.waitForTransactionReceipt,
			};
			const provisioning = core.createPwaProvisioningRuntime({
				plan,
				journalPath: config.provisioningJournalPath,
				account: payer,
				client: provisioningClient,
				authorize: async (transaction) => {
					const gas = await publicClient.estimateGas({
						account: payer.address,
						...(transaction.to.toLowerCase() === ZERO ? {} : { to: transaction.to }),
						value: transaction.value,
						data: transaction.data,
					});
					return {
						...transaction,
						gasLimit: gas * 2n,
						maxFeePerGas: 3_000_000_000n,
						maxPriorityFeePerGas: 2_000_000_000n,
					};
				},
			});
			let verified: PwaProvisioningResult;
			try {
				verified = await core.executePwaProvisioning(plan, provisioning.context);
			} catch (error) {
				if (
					error instanceof Error &&
					/submission topology failed: policy hash, asset policy/.test(error.message)
				) {
					const actual = await publicClient.readContract({
						address: plan.guard,
						abi: parseAbi([
							"function assetPolicy(address) view returns (uint256,uint256,uint256,uint256,uint8)",
						]),
						functionName: "assetPolicy",
						args: [TOKEN],
					});
					expect(actual).toEqual([1_000_000n, 3_000_000n, 1_000_000n, 3_000_000n, 0]);
					const rows = JSON.parse(
						readFileSync(config.provisioningJournalPath, "utf8"),
					) as {
						entries: { status: string }[];
					};
					expect(rows.entries).toHaveLength(7);
					expect(rows.entries.every((entry) => entry.status === "success")).toBe(true);
				}
				throw error;
			} finally {
				provisioning.close();
			}
			expect(core.isVerifiedPwaProvisioningResult(verified)).toBe(true);
			const provisioningRows = JSON.parse(
				readFileSync(config.provisioningJournalPath, "utf8"),
			) as {
				entries: { status: string }[];
			};
			expect(provisioningRows.entries).toHaveLength(7);
			expect(provisioningRows.entries.every((entry) => entry.status === "success")).toBe(
				true,
			);
			const mintHash = await wallet.writeContract({
				address: TOKEN,
				abi: TOKEN_ABI,
				functionName: "mint",
				args: [verified.safe, 20_000_000n],
			});
			await publicClient.waitForTransactionReceipt({ hash: mintHash });
			// Late-bound: runtime callbacks capture handlers before their construction.
			// eslint-disable-next-line prefer-const
			let handlers: ReturnType<typeof createBackendHandlers>;
			const send = vi.fn(async (raw: Hex) => {
				expect(
					new SubmissionJournal(config.journalPath).findByOuterHash(keccak256(raw))
						?.state,
				).toBe("submitting");
				return publicClient.sendRawTransaction({ serializedTransaction: raw });
			});
			runtime = createSubmissionRuntimeForTestsOnly(
				config,
				{ providers, relay, sendRawTransaction: send },
				() => handlers.vaultRecord(),
			);
			let submissionFailure: string | undefined;
			const service = new PwaSubmissionService({
				journal: new SubmissionJournal(config.journalPath),
				revalidate: runtime.revalidate,
				deriveOuterHash: runtime.deriveOuterHash,
				broadcast: async (...args) => {
					try {
						return await runtime!.broadcast(...args);
					} catch (error) {
						submissionFailure =
							error instanceof Error ? error.message : "broadcast failed";
						throw error;
					}
				},
				reconcile: async (...args) => {
					try {
						return await runtime!.reconcile(...args);
					} catch (error) {
						submissionFailure =
							error instanceof Error ? error.message : "reconcile failed";
						throw error;
					}
				},
				discard: runtime.discard,
				verifyApproval: async (role, request, assertion) => {
					const approval = await handlers.verifyApproval(request.safeTxHash!, {
						role,
						assertion,
					});
					const signer =
						role === "primary" ? verified.primaryPasskey : verified.secondaryPasskey;
					expect(
						await publicClient.readContract({
							address: signer,
							abi: parseAbi([
								"function isValidSignature(bytes32,bytes) view returns (bytes4)",
							]),
							functionName: "isValidSignature",
							args: [request.safeTxHash!, approval.payload],
						}),
					).toBe("0x1626ba7e");
					return { role, payload: approval.payload };
				},
			});
			const response = {
				...verified,
				evidence: {
					setupTransactionHash: verified.setupReceipt.transactionHash,
					verificationReportHash: verified.topologyReportHash,
					deploymentsHash: verified.deploymentsHash,
					policyHash: verified.policyHash,
					blockNumber: String(verified.setupReceipt.blockNumber),
				},
			};
			const credentialStore = new AccountStore({
				...config,
				dataRoot: join(directory, "metadata"),
				accountDatabasePath: join(directory, "metadata", "accounts.sqlite"),
			});
			const account = credentialStore.createAccount();
			credentialStore.storeCredential(account.id, primary.stored);
			credentialStore.storeCredential(account.id, secondary.stored);
			handlers = createBackendHandlers({
				credentialStore: {
					get: (role) =>
						credentialStore.credentials(account.id).find((c) => c.role === role),
					updateCounter: (c, next, approval, hash) =>
						credentialStore.consumeApproval(
							account.id,
							c.id,
							c.counter,
							next,
							passkeyApprovalFingerprint(approval, hash),
						),
				},
				config,
				usdc: TOKEN,
				provisioner: { provision: async () => ({ response, verified, plan }) },
				prepareTransfer: async ({ vault, request }) =>
					service.prepare(await runtime!.prepare({ vault, request })),
				submit: async ({ id, body }) => service.submit(id, body as never),
				submission: async ({ id }) => service.status(id),
			});
			await handlers.autoProvisionVault({});
			topologyCollections = 0;
			prepared = await handlers.prepareTransfer({
				kind: "transfer",
				recipient: RECIPIENT,
				amount: "500000",
				idempotencyKey: "real-base-1",
			});
			expect(prepared.kind).toBe("base-transfer");
			const pending = (await handlers
				.submit(prepared.id, {
					role: "primary",
					assertion: primary.assertion(prepared.safeTxHash!),
				})
				.catch((error) => {
					throw new Error(
						submissionFailure ??
							(error instanceof Error ? error.message : "submit failed"),
					);
				})) as { state: string; transactionHash: Hex };
			expect(pending.state).toBe("uncertain");
			expect(topologyCollections).toBe(6); // All boundaries retained; adjacent consumers reuse their just-validated proof.
			expect(send).toHaveBeenCalledTimes(1);
			expect(
				await publicClient.readContract({
					address: TOKEN,
					abi: TOKEN_ABI,
					functionName: "balanceOf",
					args: [verified.safe],
				}),
			).toBe(19_500_000n);
			expect(
				await publicClient.readContract({
					address: TOKEN,
					abi: TOKEN_ABI,
					functionName: "balanceOf",
					args: [RECIPIENT],
				}),
			).toBe(500_000n);
			expect(readFileSync(config.journalPath, "utf8")).not.toMatch(
				/assertion|signature|privateKey|authenticatorData|clientDataJSON/,
			);

			await runtime.discard?.(prepared); // Simulate process teardown; no pending envelope survives.
			const beforeReconciliation = createSubmissionRuntimeForTestsOnly(
				config,
				{ providers, relay, sendRawTransaction: send },
				() => handlers.vaultRecord(),
			);
			const blocked = await beforeReconciliation.prepare({
				vault: handlers.vaultRecord()!,
				request: {
					kind: "transfer",
					recipient: RECIPIENT,
					amount: "1",
					idempotencyKey: "blocked-before-reconciliation",
				},
			});
			await expect(beforeReconciliation.deriveOuterHash(blocked, [])).rejects.toThrow(
				/durable submission is unresolved/,
			);
			expect(send).toHaveBeenCalledTimes(1);
			await mine();
			const restartProvisioning = core.createPwaProvisioningRuntime({
				plan,
				journalPath: config.provisioningJournalPath,
				account: payer,
				client: provisioningClient,
			});
			try {
				verified = await core.executePwaProvisioning(plan, restartProvisioning.context);
			} finally {
				restartProvisioning.close();
			}
			const restartedVault = {
				...handlers.vaultRecord()!,
				verifiedProvisioning: verified,
			} satisfies BackendVaultRecord;
			const restarted = createSubmissionRuntimeForTestsOnly(
				config,
				{ providers, relay, sendRawTransaction: send },
				() => restartedVault,
			);
			const noSign = vi.fn(async () => {
				throw new Error("restart must reconcile without signing");
			});
			const restartedService = new PwaSubmissionService({
				journal: new SubmissionJournal(config.journalPath),
				revalidate: noSign,
				deriveOuterHash: noSign,
				broadcast: noSign,
				verifyApproval: noSign,
				reconcile: restarted.reconcile,
			});
			expect(await restartedService.status(prepared.id)).toMatchObject({
				state: "confirmed",
				transactionHash: pending.transactionHash,
				approvals: { primary: true, secondary: false },
			});
			expect(noSign).not.toHaveBeenCalled();
			expect(send).toHaveBeenCalledTimes(1);
			const observations = readdirSync(`${config.journalPath}.observations`);
			expect(observations).toEqual([`${pending.transactionHash.slice(2)}.json`]);
			const observed = JSON.parse(
				readFileSync(join(`${config.journalPath}.observations`, observations[0]!), "utf8"),
			) as { confirmations: number; kind: string; transactionHash: Hex };
			expect(observed).toMatchObject({
				confirmations: 6,
				kind: "base-transfer",
				transactionHash: pending.transactionHash,
			});
			const observedBytes = readFileSync(
				join(`${config.journalPath}.observations`, observations[0]!),
				"utf8",
			);
			expect(await restartedService.status(prepared.id)).toMatchObject({
				state: "confirmed",
				transactionHash: pending.transactionHash,
			});
			expect(
				readFileSync(join(`${config.journalPath}.observations`, observations[0]!), "utf8"),
			).toBe(observedBytes);

			// A just-verified snapshot is reusable only by its adjacent consumer, not
			// across signing and broadcast. Change real guard code after outer signing.
			const driftConfig = {
				...config,
				dataRoot: directory,
				accountDatabasePath: join(directory, "accounts.sqlite"),
				journalPath: join(directory, "drift-submissions.json"),
			};
			const drift = createSubmissionRuntimeForTestsOnly(
				driftConfig,
				{ providers, relay, sendRawTransaction: send },
				() => restartedVault,
			);
			const driftPrepared = await drift.prepare({
				vault: restartedVault,
				request: {
					kind: "transfer",
					recipient: RECIPIENT,
					amount: "1",
					idempotencyKey: "code-drift-after-signing",
				},
			});
			const approval = await handlers.verifyApproval(driftPrepared.safeTxHash!, {
				role: "primary",
				assertion: primary.assertion(driftPrepared.safeTxHash!),
			});
			const approvalSet = [{ role: "primary" as const, payload: approval.payload }];
			const driftHash = await drift.deriveOuterHash(driftPrepared, approvalSet);
			const driftJournal = new SubmissionJournal(driftConfig.journalPath);
			driftJournal.prepare(
				driftPrepared.id,
				driftPrepared.requestHash,
				driftPrepared.publicRequest,
			);
			driftJournal.markSubmitting(driftPrepared.id, driftHash);
			const guardCode = await publicClient.getCode({ address: verified.guard });
			try {
				await chain.rpc("hardhat_setCode", [verified.guard, "0x6000"]);
				await chain.rpc("evm_mine");
				await expect(
					drift.broadcast(driftPrepared, approvalSet, driftHash),
				).rejects.toThrow(/guard|topology|runtime|Sepolia RPC request failed/);
				expect(send).toHaveBeenCalledTimes(1);
				expect(driftJournal.get(driftPrepared.id)?.state).toBe("submitting");
			} finally {
				await chain.rpc("hardhat_setCode", [verified.guard, guardCode]);
				await chain.rpc("evm_mine");
				await drift.discard?.(driftPrepared);
			}

			runtime = restarted;
			const continuousService = new PwaSubmissionService({
				journal: new SubmissionJournal(config.journalPath),
				revalidate: runtime.revalidate,
				deriveOuterHash: runtime.deriveOuterHash,
				broadcast: async (...args) => {
					try {
						return await runtime!.broadcast(...args);
					} catch (error) {
						submissionFailure =
							error instanceof Error ? error.message : "broadcast failed";
						throw error;
					}
				},
				reconcile: runtime.reconcile,
				discard: runtime.discard,
				verifyApproval: async (role, request, assertion) => {
					const approval = await handlers.verifyApproval(request.safeTxHash!, {
						role,
						assertion,
					});
					return { role, payload: approval.payload };
				},
			});
			let nextId = 1;
			const act = async (request: BackendIntent, expectedKind: string) => {
				submissionFailure = undefined;
				prepared = continuousService.prepare(
					await runtime!.prepare({ vault: restartedVault, request }),
				);
				expect(prepared.kind).toBe(expectedKind);
				let result: unknown;
				if (prepared.requiredApprovals.length === 0)
					result = await continuousService
						.submit(prepared.id, { role: "none" })
						.catch((error) => {
							throw new Error(
								submissionFailure ??
									(error instanceof Error ? error.message : "submit failed"),
							);
						});
				else
					for (const role of prepared.requiredApprovals)
						result = await continuousService.submit(prepared.id, {
							role,
							assertion: (role === "primary" ? primary : secondary).assertion(
								prepared.safeTxHash!,
							),
						});
				expect(result).toMatchObject({ state: "uncertain" });
				await mine();
				expect(await continuousService.status(prepared.id)).toMatchObject({
					state: "confirmed",
				});
			};
			const transfer = (recipient: Address, amount: string, kind: string) =>
				act(
					{
						kind: "transfer",
						recipient,
						amount,
						idempotencyKey: `real-flow-${nextId++}`,
					},
					kind,
				);
			const queue = async () => {
				const nonce = await publicClient.readContract({
					address: verified.delay,
					abi: parseAbi(["function txNonce() view returns (uint256)"]),
					functionName: "txNonce",
				});
				const fingerprint = await publicClient.readContract({
					address: verified.delay,
					abi: parseAbi(["function getTxHash(uint256) view returns (bytes32)"]),
					functionName: "getTxHash",
					args: [nonce],
				});
				return { queueNonce: nonce.toString(), queueFingerprint: fingerprint };
			};
			const lifecycle = async (kind: "cancel-queued" | "execute-ready" | "skip-expired") =>
				act({ kind, ...(await queue()), idempotencyKey: `real-flow-${nextId++}` }, kind);
			const advance = async (seconds: number) => {
				await chain.rpc("evm_increaseTime", [seconds]);
				await chain.rpc("evm_mine");
			};
			const initialRecipient = (
				core.loadCommittedPwaPhaseOneProfile().elevatedRecipients as readonly Address[]
			)[0]!;
			await transfer(initialRecipient, "1000000", "step-up-transfer");
			await transfer(initialRecipient, "2000000", "queue-transfer");
			const earlyBinding = await queue();
			const beforeEarlyAttempt = send.mock.calls.length;
			await expect(
				runtime.prepare({
					vault: restartedVault,
					request: {
						kind: "execute-ready",
						...earlyBinding,
						idempotencyKey: "too-early",
					},
				}),
			).rejects.toThrow(/cooldown/);
			expect(send).toHaveBeenCalledTimes(beforeEarlyAttempt);
			await advance(121);
			await lifecycle("execute-ready");
			await act(
				{
					kind: "add-recipient",
					recipient: RECIPIENT,
					idempotencyKey: `real-flow-${nextId++}`,
				},
				"add-recipient",
			);
			await advance(121);
			await lifecycle("execute-ready");
			await transfer(RECIPIENT, "750000", "step-up-transfer");
			await transfer(RECIPIENT, "2000000", "queue-transfer");
			const cancelledBinding = await queue();
			await lifecycle("cancel-queued");
			const beforeCancelledAttempt = send.mock.calls.length;
			await expect(
				runtime.prepare({
					vault: restartedVault,
					request: {
						kind: "execute-ready",
						...cancelledBinding,
						idempotencyKey: "cancelled-execution",
					},
				}),
			).rejects.toThrow();
			expect(send).toHaveBeenCalledTimes(beforeCancelledAttempt);
			await transfer(RECIPIENT, "2000000", "queue-transfer");
			await advance(721);
			const expiredBinding = await queue();
			const beforeExpiredAttempt = send.mock.calls.length;
			await expect(
				runtime.prepare({
					vault: restartedVault,
					request: {
						kind: "execute-ready",
						...expiredBinding,
						idempotencyKey: "expired-execution",
					},
				}),
			).rejects.toThrow(/expired/);
			expect(send).toHaveBeenCalledTimes(beforeExpiredAttempt);
			await lifecycle("skip-expired");
			await transfer(RECIPIENT, "2000000", "queue-transfer");
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
			credentialStore.close();
		} finally {
			if (runtime && prepared) await runtime.discard?.(prepared);
			await chain.close();
			rmSync(directory, { recursive: true, force: true });
		}
	}, 120_000);
});
