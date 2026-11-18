import { expect } from "chai";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDeploymentPlan } from "../../../scripts/plan-deployment";
import { verifyDeployment } from "../../../scripts/verify-deployment";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;

const config = {
  formatVersion: 1,
  network: "sepolia",
  chainId: 11155111,
  safe: address(1),
  guard: address(2),
  delay: address(3),
  passkey: address(4),
  safeContractSecondary: address(6),
  ecdsaSecondary: address(5),
  safeSingleton: { address: address(7), runtimeCodeHash: hash(7) },
  delayDependency: { address: address(3), runtimeCodeHash: hash(3) },
  guardRuntimeCodeHash: hash(2),
  policy: {
    periodSeconds: 86400,
    periodAnchor: "0",
    cooldownSeconds: 86400,
    expirationSeconds: 172800,
    assets: [{ token: address(8), basePerTransaction: "10", stepUpPerTransaction: "100", baseDailyLimit: "100", instantDailyLimit: "1000", recipients: [address(9)] }],
  },
  expectedCounters: [{ token: address(8), window: "0", baseSpent: "0", instantSpent: "0" }],
  expectedQueueFingerprints: [hash(10)],
  setupTransactionHashes: [hash(11)],
  setupCalls: [{ to: address(1), value: "0", data: "0x", description: "atomic setup placeholder" }],
} as const;

const observed = {
  chainId: 11155111,
  policyHash: buildDeploymentPlan(config).policyHash,
  dependencies: { safeSingleton: { address: address(7), runtimeCodeHash: hash(7) }, delay: { address: address(3), runtimeCodeHash: hash(3) } },
  safe: { address: address(1), singletonAddress: address(7), owners: [address(4)], threshold: 1, fallbackHandler: address(0), transactionGuard: address(2), moduleGuard: address(2), enabledModules: [address(3)] },
  guard: { address: address(2), runtimeCodeHash: hash(2), config: { safe: address(1), passkey: address(4), ecdsaSecondary: address(5), delay: address(3), periodSeconds: 86400, periodAnchor: "0" }, safeContractSecondary: { signer: address(6), kind: "safe-contract", enabled: true }, ecdsaSecondary: { signer: address(5), kind: "ecdsa-extension", enabled: true }, assets: [{ token: address(8), basePerTransaction: "10", stepUpPerTransaction: "100", baseDailyLimit: "100", instantDailyLimit: "1000", recipients: [address(9)] }], counters: [{ token: address(8), window: "0", baseSpent: "0", instantSpent: "0" }] },
  delay: { address: address(3), dependencyAddress: address(3), runtimeCodeHash: hash(3), owner: address(1), avatar: address(1), target: address(1), enabledUpstreamModules: [address(1)], cooldownSeconds: 86400, expirationSeconds: 172800 },
  queueFingerprints: [hash(10)],
  setupTransactionHashes: [hash(11)],
  notifications: { stepUp: true, delayedLifecycle: true },
};

