import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as profiling from "../scripts/profile-verification";
const api = profiling;
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("read-only verification profiling command", () => {
  it("accepts explicit external evidence and a bounded sample count", () => {
    const dir = mkdtempSync(join(tmpdir(), "profile-args-"));
    expect(api.parseProfileArguments(["--account-directory", dir, "--samples", "3"])).toMatchObject({ accountDirectory: realpathSync(dir), samples: 3 });
  });
  it.each([
    [], ["--account-directory", "."], ["--account-directory", "/tmp", "--samples", "0"],
    ["--account-directory", "/tmp", "--samples", "6"], ["--account-directory", "/tmp", "--samples", "1.5"],
    ["--account-directory", "/tmp", "--rpc-url", "https://secret.invalid"],
    ["--account-directory", "/tmp", "--account-directory", "/tmp"],
  ].map(args => ({ args })))("rejects unsafe or ambiguous profiling arguments %#", ({ args }) => {
    expect(() => api.parseProfileArguments(args)).toThrow(/profiling|outside|directory/);
  });
  it("refuses repository paths and output inside the source evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "profile-paths-"));
    expect(() => api.parseProfileArguments(["--account-directory", process.cwd()])).toThrow(/profiling|outside|directory/);
    expect(() => api.parseProfileArguments(["--account-directory", dir, "--output-directory", join(dir, "results")])).toThrow(/profiling|outside|directory/);
  });
  it("rejects dot-prefixed children inside protected evidence and repository paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "profile-dot-prefix-"));
    expect(() => api.parseProfileArguments(["--account-directory", dir, "--output-directory", join(dir, "..profile-output")])).toThrow();
    expect(() => api.parseProfileArguments(["--account-directory", dir, "--output-directory", join(process.cwd(), "../..", "..profile-output")])).toThrow();
  });
  it("rejects incomplete evidence before creating artifacts or making any network call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "profile-incomplete-"));
    const account = join(dir, "account"), output = join(dir, "output"); mkdirSync(account);
    const bytes = JSON.stringify({ chainId: 11155111, funder: `0x${"11".repeat(20)}`, entries: [] });
    writeFileSync(join(account, "provisioning.json"), bytes);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(api.profileVerification({ accountDirectory: account, outputDirectory: output, samples: 1 })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(output)).toBe(false);
    expect(readFileSync(join(account, "provisioning.json"), "utf8")).toBe(bytes);
  });
  it("retains redacted profiling artifacts when completed evidence cannot be recovered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "profile-failure-"));
    const account = join(dir, "account"), output = join(dir, "output"); mkdirSync(account); mkdirSync(join(account, "reviews"));
    const hash = `0x${"11".repeat(32)}`;
    const entries = ["primary-signer", "secondary-signer", "setup-helper", "guard", "delay", "maintenance", "safe-proxy"].map((id, nonce) => ({
      id: `pwa-${id}`, intentHash: hash, transactionHash: hash, nonce, reserved: "1", status: "success",
      receipt: { transactionHash: hash, blockNumber: "1", blockHash: hash, status: "success", gasUsed: "1", effectiveGasPrice: "1" },
    }));
    const bytes = JSON.stringify({ chainId: 11155111, funder: `0x${"11".repeat(20)}`, entries });
    writeFileSync(join(account, "provisioning.json"), bytes);
    vi.stubEnv("TMPDIR", account);
    const before = (await import("node:fs")).readdirSync(account).sort();
    await expect(api.profileVerification({ accountDirectory: account, samples: 1 })).rejects.toThrow();
    expect((await import("node:fs")).readdirSync(account).sort()).toEqual(before);
    vi.unstubAllEnvs();
    const originalFetch = vi.fn(async () => { throw Error("private diagnostic sentinel"); });
    vi.stubGlobal("fetch", originalFetch);
    await expect(api.profileVerification({ accountDirectory: account, outputDirectory: output, samples: 1 })).rejects.toMatchObject({ outputDirectory: join(realpathSync(dir), "output") });
    expect(globalThis.fetch).toBe(originalFetch);
    const summary = JSON.parse(readFileSync(join(output, "summary.json"), "utf8"));
    expect(summary.completed).toBe(false);
    expect(summary.phases[0]).toMatchObject({ name: "recovery", status: "error" });
    expect(JSON.parse(readFileSync(join(output, "verification.cpuprofile"), "utf8")).nodes.length).toBeGreaterThan(0);
    expect(readFileSync(join(output, "verification.trace.json"), "utf8")).not.toContain("private diagnostic sentinel");
    expect(readFileSync(join(account, "provisioning.json"), "utf8")).toBe(bytes);
  });
  it("never overwrites a previous output directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "profile-existing-"));
    const account = join(dir, "account"), output = join(dir, "output"); mkdirSync(account); mkdirSync(output);
    writeFileSync(join(output, "summary.json"), "retained");
    await expect(api.profileVerification({ accountDirectory: account, outputDirectory: output, samples: 1 })).rejects.toThrow();
    expect(readFileSync(join(output, "summary.json"), "utf8")).toBe("retained");
  });
});
