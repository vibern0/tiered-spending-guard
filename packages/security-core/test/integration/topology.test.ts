import { expect } from "chai";
import { keccak256, type Address } from "viem";
import { buildVaultPlan } from "../../src/topology/build";
import { buildVaultPlanDraft, type TopologyDeploymentEvidence } from "../fixtures/topology-draft";

const a = (n: number) => (`0x${n.toString(16).padStart(40, "0")}`) as Address;
const ev = (address: Address, version: string): any => ({ address, version, runtimeCodeHash: keccak256("0x6001"), source: "official-test-evidence", evidence: "verified" });
const zero = a(0);
const policy = { chainId: 31337, safe: a(1), primary: a(2), passkey: a(2), ecdsaSecondary: a(3), secondaries: [{ address: a(8), role: "secondary" as const, kind: "safe-contract" as const, enabled: true }, { address: a(3), role: "secondary" as const, kind: "ecdsa-extension" as const, enabled: true }], delay: a(5), periodSeconds: 86400 as const, periodAnchor: 0n, cooldownSeconds: 3600, expirationSeconds: 86400, assets: [{ token: a(10), basePerTransaction: 10n, stepUpPerTransaction: 100n, baseDailyLimit: 100n, instantDailyLimit: 1000n, baseRecipientMode: "allowlisted" as const, recipients: [a(20)] }] };
const contractOnlyPolicy = { ...policy, secondaryProfile: "contract-only" as const, ecdsaSecondary: zero, secondaries: [{ address: a(8), role: "secondary" as const, kind: "safe-contract" as const, enabled: true }] };
const deployments: TopologyDeploymentEvidence = { safeSingleton: { ...ev(a(30), "1.5.0"), supportsModuleGuards: true }, safeProxyFactory: ev(a(31), "1.5.0"), setupHelper: ev(a(4), "task4-reviewed"), guard: ev(a(6), "task7-reviewed"), delay: ev(a(5), "1.1.1"), maintenance: ev(a(7), "task1-reviewed") };

describe("one-Safe setup integration gate", () => {
  it("fails closed instead of planning from fabricated production evidence", () => {
    expect(() => buildVaultPlan({ policy, safeProxy: a(1), safeProxySaltNonce: 0n, deployments } as never)).to.throw("verified resolver");
  });
  it("keeps the deterministic draft encoder test-only and unsigned", () => {
    const plan = buildVaultPlanDraft({ policy, safeProxy: a(1), safeProxySaltNonce: 0n, deployments });
    expect(plan.safeProxyDeployment.value).to.equal(0n);
    expect(plan.safe.owners).to.deep.equal([a(2)]);
    expect(plan.setup.some((call) => call.to === deployments.guard.address && call.data.startsWith("0x7cec647c"))).to.equal(true);
    expect(plan.setup.every((call) => call.value === 0n && call.operation === 0)).to.equal(true);
    expect(plan.extraAccounts).to.deep.equal([]);
    expect(JSON.stringify(plan, (_, value) => typeof value === "bigint" ? value.toString() : value)).not.to.contain("signature");
  });
  it("keeps the contract-only draft on the sole-primary owner topology", () => {
    const plan = buildVaultPlanDraft({ policy: contractOnlyPolicy, safeProxy: a(1), safeProxySaltNonce: 0n, deployments });
    expect(plan.safe.owners).to.deep.equal([a(2)]);
    expect(plan.safe.fallbackHandler).to.equal(zero);
    expect(plan.safe.guards).to.deep.equal({ transaction: deployments.guard.address, module: deployments.guard.address });
    expect(plan.safe.modules).to.deep.equal([deployments.delay.address]);
  });
  it("fails closed when the contract-only draft omits its contract secondary", () => {
    const stalePolicy = { ...contractOnlyPolicy, secondaries: [] };
    expect(() => buildVaultPlanDraft({ policy: stalePolicy, safeProxy: a(1), safeProxySaltNonce: 0n, deployments })).to.throw("secondary");
  });
  it("fails closed when the draft policy omits the Option B Safe-contract secondary", () => {
    const stalePolicy = { ...policy, secondaries: [{ address: a(3), role: "secondary" as const, kind: "ecdsa-extension" as const, enabled: true }] };
    expect(() => buildVaultPlanDraft({ policy: stalePolicy, safeProxy: a(1), safeProxySaltNonce: 0n, deployments })).to.throw("Option B");
  });
});
