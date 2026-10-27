import { expect } from "chai";
import { encodeFunctionData, getAddress, keccak256, parseAbi, type Address, type Hex } from "viem";
import {
  brandOrdinaryScenarioTopologyForTestsOnly,
  collectOrdinaryScenarioReview,
  renderOrdinaryScenarioReview,
  type OrdinaryBaselineProof,
  type OrdinaryScenarioReviewClient,
  type OrdinaryScenarioReviewInput,
} from "../../../scripts/live/ordinary-scenario-review";
import { brandVaultDeploymentPlanForTestsOnly, planHash, policyHash, type VaultDeploymentPlan } from "../../../src/topology/build";

process.env.NODE_ENV = "test";

const address = (value: string) => getAddress(value);
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const ZERO = address("0x0000000000000000000000000000000000000000");
const FUNDER = address("0xad4d5cd2ec5becdb9608bad4c36f0dbe8b2492bc");
const SAFE = address("0xd751a1479f49d63DC61E0081B0b4d8c60623D9a6");
const PRIMARY = address("0x6F9c2f4f8526A17f38c9409a8cBF605b34Fa146c");
const CONTRACT_SECONDARY = address("0xF94b0fbDCa0eF0Bf7Bd142aF832Bab17108C0D42");
const ECDSA_SECONDARY = address("0xe789E36f46E2445d807D726E4a064c8048e19980");
const GUARD = address("0x91392B9aE9daBa21a1fba3d92fae9fE47a4B48cA");
const DELAY = address("0xB8E143098CcCb9935228022173c2c987DF5FD53a");
const MAINTENANCE = address("0x3D20c6c361bdb1970827c9450beeC0e3cD78E654");
const USDC = address("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238");
const REPAIR = address("0xCc3C12cFB2508E5E9E4EB9b21CC44A9dEEFf0908");
const CODE = "0x6001" as Hex;

function reviewedPlan(): VaultDeploymentPlan {
  const policy = {
    chainId: 11155111,
    safe: SAFE,
    primary: PRIMARY,
    passkey: PRIMARY,
    ecdsaSecondary: ECDSA_SECONDARY,
    secondaries: [
      { address: CONTRACT_SECONDARY, role: "secondary" as const, kind: "safe-contract" as const, enabled: true },
      { address: ECDSA_SECONDARY, role: "secondary" as const, kind: "ecdsa-extension" as const, enabled: true },
    ],
    delay: DELAY,
    periodSeconds: 86400 as const,
    periodAnchor: 0n,
    cooldownSeconds: 120,
    expirationSeconds: 600,
    assets: [
      { token: ZERO, basePerTransaction: 10_000_000_000_000n, stepUpPerTransaction: 30_000_000_000_000n, baseDailyLimit: 10_000_000_000_000n, instantDailyLimit: 30_000_000_000_000n, recipients: [FUNDER] },
      { token: USDC, basePerTransaction: 10_000_000n, stepUpPerTransaction: 30_000_000n, baseDailyLimit: 10_000_000n, instantDailyLimit: 30_000_000n, recipients: [FUNDER] },
    ],
  };
  const tx = (nonce: bigint, created: Address) => ({ description: "reviewed", nonce, to: ZERO, value: 0n, operation: 0 as const, data: CODE, expectedCreatedAddress: created, creationCodeHash: keccak256(CODE), expectedRuntimeCodeHash: keccak256(CODE) });
  return brandVaultDeploymentPlanForTestsOnly({
    unsigned: true,
    broadcast: false,
    chainId: 11155111,
    deployer: FUNDER,
    startingNonce: 673n,
    safeProxySaltNonce: 1n,
    prerequisites: { setupHelper: tx(673n, address("0xc3Ba1567fb0E5961E9E4fD72F88B2AC3318360A3")), guard: tx(674n, GUARD), delay: tx(675n, DELAY), maintenance: tx(676n, MAINTENANCE) },
    safeProxyDeployment: { ...tx(677n, SAFE), to: address("0x14f2982d601c9458f93bd70b218933a6f8165e7b") },
    safeInitializer: "0x1234",
    setupHelperCalldata: "0x5678",
    review: {
      owners: [PRIMARY], threshold: 1, fallbackHandler: ZERO, paymentToken: ZERO, payment: 0n, paymentReceiver: ZERO,
      transactionGuard: GUARD, moduleGuard: GUARD, modules: [DELAY], safeContractSecondary: CONTRACT_SECONDARY, ecdsaSecondary: ECDSA_SECONDARY,
      assets: policy.assets, delay: { owner: SAFE, avatar: SAFE, target: SAFE, upstreamModules: [SAFE], cooldownSeconds: 120, expirationSeconds: 600 },
      periodAnchor: 0n, policyHash: policyHash(policy),
      creationCodeHashes: { setupHelper: h(11), guard: h(12), delay: h(13), maintenance: h(14) },
      runtimeCodeHashes: { setupHelper: h(21), guard: h(22), delay: h(23), maintenance: h(24) },
    },
  });
}