describe("Sepolia deployment runbook scripts", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };

  it("verifies pinned public dependencies before any credential-specific bootstrap", () => {
    const result = spawnSync(process.execPath, [require.resolve("tsx/cli"), "scripts/verify-dependencies.ts"], { encoding: "utf8", timeout: 10000, env: {} });
    expect(result.error).to.equal(undefined);
    expect(result.stdout).to.include("verified 5 pinned public dependencies");
    expect(result.stdout).to.include("credential-specific passkey signer verification deferred");
    expect(result.status).to.equal(0);
  });

  it("keeps the redacted deployment manifest aligned with config evidence placeholders", () => {
    const publicConfig = JSON.parse(readFileSync("config/sepolia.example.json", "utf8")) as Record<string, unknown>;
    const manifest = JSON.parse(readFileSync("deployments/sepolia.example.json", "utf8")) as Record<string, unknown>;
    expect(manifest.setupTransactionHashes).to.deep.equal(publicConfig.setupTransactionHashes);
    expect(manifest.expectedQueueFingerprints).to.deep.equal(publicConfig.expectedQueueFingerprints);
    expect(manifest.expectedCounters).to.deep.equal(publicConfig.expectedCounters);
    expect(manifest.policyHash).to.equal(buildDeploymentPlan(publicConfig).policyHash);
  });

  it("builds byte-stable unsigned plans without signatures or broadcast instructions", () => {
    const first = buildDeploymentPlan(config);
    const second = buildDeploymentPlan({ ...config });
    expect(JSON.stringify(first)).to.equal(JSON.stringify(second));
    expect(first.unsigned).to.equal(true);
    expect(first.broadcast).to.equal(false);
    expect(first.setupCalls.every((call) => !("signature" in call))).to.equal(true);
  });

  it("exposes the public-only Sepolia rehearsal package command", () => {
    expect(pkg.scripts["package:sepolia-rehearsal"]).to.equal("tsx scripts/package-sepolia-rehearsal.ts");
  });

  it("fails closed when asked to emit atomic Safe creation without prerequisite evidence inputs", () => {
    expect(() => buildDeploymentPlan({ ...config, atomicSafeCreation: true })).to.throw("atomic Safe creation requires buildVaultPlan prerequisite evidence");
  });

  it("fails closed when any topology, policy, queue, or notification invariant differs", () => {
    const report = verifyDeployment(config, { ...observed, safe: { ...observed.safe, moduleGuard: address(99) } });
    expect(report.ok).to.equal(false);
    expect(report.failures.join(" ")).to.contain("module guard");
  });

  it("accepts an exact public observed snapshot", () => {
    const report = verifyDeployment({ ...config, policyHash: undefined }, { ...observed, policyHash: buildDeploymentPlan(config).policyHash });
    expect(report.ok).to.equal(true);
    expect(report.failures).to.deep.equal([]);
  });

  it("rejects an observed policy hash that does not match the recomputed policy", () => {
    const report = verifyDeployment(config, { ...observed, policyHash: hash(99) });
    expect(report.failures.join(" ")).to.contain("policy hash");
  });

  it("rejects recipient allowlist drift and dependency address drift", () => {
    expect(verifyDeployment({ ...config, policyHash: undefined }, { ...observed, policyHash: buildDeploymentPlan(config).policyHash, guard: { ...observed.guard, assets: [{ ...observed.guard.assets[0], recipients: [address(10)] }] } }).failures.join(" ")).to.contain("recipients");
    expect(verifyDeployment({ ...config, policyHash: undefined }, { ...observed, policyHash: buildDeploymentPlan(config).policyHash, safe: { ...observed.safe, singletonAddress: address(99) } }).failures.join(" ")).to.contain("singleton");
    expect(verifyDeployment({ ...config, policyHash: undefined }, { ...observed, policyHash: buildDeploymentPlan(config).policyHash, dependencies: { ...observed.dependencies, delay: { ...observed.dependencies.delay, address: address(99) } } }).failures.join(" ")).to.contain("Delay");
  });

  it("requires unique configured-token counters with bounded canonical decimal values", () => {
    const valid = { ...observed, policyHash: buildDeploymentPlan(config).policyHash };
    expect(verifyDeployment(config, { ...valid, guard: { ...valid.guard, counters: [] } }).failures.join(" ")).to.contain("counter");
    expect(verifyDeployment(config, { ...valid, guard: { ...valid.guard, counters: [{ ...valid.guard.counters[0] }, { ...valid.guard.counters[0] }] } }).failures.join(" ")).to.contain("unique");
    expect(verifyDeployment(config, { ...valid, guard: { ...valid.guard, counters: [{ ...valid.guard.counters[0], baseSpent: "101" }] } }).failures.join(" ")).to.contain("bounded");
    expect(verifyDeployment(config, { ...valid, guard: { ...valid.guard, counters: [{ ...valid.guard.counters[0], baseSpent: "00" }] } }).failures.join(" ")).to.contain("decimal");
  });

  it("rejects missing deployment evidence arrays", () => {
    const incomplete = { ...config } as Record<string, unknown>;
    delete incomplete.expectedQueueFingerprints;
    delete incomplete.setupTransactionHashes;
    expect(() => buildDeploymentPlan(incomplete)).to.throw("evidence arrays");
  });

  it("rejects missing expected counter coverage", () => {
    const incomplete = { ...config } as Record<string, unknown>;
    delete incomplete.expectedCounters;
    expect(() => buildDeploymentPlan(incomplete)).to.throw("expectedCounters");
  });

  it("rejects malformed evidence entries and invalid policy limits", () => {
    expect(() => buildDeploymentPlan({ ...config, setupTransactionHashes: ["0x1234"] })).to.throw("setupTransactionHashes[0]");
    expect(() => buildDeploymentPlan({ ...config, policy: { ...config.policy, assets: [{ ...config.policy.assets[0], baseDailyLimit: "1000", instantDailyLimit: "100" }] } })).to.throw("0 < baseDailyLimit < instantDailyLimit");
    expect(() => buildDeploymentPlan({ ...config, policy: { ...config.policy, periodSeconds: 60 } })).to.throw("periodSeconds must be 86400");
  });

  it("matches expected counter tokens after canonicalizing address casing", () => {
    const mixedCaseToken = "0x000000000000000000000000000000000000000A";
    const mixedCaseConfig = {
      ...config,
      policy: { ...config.policy, assets: [{ ...config.policy.assets[0], token: mixedCaseToken }] },
      expectedCounters: [{ ...config.expectedCounters[0], token: mixedCaseToken.toLowerCase() }],
    };

    expect(buildDeploymentPlan(mixedCaseConfig).expectedCounters[0].token).to.equal(mixedCaseToken.toLowerCase());
  });

  it("rejects unknown or missing public configuration fields", () => {
    expect(() => buildDeploymentPlan({ ...config, unexpected: true })).to.throw("config.unexpected");
    expect(() => buildDeploymentPlan({ ...config, recovery: address(6) })).to.throw(`config.${"recovery"}`);
    const incomplete = { ...config } as Record<string, unknown>;
    delete incomplete.safe;
    expect(() => buildDeploymentPlan(incomplete)).to.throw("config.safe");
    expect(() => buildDeploymentPlan({ ...config, policy: { ...config.policy, assets: [{ ...config.policy.assets[0], extra: true }] } })).to.throw("policy.assets[0].extra");
  });

  it("requires setup calls to use explicit decimal values and byte-aligned hex data", () => {
    expect(() => buildDeploymentPlan({ ...config, setupCalls: [{ ...config.setupCalls[0], value: 0 }] })).to.throw("setupCalls[0].value");
    expect(() => buildDeploymentPlan({ ...config, setupCalls: [{ ...config.setupCalls[0], value: "01" }] })).to.throw("setupCalls[0].value");
    expect(() => buildDeploymentPlan({ ...config, setupCalls: [{ ...config.setupCalls[0], data: "0x123" }] })).to.throw("setupCalls[0].data");
    expect(() => buildDeploymentPlan({ ...config, setupCalls: [{ ...config.setupCalls[0], description: undefined }] })).to.throw("setupCalls[0].description");
  });

  it("rejects unknown snapshot fields and incomplete or nullable evidence", () => {
    expect(verifyDeployment(config, { ...observed, extra: true }).failures.join(" ")).to.contain("snapshot.extra");
    expect(verifyDeployment(config, { ...observed, setupTransactionHashes: undefined }).failures.join(" ")).to.contain("setupTransactionHashes");
    expect(verifyDeployment(config, { ...observed, guard: { ...observed.guard, counters: null } }).failures.join(" ")).to.contain("counters");
    expect(verifyDeployment(config, { ...observed, notifications: { stepUp: true } }).failures.join(" ")).to.contain("delayedLifecycle");
  });

  it("returns a hashed failure report for malformed observed snapshots", () => {
    const report = verifyDeployment(config, null as unknown as Record<string, unknown>);
    expect(report.ok).to.equal(false);
    expect(report.failures.join(" ")).to.contain("observed snapshot");
    expect(report.reportHash).to.match(/^0x[0-9a-f]{64}$/);
  });
});

