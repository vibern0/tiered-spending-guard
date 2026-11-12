import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { loadBackendConfig } from "../src/config/config";
import { createBackendServer } from "../src/compatibility/server";
import { createConfiguredBackend } from "../src/app";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import {
	createPwaProvisioningRuntime,
	type PwaProvisioningPlan,
} from "@tiered-spending-guard/security-core/pwa";
import { SubmissionJournal } from "../src/submissions/journal";

describe("backend public surface", () => {
	it("loads external .env through the real dev entrypoint before configuration validation", () => {
		const directory = mkdtempSync(join(tmpdir(), "pwa-backend-dev-env-"));
		const path = join(directory, "backend.env");
		writeFileSync(path, "BACKEND_PROFILE=local\n");
		const child = spawnSync("pnpm", ["dev"], {
			cwd: process.cwd(),
			encoding: "utf8",
			env: { PATH: process.env.PATH, NODE_ENV: "production", DOTENV_CONFIG_PATH: path },
			timeout: 10_000,
		});
		expect(child.status).toBe(1);
		expect(child.stdout).toContain("BACKEND_RELAY_PRIVATE_KEY is required");
		expect(child.stdout).not.toContain("injecting env");
	});

	it("keeps committed and automatically verified successor lineage outside browser and environment inputs", () => {
		const recoverySource = readFileSync(
			join(process.cwd(), "src/provisioning/recovery.ts"),
			"utf8",
		);
		const backendSources = [
			"src/config/config.ts",
			"src/app.ts",
			"src/provisioning/service.ts",
			"src/compatibility/server.ts",
			"src/provisioning/recovery.ts",
			"src/provisioning/successors.ts",
		]
			.map((path) => readFileSync(join(process.cwd(), path), "utf8"))
			.join("\n");
		expect(recoverySource).toContain("core.loadCommittedPwaProvisioningSuccessors()");
		expect(recoverySource).toContain("core.discoverPwaProvisioningSuccessor(facts())");
		expect(backendSources).not.toMatch(/BACKEND_[A-Z_]*SUCCESSOR/);
	});

	it("prints readable development startup failures through Pino", () => {
		const directory = mkdtempSync(join(tmpdir(), "backend-pretty-env-"));
		const path = join(directory, "backend.env");
		writeFileSync(path, "");
		const child = spawnSync(process.execPath, [require.resolve("tsx/cli"), "src/index.ts"], {
			cwd: process.cwd(),
			encoding: "utf8",
			env: { PATH: process.env.PATH, NODE_ENV: "development", DOTENV_CONFIG_PATH: path },
			timeout: 10_000,
		});
		expect(child.status).toBe(1);
		expect(child.stdout).toContain("ERROR");
		expect(child.stdout).toContain("BACKEND_PROFILE must be local or https");
		expect(child.stdout).not.toContain('"level":50');
	});

	it("imports the server factory without running CLI startup or loading private configuration", () => {
		const child = spawnSync(
			process.execPath,
			[
				require.resolve("tsx/cli"),
				"--eval",
				'import("./src/app.ts").then(() => process.stdout.write("factory imported"))',
			],
			{
				cwd: process.cwd(),
				encoding: "utf8",
				env: { PATH: process.env.PATH },
				timeout: 10_000,
			},
		);
		expect(child.status).toBe(0);
		expect(child.stdout).toBe("factory imported");
	});

	it("loads the real ESM entrypoint before validating backend configuration", () => {
		const directory = mkdtempSync(join(tmpdir(), "backend-empty-env-"));
		const path = join(directory, "backend.env");
		writeFileSync(path, "");
		const child = spawnSync(
			process.execPath,
			[require.resolve("tsx/cli"), join(process.cwd(), "src/index.ts")],
			{
				cwd: directory,
				encoding: "utf8",
				env: { PATH: process.env.PATH, NODE_ENV: "production", DOTENV_CONFIG_PATH: path },
				timeout: 10_000,
			},
		);
		expect(child.status).toBe(1);
		expect(child.stdout).toContain("BACKEND_PROFILE must be local or https");
	});

	it("exports backend names and keeps loopback Sepolia config explicit", () => {
		const config = loadBackendConfig({
			BACKEND_PROFILE: "local",
			BACKEND_RELAY_PRIVATE_KEY: `0x${"11".repeat(32)}`,
			BACKEND_RPC_URL: "https://sepolia.example.invalid",
			BACKEND_JOURNAL_PATH: "/tmp/tiered-spending-guard/backend-journal.json",
			BACKEND_PROVISIONING_JOURNAL_PATH:
				"/tmp/tiered-spending-guard/provisioning-live-journal.json",
			BACKEND_PROVISIONING_REVIEW_DIRECTORY:
				"/tmp/tiered-spending-guard/provisioning-reviews",
		});

		expect(config.host).toBe("127.0.0.1");
		expect(config.chainId).toBe(11155111);
		expect(typeof createBackendServer).toBe("function");
	});

	it("uses Fastify as the backend server foundation", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pwa-backend-fastify-"));
		const config = loadBackendConfig({
			BACKEND_PROFILE: "local",
			BACKEND_RELAY_PRIVATE_KEY: `0x${"11".repeat(32)}`,
			BACKEND_RPC_URL: "https://sepolia.example.invalid",
			BACKEND_JOURNAL_PATH: join(directory, "journal.json"),
			BACKEND_PROVISIONING_JOURNAL_PATH: join(directory, "provisioning-journal.json"),
			BACKEND_PROVISIONING_REVIEW_DIRECTORY: join(directory, "reviews"),
		});
		const backend = createBackendServer(config, {
			autoProvisionVault: async () => {
				throw new Error("not used");
			},
		});
		try {
			expect(backend.fastify.server).toBe(backend.server);
			const response = await backend.fastify.inject({ method: "GET", url: "/health" });
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({ ok: true, chainId: 11155111 });
		} finally {
			if (backend.server.listening) await backend.close();
		}
	});

	it("starts through the real entrypoint with the concrete internal provisioner", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pwa-backend-startup-"));
		const config = loadBackendConfig({
			BACKEND_PROFILE: "local",
			BACKEND_RELAY_PRIVATE_KEY: `0x${"11".repeat(32)}`,
			BACKEND_RPC_URL: "https://sepolia.example.invalid",
			BACKEND_JOURNAL_PATH: join(directory, "journal.json"),
			BACKEND_PROVISIONING_JOURNAL_PATH: join(directory, "provisioning-journal.json"),
			BACKEND_PROVISIONING_REVIEW_DIRECTORY: join(directory, "reviews"),
		});
		const backend = await createConfiguredBackend(undefined, { ...config, port: 0 });
		try {
			const address = backend.server.address();
			if (!address || typeof address === "string") throw new Error("missing port");
			const response = await fetch(`http://127.0.0.1:${address.port}/health`);
			expect(await response.json()).toMatchObject({
				provisioningReady: true,
				writesReady: false,
			});
		} finally {
			await backend.close();
		}
	});

	it("starts the HTTPS profile with automatic provisioning unavailable", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pwa-backend-https-startup-"));
		const config = loadBackendConfig({
			BACKEND_PROFILE: "https",
			BACKEND_ORIGIN: "https://vault.example",
			BACKEND_RP_ID: "vault.example",
			BACKEND_RELAY_PRIVATE_KEY: `0x${"11".repeat(32)}`,
			BACKEND_RPC_URL: "https://sepolia.example.invalid",
			BACKEND_JOURNAL_PATH: join(directory, "journal.json"),
			BACKEND_PROVISIONING_JOURNAL_PATH: join(directory, "provisioning-journal.json"),
			BACKEND_PROVISIONING_REVIEW_DIRECTORY: join(directory, "reviews"),
		});
		const backend = await createConfiguredBackend(undefined, { ...config, port: 0 });
		try {
			const address = backend.server.address();
			if (!address || typeof address === "string") throw new Error("missing port");
			const response = await fetch(`http://127.0.0.1:${address.port}/health`);
			expect(await response.json()).toMatchObject({
				provisioningReady: false,
				writesReady: false,
			});
		} finally {
			await backend.close();
		}
	});

	it("fails startup closed on a pending provisioning prefix without contacting or exposing an RPC URL", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pwa-backend-pending-startup-"));
		const privateKey = `0x${"11".repeat(32)}` as const;
		const account = privateKeyToAccount(privateKey);
		const rpcUrl = "https://secret-relay.example.invalid/private-token";
		const provisioningJournalPath = join(directory, "provisioning-journal.json");
		writeFileSync(
			provisioningJournalPath,
			`${JSON.stringify({
				chainId: 11155111,
				funder: account.address,
				entries: [
					{
						id: "pwa-primary-signer",
						intentHash: `0x${"12".repeat(32)}`,
						transactionHash: `0x${"13".repeat(32)}`,
						nonce: 1,
						reserved: "1",
						status: "pending",
					},
				],
			})}\n`,
		);
		const config = loadBackendConfig({
			BACKEND_PROFILE: "local",
			BACKEND_RELAY_PRIVATE_KEY: privateKey,
			BACKEND_RPC_URL: rpcUrl,
			BACKEND_JOURNAL_PATH: join(directory, "journal.json"),
			BACKEND_PROVISIONING_JOURNAL_PATH: provisioningJournalPath,
			BACKEND_PROVISIONING_REVIEW_DIRECTORY: join(directory, "reviews"),
		});
		let message = "";
		try {
			await createConfiguredBackend(undefined, { ...config, port: 0 });
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toMatch(/recovery validation failed closed/i);
		expect(message).not.toContain(rpcUrl);
	});

	it("keeps provisioning and submission journals independently restartable", () => {
		const directory = mkdtempSync(join(tmpdir(), "pwa-backend-journals-"));
		const provisioningPath = join(directory, "provisioning.json");
		const submissionPath = join(directory, "submissions.json");
		const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
		writeFileSync(
			provisioningPath,
			`${JSON.stringify({ chainId: 11155111, funder: account.address, entries: [] })}\n`,
		);
		const plan = { deployer: account.address } as unknown as PwaProvisioningPlan;
		const firstRuntime = createPwaProvisioningRuntime({
			plan,
			journalPath: provisioningPath,
			account,
			client: {},
		});
		firstRuntime.close();
		const provisioningBytes = readFileSync(provisioningPath, "utf8");

		const requestHash = `0x${"12".repeat(32)}`;
		new SubmissionJournal(submissionPath).prepare("request-1", requestHash);

		const restartedRuntime = createPwaProvisioningRuntime({
			plan,
			journalPath: provisioningPath,
			account,
			client: {},
		});
		restartedRuntime.close();
		expect(new SubmissionJournal(submissionPath).get("request-1")).toMatchObject({
			state: "prepared",
			requestHash,
		});
		expect(readFileSync(provisioningPath, "utf8")).toBe(provisioningBytes);
		expect(JSON.parse(readFileSync(submissionPath, "utf8"))).toEqual([
			{
				id: "request-1",
				requestHash,
				publicRequest: {},
				state: "prepared",
				approvals: { primary: false, secondary: false },
			},
		]);
	});
});