function baseline(plan: VaultDeploymentPlan): OrdinaryBaselineProof {
  const costs = [10n, 20n, 30n, 40n, 50n];
  const ids = ["vault-setup-helper", "vault-guard", "vault-delay", "vault-maintenance", "vault-safe"] as const;
  return {
    schemaVersion: 1,
    result: "PASS_TWO_RPC",
    chainId: "11155111",
    planHash: planHash(plan),
    safe: SAFE,
    transactions: ids.map((id, index) => ({ id, transactionHash: h(index + 1), blockNumber: String(100 + index), blockHash: h(100 + index), gasUsed: costs[index]!.toString(), effectiveGasPrice: "1", actualCostWei: costs[index]!.toString() })),
    prerequisiteActualCostWei: "100",
    safeCreationActualCostWei: "50",
    combinedActualCostWei: "150",
  };
}

function client(overrides: Partial<OrdinaryScenarioReviewClient> = {}): OrdinaryScenarioReviewClient {
  const balances = new Map<string, bigint>([
    [`native:${FUNDER.toLowerCase()}`, 1_000_000_000_000_000n],
    [`native:${SAFE.toLowerCase()}`, 0n],
    [`token:${FUNDER.toLowerCase()}`, 0n],
    [`token:${SAFE.toLowerCase()}`, 0n],
    [`token:${FUNDER.toLowerCase()}:recipient`, 0n],
  ]);
  return {
    chainId: async () => 11155111,
    block: async () => ({ number: 1000n, hash: h(1000), timestamp: 2_000_000_000n }),
    blockHash: async () => h(1000),
    safeNonce: async () => 0n,
    funderNonce: async () => 742n,
    delayNonce: async () => 0n,
    spendState: async () => ({ window: 0n, baseSpent: 0n, instantSpent: 0n }),
    nativeBalance: async (who) => balances.get(`native:${who.toLowerCase()}`) ?? 0n,
    tokenBalance: async (_token, who) => balances.get(`token:${who.toLowerCase()}`) ?? 0n,
    tokenMetadata: async () => ({ name: "USD Coin", symbol: "USDC", decimals: 6 }),
    runtimeCode: async (who) => who.toLowerCase() === ECDSA_SECONDARY.toLowerCase() ? "0x" : CODE,
    passkeySignerAddress: async () => REPAIR,
    canonicalReceipt: async (hash) => {
      const entry = baseline(reviewedPlan()).transactions.find((candidate) => candidate.transactionHash === hash);
      if (!entry) return undefined;
      return { transactionHash: entry.transactionHash, blockNumber: BigInt(entry.blockNumber), blockHash: entry.blockHash, status: "success" as const, gasUsed: BigInt(entry.gasUsed), effectiveGasPrice: BigInt(entry.effectiveGasPrice) };
    },
    ...overrides,
  };
}

function input(plan = reviewedPlan()): OrdinaryScenarioReviewInput {
  return {
    plan,
    topology: brandOrdinaryScenarioTopologyForTestsOnly(plan, true),
    baseline: baseline(plan),
    signers: {
      primary: { address: PRIMARY, kind: "safe-contract", available: true, source: "public passkey binding" },
      safeContractSecondary: { address: CONTRACT_SECONDARY, kind: "safe-contract", available: true, source: "public passkey binding" },
      ecdsaSecondary: { address: ECDSA_SECONDARY, kind: "ecdsa-extension", available: true, source: "approved non-WalletConnect public capability descriptor" },
    },
    proposedCaps: { fundingGasLimit: 100_000n, safeExecutionGasLimit: 500_000n, publicDelayGasLimit: 300_000n, maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1_000_000n },
  };
}

