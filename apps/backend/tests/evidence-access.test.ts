import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as access from "../src/evidence-access";
const api = access;
const key = "a".repeat(32);
const valid = {
  version: 1,
  profile: "infura-archive",
  rpcUrl: `https://sepolia.infura.io/v3/${key}`,
};
function file(value: unknown, mode = 0o600) {
  const dir = mkdtempSync(join(tmpdir(), "evidence-access-")),
    path = join(dir, "readers.json");
  writeFileSync(path, JSON.stringify(value), { mode });
  chmodSync(path, mode);
  return path;
}
describe("reviewed archive evidence access", () => {
  it("retains the committed public pair unless explicitly configured", () => {
    expect(api.loadEvidenceAccess()).toEqual({
      profile: "publicnode-tenderly",
      urls: ["https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.gateway.tenderly.co"],
      operators: ["publicnode", "tenderly"],
    });
  });
  it("selects two independently administered readers with truthful source labels", () => {
    expect(api.loadEvidenceAccess(file(valid))).toEqual({
      profile: "infura-archive",
      urls: [valid.rpcUrl, "https://sepolia.gateway.tenderly.co"],
      operators: ["infura", "tenderly"],
    });
  });
  it.each([
    { ...valid, version: 2 },
    { ...valid, profile: "arbitrary" },
    { ...valid, extra: true },
    [valid],
    { ...valid, rpcUrl: "https://sepolia.gateway.tenderly.co" },
    { ...valid, rpcUrl: `http://sepolia.infura.io/v3/${key}` },
    { ...valid, rpcUrl: `https://sepolia.infura.io.attacker.invalid/v3/${key}` },
    { ...valid, rpcUrl: `https://user:password@sepolia.infura.io/v3/${key}` },
    { ...valid, rpcUrl: `https://sepolia.infura.io:443/v3/${key}` },
    { ...valid, rpcUrl: `https://sepolia.infura.io/v3/${key}?secret=one` },
    { ...valid, rpcUrl: `https://sepolia.infura.io/v3/${key}#fragment` },
    { ...valid, rpcUrl: "https://sepolia.infura.io/v3/invalid" },
  ])("rejects unreviewed or ambiguous access config %#", (value) => {
    expect(() => api.loadEvidenceAccess(file(value))).toThrow(
      "evidence access configuration failed closed",
    );
  });
  it("rejects missing, insecure or repository-local credential files without echoing credentials", () => {
    for (const path of [
      "relative.json",
      join(process.cwd(), "private-reader.json"),
      file(valid, 0o644),
      "/tmp/does-not-exist-vault-reader.json",
    ]) {
      expect(() => api.loadEvidenceAccess(path)).toThrow(
        "evidence access configuration failed closed",
      );
      try {
        api.loadEvidenceAccess(path);
      } catch (error) {
        expect(String(error)).not.toContain(key);
      }
    }
  });
});
