import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadBackendEnvironment } from "../src/environment";

const directories: string[] = [];
function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "backend-dotenv-"));
	directories.push(directory);
	return directory;
}
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("backend environment loading", () => {
	it("loads an external dotenv file and preserves shell values", () => {
		const path = join(fixture(), "backend.env");
		writeFileSync(path, 'BACKEND_PROFILE=local\nBACKEND_ORIGIN="http://localhost:5173"\n');
		const env = { DOTENV_CONFIG_PATH: path, BACKEND_PROFILE: "https" } as NodeJS.ProcessEnv;
		loadBackendEnvironment(env);
		expect(env.BACKEND_PROFILE).toBe("https");
		expect(env.BACKEND_ORIGIN).toBe("http://localhost:5173");
	});

	it("loads the selected default symlink without requiring an explicit path setting", () => {
		const directory = fixture();
		const external = join(directory, "backend.env");
		writeFileSync(external, "BACKEND_PROFILE=local\n");
		const link = join(directory, ".env");
		symlinkSync(external, link);
		const env: NodeJS.ProcessEnv = {};
		loadBackendEnvironment(env, link);
		expect(env.BACKEND_PROFILE).toBe("local");
	});

	it("allows a missing default file when configuration comes from the shell", () => {
		const env: NodeJS.ProcessEnv = { BACKEND_PROFILE: "local" };
		loadBackendEnvironment(env, join(fixture(), "missing.env"));
		expect(env.BACKEND_PROFILE).toBe("local");
	});

	it("rejects an explicitly configured missing file without exposing its path", () => {
		const path = join(fixture(), "private-provider-token.env");
		expect(() => loadBackendEnvironment({ DOTENV_CONFIG_PATH: path })).toThrow(
			"backend environment file could not be loaded",
		);
		try {
			loadBackendEnvironment({ DOTENV_CONFIG_PATH: path });
		} catch (error) {
			expect(String(error)).not.toContain(path);
		}
	});

	it("rejects repository-local files and relative explicit paths", () => {
		expect(() =>
			loadBackendEnvironment({ DOTENV_CONFIG_PATH: process.cwd() + "/package.json" }),
		).toThrow("backend environment file could not be loaded");
		expect(() => loadBackendEnvironment({ DOTENV_CONFIG_PATH: ".env" })).toThrow(
			"backend environment file could not be loaded",
		);
	});

	it("rejects a directory and a broken symlink rather than silently ignoring them", () => {
		const directory = fixture();
		mkdirSync(join(directory, "directory.env"));
		expect(() =>
			loadBackendEnvironment({ DOTENV_CONFIG_PATH: join(directory, "directory.env") }),
		).toThrow("backend environment file could not be loaded");
		const link = join(directory, ".env");
		symlinkSync(join(directory, "missing.env"), link);
		expect(() => loadBackendEnvironment({}, link)).toThrow(
			"backend environment file could not be loaded",
		);
	});
});
