import { expect } from "chai";
import { readFileSync } from "node:fs";
import { getAddress, keccak256, type Address, type Hex } from "viem";
import * as provisioning from "../../src/pwa/provisioning";
import { loadCommittedPwaPhaseOneProfile, PWA_RECIPIENT, SEPOLIA_USDC_ADDRESS } from "../../src/pwa/profile";
import { brandPwaPlanningInfrastructureForTestsOnly, OFFICIAL_DEPLOYMENT_REGISTRY } from "../../src/config/deployments";
import { brandReviewedVaultArtifactsForTestsOnly } from "../../src/topology/reviewed-artifacts";
import { passkeySignerBindingHash } from "../../src/topology/evidence";
import { policyHash } from "../../src/topology/build";
import type { VaultPolicy } from "../../src/config/policy";

const a = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const code = (n: number) => `0x60${n.toString(16).padStart(2, "0")}` as Hex;
const word = (address: Address) => `0x${address.slice(2).padStart(64, "0")}` as Hex;
const ZERO = a(0);
const GUARD = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";
const MODULE_GUARD = "0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947";

async function fixture() {
  process.env.NODE_ENV = "test";
  const dependencies = Object.fromEntries(Object.entries(OFFICIAL_DEPLOYMENT_REGISTRY[11155111]!).map(([name, value]) => [name, { ...value, evidence: "verified" }])) as any;
  const primary = a(201), secondary = a(202), deployer = a(203);
  const signer = (address: Address, n: number, x: bigint) => {
    const binding = { x, y: x + 1n, verifiers: BigInt(dependencies.passkeySignerVerifier.address) };
    return { name: "passkeySigner" as const, address, expectedRuntimeCodeHash: keccak256(code(n)), binding, bindingHash: passkeySignerBindingHash({ factory: dependencies.passkeySignerFactory.address, ...binding }), source: "test prediction" };
  };
  const infrastructure = brandPwaPlanningInfrastructureForTestsOnly({ chainId: 11155111, deployer, observedDeployerNonce: 11n, observedCurrentDeployerNonce: 11n, ...dependencies, primaryPasskeySigner: signer(primary, 35, 1n), secondaryPasskeySigner: signer(secondary, 37, 3n), dependencies });
  const artifacts = brandReviewedVaultArtifactsForTestsOnly({ safeProxyCreationCode: code(44), setupHelperCreationCode: code(40), guardCreationCode: code(41), delayCreationCode: code(42), maintenanceCreationCode: code(43), prerequisiteRuntimeCodeHashes: { setupHelper: keccak256(code(80)), guard: keccak256(code(81)), delay: keccak256(code(82)), maintenance: keccak256(code(83)) }, safeProxyRuntimeCodeHash: keccak256(code(84)) });
  const plan = await provisioning.createPwaProvisioningPlan({ profile: loadCommittedPwaPhaseOneProfile(), deployer, expectedDeployerNonce: 11n, safeProxySaltNonce: 7n, primaryCredential: { x: 1n, y: 2n }, secondaryCredential: { x: 3n, y: 4n }, infrastructure, artifacts, client: { async getBytecode() { return undefined; }, async readContract({ args }) { return args?.[0] === 1n ? primary : secondary; } } });
  const vault = provisioning.brandPwaProvisioningResultForTestsOnly({ chainId: 11155111, safe: plan.safe, guard: plan.guard, delay: plan.delay, primaryPasskey: primary, secondaryPasskey: secondary, usdc: SEPOLIA_USDC_ADDRESS, deploymentsHash: plan.deploymentsHash, policyHash: plan.policyHash, topologyReportHash: h(300), setupReceipt: { transactionHash: h(301), blockNumber: 10n } });
  const runtimes = JSON.parse(readFileSync("test/fixtures/ordinary-usdc-recycle-continuation-runtimes.public.json", "utf8")).runtimes as Record<string, { bytecode: Hex }>;
  const map = new Map<string, Hex>(Object.entries(runtimes).map(([address, record]) => [address.toLowerCase(), record.bytecode]));
  map.set(SEPOLIA_USDC_ADDRESS.toLowerCase(), JSON.parse(readFileSync("test/fixtures/sepolia-usdc-runtime.public.json", "utf8")).bytecode);
  map.set(dependencies.multiSendCallOnly.address.toLowerCase(), require("@safe-global/safe-smart-account/build/artifacts/contracts/libraries/MultiSendCallOnly.sol/MultiSendCallOnly.json").deployedBytecode);
  map.set(primary.toLowerCase(), code(35)); map.set(secondary.toLowerCase(), code(37));
  for (const transaction of plan.transactions.slice(2)) map.set(transaction.expectedCreatedAddress.toLowerCase(), code(({ "setup-helper": 80, guard: 81, delay: 82, maintenance: 83, "safe-proxy": 84 } as any)[transaction.id]));
  let currentPolicy: VaultPolicy = plan.policy;
  const values: Record<string, unknown> = {};
  let reorg = false;
  let blocks = 0;
  const client = {
    async getChainId() { return 11155111; },
    async getBlock({ blockNumber }: { blockNumber: bigint }) { blocks++; return { number: blockNumber, hash: reorg && blocks % 2 === 0 ? h(999) : h(Number(blockNumber)), timestamp: 1000n }; },
    async getTransactionCount({ blockNumber }: { blockNumber?: bigint }) { expect(blockNumber).to.equal(100n); return 30; },
    async getBytecode({ address, blockNumber }: { address: Address; blockNumber?: bigint }) { expect(blockNumber).to.equal(100n); return map.get(address.toLowerCase()); },
    async getStorageAt({ slot, blockNumber }: { slot: Hex; blockNumber?: bigint }) { expect(blockNumber).to.equal(100n); return word(slot === GUARD || slot === MODULE_GUARD ? plan.guard : ZERO); },
    async readContract({ address, functionName, args, blockNumber }: { address: Address; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }): Promise<unknown> {
      expect(blockNumber).to.equal(100n);
      if (functionName in values) return values[functionName];
      switch (functionName) {
        case "getSigner": return args?.[0] === 1n ? primary : secondary;
        case "masterCopy": return dependencies.safeSingleton.address;
        case "VERSION": return "1.5.0";
        case "getOwners": return [primary];
        case "getThreshold": return 1n;
        case "getModulesPaginated": return [[address.toLowerCase() === plan.safe.toLowerCase() ? plan.delay : plan.safe], a(1)];
        case "maintenance": case "maintenanceAddress": return plan.vaultPlan.prerequisites.maintenance.expectedCreatedAddress;
        case "safe": case "owner": case "avatar": case "target": return plan.safe;
        case "delay": return plan.delay;
        case "config": return [plan.safe, primary, ZERO, plan.delay, 86400n, 0n];
        case "safeContractSecondary": return [secondary, 0, true];
        case "ecdsaSecondary": return [ZERO, 1, false];
        case "policyHash": return policyHash(currentPolicy);
        case "getConfiguredTokens": return [SEPOLIA_USDC_ADDRESS];
        case "getPolicyRecipients": return [...currentPolicy.assets[0]!.recipients];
        case "assetPolicy": return [1_000_000n, 3_000_000n, 1_000_000n, 3_000_000n, 1];
        case "spendState": return [0n, 0n, 0n];
        case "txCooldown": return 120n;
        case "txExpiration": return 600n;
      }
      throw new Error(`unexpected ${functionName}`);
    },
  };
  return { plan, vault, client, values, map, addRecipient() { currentPolicy = { ...currentPolicy, assets: [{ ...currentPolicy.assets[0]!, recipients: [PWA_RECIPIENT, a(99)] }] }; }, originalRecipients() { currentPolicy = plan.policy; }, reorg() { reorg = true; } };
}