describe("ordinary scenario review collector", () => {
  it("rejects unbranded plans, missing topology proof, and failed topology", async () => {
    const value = input();
    await expect(collectOrdinaryScenarioReview({ ...value, plan: { ...value.plan } as never }, client())).to.be.rejectedWith("reviewed deployment plan");
    await expect(collectOrdinaryScenarioReview({ ...value, topology: { ...value.topology } as never }, client())).to.be.rejectedWith("verified post-setup topology");
    await expect(collectOrdinaryScenarioReview({ ...value, topology: brandOrdinaryScenarioTopologyForTestsOnly(value.plan, false) }, client())).to.be.rejectedWith("topology did not pass");
  });

  it("rejects mutated five-receipt proof and non-fresh nonce/counter state", async () => {
    const value = input();
    await expect(collectOrdinaryScenarioReview({ ...value, baseline: { ...value.baseline, combinedActualCostWei: "151" } }, client())).to.be.rejectedWith("baseline accounting");
    await expect(collectOrdinaryScenarioReview(value, client({ safeNonce: async () => 1n }))).to.be.rejectedWith("fresh Safe nonce");
    await expect(collectOrdinaryScenarioReview(value, client({ delayNonce: async () => 1n }))).to.be.rejectedWith("fresh Delay nonce");
    await expect(collectOrdinaryScenarioReview(value, client({ spendState: async () => ({ window: 0n, baseSpent: 1n, instantSpent: 1n }) }))).to.be.rejectedWith("zero spend counters");
  });

  it("reports explicit asset, observer, and repair blockers without claiming readiness", async () => {
    const result = await collectOrdinaryScenarioReview(input(), client());
    expect(result.report.status).to.equal("BLOCKED");
    expect(result.report.blockers.map((blocker) => blocker.code)).to.deep.equal(["MISSING_USDC_INVENTORY", "MISSING_INDEPENDENT_OBSERVER", "MISSING_REPAIR_DESCRIPTOR"]);
    expect(result.report.requiredInventory).to.deep.include({ nativeWei: "30000000000001", usdcUnits: "31000000" });
    expect(result.report.signed).to.equal(false);
    expect(result.report.broadcast).to.equal(false);
    expect(result.report.liveEstimated).to.equal(false);
  });

  it("recycles the controlled recipient's 20 USDC into 31 cumulative funding units without resetting state", async () => {
    const funded = client({ tokenBalance: async (_token, who) => who.toLowerCase() === FUNDER.toLowerCase() ? 20_000_000n : 0n });
    const result = await collectOrdinaryScenarioReview(input(), funded);
    expect(result.report.blockers.map((blocker) => blocker.code)).to.not.include("MISSING_USDC_INVENTORY");
    expect(result.report.requiredInventory).to.deep.include({ initialExternalUsdcUnits: "20000000", grossUsdcFundingUnits: "31000000" });
    const first = result.report.actions.find((action) => action.id === "usdc-funding")!;
    const recycleTen = result.report.actions.find((action) => action.id === "usdc-recycle-topup-step-up")!;
    const recycleOne = result.report.actions.find((action) => action.id === "usdc-recycle-topup-delayed")!;
    const contract = result.report.actions.find((action) => action.id === "usdc-step-up-contract")!;
    const ecdsa = result.report.actions.find((action) => action.id === "usdc-step-up-ecdsa")!;
    const queue = result.report.actions.find((action) => action.id === "usdc-queue-cancel")!;
    expect(first.publicTransaction?.value).to.equal("0");
    expect(first.expectedTransition).to.include("20000000");
    expect(recycleTen.dependsOn).to.deep.equal(["usdc-step-up-contract"]);
    expect(recycleTen.expectedTransition).to.include("10000000");
    expect(ecdsa.dependsOn).to.deep.equal(["usdc-recycle-topup-step-up"]);
    expect(recycleOne.dependsOn).to.deep.equal(["usdc-step-up-ecdsa"]);
    expect(recycleOne.expectedTransition).to.include("1000000");
    expect(queue.dependsOn).to.deep.equal(["usdc-recycle-topup-delayed"]);
    expect(contract.safeTransaction?.safeNonce).to.equal("8");
    expect(ecdsa.safeTransaction?.safeNonce).to.equal("9");
    expect(queue.safeTransaction?.safeNonce).to.equal("10");
    expect(result.report.phaseAccounting.grossUsdcFundingUnits).to.equal("31000000");
    const expected = (id: string) => result.report.actions.find((action) => action.id === id)!.expectedState as any;
    expect(expected("usdc-funding").principalBalances).to.deep.include({ usdcFunderBefore: "20000000", usdcFunderAfter: "0", usdcSafeBefore: "0", usdcSafeAfter: "20000000" });
    expect(expected("usdc-base-x").principalBalances).to.deep.include({ usdcFunderBefore: "0", usdcFunderAfter: "10000000", usdcSafeBefore: "20000000", usdcSafeAfter: "10000000" });
    expect(expected("usdc-step-up-contract").principalBalances).to.deep.include({ usdcFunderBefore: "10000000", usdcFunderAfter: "20000000", usdcSafeBefore: "10000000", usdcSafeAfter: "0" });
    expect(expected("usdc-recycle-topup-step-up").principalBalances).to.deep.include({ usdcFunderBefore: "20000000", usdcFunderAfter: "10000000", usdcSafeBefore: "0", usdcSafeAfter: "10000000" });
    expect(expected("usdc-step-up-ecdsa").principalBalances).to.deep.include({ usdcFunderBefore: "10000000", usdcFunderAfter: "20000000", usdcSafeBefore: "10000000", usdcSafeAfter: "0" });
    expect(expected("usdc-recycle-topup-delayed").principalBalances).to.deep.include({ usdcFunderBefore: "20000000", usdcFunderAfter: "19000000", usdcSafeBefore: "0", usdcSafeAfter: "1000000" });
    expect(expected("usdc-queue-ready-execute").principalBalances).to.deep.include({ usdcFunderBefore: "19000000", usdcFunderAfter: "20000000", usdcSafeBefore: "1000000", usdcSafeAfter: "0" });
    expect(expected("usdc-recycle-topup-step-up").counters.before).to.deep.equal(expected("usdc-recycle-topup-step-up").counters.after);
    expect(expected("usdc-recycle-topup-delayed").counters.before).to.deep.equal(expected("usdc-recycle-topup-delayed").counters.after);
    for (const action of result.report.actions) for (const [key, amount] of Object.entries((action.expectedState as any).principalBalances)) expect(BigInt(amount as string) < 0n, `${action.id}.${key}`).to.equal(false);
  });

  it("makes every advertised funder, Safe, and Delay nonce topologically reachable", async () => {
    const funded = client({ tokenBalance: async (_token, who) => who.toLowerCase() === FUNDER.toLowerCase() ? 20_000_000n : 0n });
    const actions = (await collectOrdinaryScenarioReview(input(), funded)).report.actions;
    const byId = new Map(actions.map((action) => [action.id, action]));
    const ancestors = (id: string, seen = new Set<string>()): Set<string> => {
      for (const dependency of byId.get(id)?.dependsOn ?? []) if (!seen.has(dependency)) { seen.add(dependency); ancestors(dependency, seen); }
      return seen;
    };
    const successfulSafe = actions.filter((action) => action.expectedOutcome === "success" && action.safeTransaction?.safeNonce !== undefined);
    for (let index = 1; index < successfulSafe.length; index++) expect(ancestors(successfulSafe[index]!.id).has(successfulSafe[index - 1]!.id), successfulSafe[index]!.id).to.equal(true);
    const funder = actions.filter((action) => action.publicTransaction?.funderNonce !== undefined);
    for (let index = 1; index < funder.length; index++) {
      expect(BigInt(funder[index]!.publicTransaction!.funderNonce as string)).to.equal(BigInt(funder[index - 1]!.publicTransaction!.funderNonce as string) + 1n);
      expect(ancestors(funder[index]!.id).has(funder[index - 1]!.id), funder[index]!.id).to.equal(true);
    }
    expect(ancestors("usdc-base-x").has("native-queue-ready-execute")).to.equal(true);
    expect((actions.find((action) => action.id === "usdc-base-x")!.expectedState as any).nonces.before.delay).to.equal("3");
  });

  it("fails closed when the pinned block or mutable state drifts during collection", async () => {
    let reads = 0;
    await expect(collectOrdinaryScenarioReview(input(), client({ safeNonce: async () => reads++ === 0 ? 0n : 1n }))).to.be.rejectedWith("state drift");
    await expect(collectOrdinaryScenarioReview(input(), client({ blockHash: async () => h(999) }))).to.be.rejectedWith("canonical block drift");
  });

  it("binds exact Safe hashes and distinct Safe/Delay nonce spaces for the 30+1 matrix", async () => {
    const result = await collectOrdinaryScenarioReview(input(), client());
    const nativeBase = result.report.actions.find((action) => action.id === "native-base-x")!;
    const nativeContract = result.report.actions.find((action) => action.id === "native-step-up-contract")!;
    const nativeEcdsa = result.report.actions.find((action) => action.id === "native-step-up-ecdsa")!;
    const nativeQueue = result.report.actions.find((action) => action.id === "native-queue-cancel")!;
    const usdcReady = result.report.actions.find((action) => action.id === "usdc-queue-ready-execute")!;
    expect(nativeBase.safeTransaction?.safeNonce).to.equal("0");
    expect(nativeContract.safeTransaction?.safeNonce).to.equal("1");
    expect(nativeEcdsa.safeTransaction?.safeNonce).to.equal("2");
    expect(nativeBase.safeTransaction?.safeTxHash).to.match(/^0x[0-9a-f]{64}$/);
    expect(nativeQueue.queue?.queueNonce).to.equal("0");
    expect(nativeQueue.queue?.queueFingerprint).to.match(/^0x[0-9a-f]{64}$/);
    expect(nativeQueue.queue?.monitoringFingerprint).to.not.equal(nativeQueue.queue?.queueFingerprint);
    expect(usdcReady.queue?.queueNonce).to.equal("5");
    expect(usdcReady.expectedTransition).to.include("31");
  });

  it("is byte-stable, counts gross native value, and never calls sign, submit, or estimate", async () => {
    let forbiddenCalls = 0;
    const readOnly = Object.assign(client(), { sign: async () => { forbiddenCalls += 1; }, submit: async () => { forbiddenCalls += 1; }, estimateGas: async () => { forbiddenCalls += 1; } }) as OrdinaryScenarioReviewClient;
    const first = await collectOrdinaryScenarioReview(input(), readOnly);
    const second = await collectOrdinaryScenarioReview(input(), readOnly);
    expect(renderOrdinaryScenarioReview(first.report)).to.equal(renderOrdinaryScenarioReview(second.report));
    expect(first.packageHash).to.equal(second.packageHash);
    expect(first.report.phaseAccounting.nativeFundingValueWei).to.equal("30000000000001");
    expect(first.report.phaseAccounting.nativeSafeTransferPrincipalWei).to.equal("30000000000001");
    expect(first.report.phaseAccounting.proposedCapsOnly).to.equal(true);
    expect(forbiddenCalls).to.equal(0);
  });

  it("rejects forbidden secret, credential, RPC, and signature fields", async () => {
    const value = input();
    for (const field of ["privateKey", "credentialPath", "rpcUrl", "signature"] as const) {
      await expect(collectOrdinaryScenarioReview({ ...value, signers: { ...value.signers, [field]: "forbidden" } } as never, client())).to.be.rejectedWith("forbidden public input field");
    }
  });

  it("rejects raw observer endpoints and requires a probe bound hash-only identifier", async () => {
    const value = input();
    await expect(collectOrdinaryScenarioReview({ ...value, observer: { kind: "https-webhook", publicId: "https://private.example/hook", independentFromProposer: true, endpointHash: h(8), probeEvidenceHash: h(9), actualActivityAlerts: "NOT_RUN" } } as never, client())).to.be.rejectedWith("observer descriptor");
    await expect(collectOrdinaryScenarioReview({ ...value, observer: { kind: "https-webhook", publicId: `temporary-test-receiver:${h(7)}`, endpointHash: h(8), independentFromProposer: true, probeEvidenceHash: h(9), actualActivityAlerts: "NOT_RUN" } } as never, client())).to.be.rejectedWith("observer descriptor");
  });

  it("binds the public contract-secondary repair domain but remains blocked until the ephemeral proof is reviewed", async () => {
    const value = input();
    const repair = {
      formatVersion: 1 as const,
      scope: "ordinary-baseline-proposed-contract-secondary-repair" as const,
      chainId: 11155111 as const,
      factory: address("0xF7488fFbe67327ac9f37D5F722d83Fc900852Fbf"),
      address: REPAIR,
      x: "10342510752483659319190807637330965811978365685423845568184481734592673940696",
      y: "83007955684183101275699917860538633816962061613045139387258186696967867907135",
      verifiers: "1111636484949241205398856388087597953580887526884",
      observedRuntime: "0x" as const,
      deployed: false as const,
      signed: false as const,
      broadcast: false as const,
    };
    const observer = { kind: "https-webhook" as const, publicId: `temporary-test-receiver:${h(8)}`, endpointHash: h(8), independentFromProposer: true as const, probeEvidenceHash: h(9), actualActivityAlerts: "NOT_RUN" as const };
    const funded = client({
      tokenBalance: async (_token, who) => who.toLowerCase() === FUNDER.toLowerCase() ? 20_000_000n : 0n,
      runtimeCode: async (who) => who.toLowerCase() === ECDSA_SECONDARY.toLowerCase() || who.toLowerCase() === repair.address.toLowerCase() ? "0x" : CODE,
    });
    const result = await collectOrdinaryScenarioReview({ ...value, repair, observer }, funded);
    expect(result.report.status).to.equal("BLOCKED");
    expect(result.report.blockers.map((blocker) => blocker.code)).to.include("MISSING_REPAIR_WEBAUTHN_PROOF");
    const createIndex = result.report.actions.findIndex((action) => action.id === "repair-signer-create");
    const repairIndex = result.report.actions.findIndex((action) => action.id === "repair-queue");
    const proofCancelIndex = result.report.actions.findIndex((action) => action.id === "post-rotation-proof-cancel");
    const freezeIndex = result.report.actions.findIndex((action) => action.id === "final-freeze");
    expect(createIndex).to.be.greaterThan(-1);
    expect(repairIndex).to.be.greaterThan(createIndex);
    expect(result.report.actions[repairIndex]?.safeTransaction).to.equal(undefined);
    expect(result.report.actions[repairIndex]?.expectedTransition).to.include("repairProofHash=");
    expect(proofCancelIndex).to.be.greaterThan(repairIndex);
    expect(freezeIndex).to.be.greaterThan(proofCancelIndex);
    expect(result.rendered).to.not.include("replacementProof");
    await expect(collectOrdinaryScenarioReview({ ...value, repair: { ...repair, address: address("0x1111111111111111111111111111111111111111") }, observer }, client({
      runtimeCode: async (who) => who.toLowerCase() === ECDSA_SECONDARY.toLowerCase() || who.toLowerCase() === "0x1111111111111111111111111111111111111111" ? "0x" : CODE,
      passkeySignerAddress: async () => address("0x1111111111111111111111111111111111111111"),
    }))).to.be.rejectedWith("fixed repair descriptor");
    await expect(collectOrdinaryScenarioReview({ ...value, repair, observer }, client({
      runtimeCode: async (who) => who.toLowerCase() === ECDSA_SECONDARY.toLowerCase() || who.toLowerCase() === repair.address.toLowerCase() ? "0x" : CODE,
      passkeySignerAddress: async () => CONTRACT_SECONDARY,
    }))).to.be.rejectedWith("factory-derived replacement");
  });
});
