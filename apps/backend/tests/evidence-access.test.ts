import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadEvidenceAccess } from "../src/chain/evidence-access";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const valid = {
	version: 2,
	infuraUrl: `https://sepolia.infura.io/v3/${"a".repeat(32)}`,
	alchemyUrl: "https://eth-sepolia.g.alchemy.com/v2/test-key",
};
function file(value: unknown) {
	const root = mkdtempSync(join(tmpdir(), "readers-"));
	roots.push(root);
	const path = join(root, "readers.json");
	writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
	return path;
}
it("requires explicit independent configured readers with no free-provider fallback", () => {
	expect(() => loadEvidenceAccess()).toThrow(/configuration/);
	expect(loadEvidenceAccess(file(valid))).toEqual({
		urls: [valid.infuraUrl, valid.alchemyUrl],
		operators: ["infura", "alchemy"],
	});
});
it("rejects changed chains/operators, redirects in configuration, extra fields and exposed credentials", () => {
	for (const value of [
		{ ...valid, alchemyUrl: valid.infuraUrl },
		{ ...valid, infuraUrl: valid.infuraUrl.replace("sepolia.", "mainnet.") },
		{ ...valid, alchemyUrl: valid.alchemyUrl + "?secret=token" },
		{ ...valid, extra: true },
	])
		expect(() => loadEvidenceAccess(file(value))).toThrow(
			"evidence access configuration failed closed",
		);
	const path = file(valid);
	chmodSync(path, 0o644);
	expect(() => loadEvidenceAccess(path)).toThrow("evidence access configuration failed closed");
});