describe("current PWA submission proof", () => {
  it("re-verifies exact evidence at one canonical block and brands a recipient-only policy refresh", async () => {
    const f = await fixture();
    const verify = (provisioning as any).verifyPwaSubmissionState;
    expect(verify, "production submission proof factory").to.be.a("function");
    const initial = await verify({ ...f, blockNumber: 100n });
    expect(provisioning.isVerifiedPwaProvisioningResult(initial.vault)).to.equal(true);
    expect(initial.topologyReport.ok).to.equal(true);
    expect(initial.topologyReport.failures).to.deep.equal([]);
    expect(initial.topologyReport.checked).to.include("owners");
    f.addRecipient();
    const refreshed = await verify({ ...f, blockNumber: 100n });
    expect(refreshed.policy.assets[0].recipients).to.deep.equal([PWA_RECIPIENT, a(99)]);
    expect(refreshed.vault.policyHash).not.to.equal(initial.vault.policyHash);
    expect(refreshed.topologyReportHash).to.equal(initial.topologyReportHash);
    expect(refreshed.topologyReport).to.deep.equal(initial.topologyReport);
    expect(refreshed.vault.deploymentsHash).to.equal(f.plan.deploymentsHash);
    expect(f.plan.policyHash).to.equal(f.vault.policyHash);
    f.originalRecipients();
    const historical = await verify({ ...f, vault: refreshed.vault, blockNumber: 100n });
    expect(historical.vault.policyHash).to.equal(initial.vault.policyHash);
  });

  it("rejects cloned authority, altered plan, legacy mode, topology drift, wrong chain and reorg", async () => {
    const f = await fixture();
    const verify = (provisioning as any).verifyPwaSubmissionState;
    expect(verify).to.be.a("function");
    await expect(verify({ ...f, vault: { ...f.vault }, blockNumber: 100n })).to.be.rejectedWith(/verified|brand|evidence/i);
    await expect(verify({ ...f, plan: { ...f.plan, policyHash: h(999) }, blockNumber: 100n })).to.be.rejectedWith(/plan|commitment/i);
    f.values.assetPolicy = [1_000_000n, 3_000_000n, 1_000_000n, 3_000_000n, 0];
    await expect(verify({ ...f, blockNumber: 100n })).to.be.rejectedWith(/policy|topology/i);
    delete f.values.assetPolicy;
    const oldUsdc = f.map.get(SEPOLIA_USDC_ADDRESS.toLowerCase());
    f.map.set(SEPOLIA_USDC_ADDRESS.toLowerCase(), code(99));
    await expect(verify({ ...f, blockNumber: 100n })).to.be.rejectedWith(/USDC|token|runtime/i);
    if (oldUsdc) f.map.set(SEPOLIA_USDC_ADDRESS.toLowerCase(), oldUsdc); else f.map.delete(SEPOLIA_USDC_ADDRESS.toLowerCase());
    f.values.policyHash = h(999);
    await expect(verify({ ...f, blockNumber: 100n })).to.be.rejectedWith(/policy|topology/i);
    delete f.values.policyHash;
    f.values.getPolicyRecipients = [];
    await expect(verify({ ...f, blockNumber: 100n })).to.be.rejectedWith(/recipient/i);
    delete f.values.getPolicyRecipients;
    f.values.getSigner = a(201);
    await expect(verify({ ...f, blockNumber: 100n })).to.be.rejectedWith(/signer|binding/i);
    delete f.values.getSigner;
    f.values.spendState = [86_400n, 0n, 0n];
    await expect(verify({ ...f, blockNumber: 100n })).to.be.rejectedWith(/counter|window/i);
    delete f.values.spendState;
    f.values.getOwners = [a(99)];
    await expect(verify({ ...f, blockNumber: 100n })).to.be.rejectedWith(/topology/i);
    delete f.values.getOwners;
    await expect(verify({ ...f, client: { ...f.client, async getChainId() { return 1; } }, blockNumber: 100n })).to.be.rejectedWith(/chain/i);
    f.reorg();
    await expect(verify({ ...f, blockNumber: 100n })).to.be.rejectedWith(/reorg|block/i);
  });
});