describe("Sepolia deployment runbook package", () => {
  const forbiddenKey = /(?:signature|signatures|privateKey|private_key|secret|seed|mnemonic|rpcUrl|rpc_url|pin|broadcastCommand|recovery)/i;
  const forbiddenValue = /(?:https?:\/\/|wss?:\/\/|PRIVATE KEY|MNEMONIC|BURNER PIN|broadcast this|cast send|safe-cli|recovery owner)/i;

  function scanPublic(value: unknown, path = "package"): void {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => scanPublic(entry, `${path}[${index}]`));
      return;
    }
    if (!value || typeof value !== "object") {
      if (typeof value === "string") expect(value, path).not.to.match(forbiddenValue);
      return;
    }
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      expect(key, path).not.to.match(forbiddenKey);
      scanPublic(entry, `${path}.${key}`);
    }
  }

  it("writes only unsigned public artifacts with the primary as sole owner", () => {
    const { buildSepoliaRehearsalPackage } = require("../../../scripts/package-sepolia-rehearsal") as { buildSepoliaRehearsalPackage: (configPath: string, outputDir: string) => { files: string[] } };
    const dir = mkdtempSync(join(tmpdir(), "sepolia-rehearsal-package-"));
    try {
      const result = buildSepoliaRehearsalPackage("config/sepolia.example.json", dir);
      expect(result.files.map((file) => file.split("/").pop()).sort()).to.deep.equal(["decoded-review.json", "expected-evidence-hashes.json", "public-manifest.json", "unsigned-plan.json"]);

      const artifacts = Object.fromEntries(result.files.map((file) => [file.split("/").pop()!, JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>]));
      Object.entries(artifacts).forEach(([name, artifact]) => scanPublic(artifact, name));
      const plan = artifacts["unsigned-plan.json"];
      const review = artifacts["decoded-review.json"];
      const manifest = artifacts["public-manifest.json"];
      const hashes = artifacts["expected-evidence-hashes.json"];
      expect(plan.unsigned).to.equal(true);
      expect(plan.broadcast).to.equal(false);
      expect(review.safeOwners).to.deep.equal([(plan.deployments as Record<string, string>).passkey]);
      expect(manifest.status).to.equal("EXAMPLE_NOT_DEPLOYED");
      expect(hashes.policyHash).to.equal(plan.policyHash);
      expect(hashes.setupTransactionHashes).to.deep.equal(plan.setupTransactionHashes);
      expect(hashes.queueFingerprints).to.deep.equal(plan.queueFingerprints);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects recovery fields before writing a rehearsal package", () => {
    const { buildSepoliaRehearsalPackage } = require("../../../scripts/package-sepolia-rehearsal") as { buildSepoliaRehearsalPackage: (configPath: string, outputDir: string) => unknown };
    const dir = mkdtempSync(join(tmpdir(), "sepolia-rehearsal-package-"));
    const configPath = join(dir, "config-with-recovery.json");
    try {
      writeFileSync(configPath, JSON.stringify({ ...config, recovery: address(6) }, null, 2), "utf8");
      expect(() => buildSepoliaRehearsalPackage(configPath, join(dir, "out"))).to.throw(/recovery/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a pre-populated output directory before writing package artifacts", () => {
    const { buildSepoliaRehearsalPackage } = require("../../../scripts/package-sepolia-rehearsal") as { buildSepoliaRehearsalPackage: (configPath: string, outputDir: string) => unknown };
    const dir = mkdtempSync(join(tmpdir(), "sepolia-rehearsal-package-"));
    try {
      writeFileSync(join(dir, "stale-signature.txt"), "RPC_URL=https://example.invalid\nBURNER PIN=123456\n", "utf8");
      expect(() => buildSepoliaRehearsalPackage("config/sepolia.example.json", dir)).to.throw(/output directory must be empty/i);
      expect(() => readFileSync(join(dir, "unsigned-plan.json"), "utf8")).to.throw();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Option B documentation", () => {
  it("keeps the active runbook, call graph, research amendment, and security-core plan on the same primary-plus-secondary boundary", () => {
    const runbook = readFileSync("docs/security/testnet-runbook.md", "utf8");
    const callGraph = readFileSync("docs/security/call-graph.md", "utf8");
    const research = readFileSync("docs/research/2026-09-16-personal-vault-research.md", "utf8");
    const securityPlan = readFileSync("docs/superpowers/plans/2026-09-16-personal-vault-security-core.md", "utf8");

    for (const [name, text] of Object.entries({ runbook, callGraph, research, securityPlan })) {
      expect(text, name).to.match(/primary passkey/i);
      expect(text, name).to.match(/one configured secondary signer|configured secondary|safe-contract secondary|ECDSA secondary/i);
      expect(text, name).not.to.match(/two-owner|two owner|\[passkey, Burner\]|passkey\/Burner/i);
      expect(text, name).not.to.match(/passkey(?: and| plus|, ) Burner(?! as a supported secondary kind)/i);
    }
    expect(runbook).to.contain("one Safe owner");
    expect(runbook).to.contain("guard-only");
    expect(runbook).to.contain("loss of the primary or all configured secondary factors");
    expect(runbook).to.contain("future delayed recovery design");
    expect(runbook).to.contain("atomic setup");
    expect(runbook).to.contain("exact Safe submission");
    expect(runbook).to.contain("Delay execution");
    expect(runbook).to.contain("cancellation/freeze");
    expect(runbook).to.contain("signer repair");
    expect(runbook).to.contain("Forbidden paths");
    expect(runbook).to.contain("Direct Burner NFC/libhalo support remains a future spike");
    expect(runbook).not.to.contain("[passkey, Burner, recovery]");
    expect(runbook).not.to.match(/Recovery may|recovery cannot withdraw/i);
    expect(securityPlan).to.contain("one configured secondary signer");
    expect(securityPlan).to.contain("Direct Burner NFC/libhalo remains out of scope");
  });
});
