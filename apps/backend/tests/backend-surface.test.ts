import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
		expect(child.stdout).toContain("BACKEND_RELAY_PRIVATE_KEY is required");
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
		expect(child.stdout).toContain("BACKEND_RELAY_PRIVATE_KEY is required");
	});
});
