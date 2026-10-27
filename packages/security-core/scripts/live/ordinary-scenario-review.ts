import {
  encodeAbiParameters,
  encodeFunctionData,
  hashTypedData,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { buildCancellationTransaction, buildExecutionTransaction, buildQueueTransaction, queueFingerprint, queueMonitoringFingerprint, type DelayQueueItem, type QueueTransaction } from "../../src/queue/delay";
import { SAFE_TX_TYPES, type SafeTxMessage } from "../../src/signers/types";
import { isReviewedVaultDeploymentPlan, planHash, type VaultDeploymentPlan } from "../../src/topology/build";
import { verifyTopology, type TopologyInput } from "../../src/topology/verify";
import { sha256 } from "../plan-deployment";
import { PHASE_OUTLAY_LIMIT, type LiveReceipt } from "./submission";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const FORBIDDEN_PUBLIC_KEY = /(?:signature|private|secret|seed|mnemonic|credential|password|pin|rpc|provider)/i;
const RECEIPT_IDS = ["vault-setup-helper", "vault-guard", "vault-delay", "vault-maintenance", "vault-safe"] as const;
const ERC20_ABI = parseAbi(["function transfer(address,uint256)", "function approve(address,uint256)"]);
const GUARD_ABI = parseAbi(["function freeze()"]);
const DELAY_ABI = parseAbi(["function skipExpired()"]);
const PASSKEY_FACTORY_ABI = parseAbi(["function createSigner(uint256,uint256,uint176) returns (address)"]);
const PASSKEY_FACTORY = "0xF7488fFbe67327ac9f37D5F722d83Fc900852Fbf" as Address;
const PASSKEY_VERIFIER = "0xc2b78104907F722DABAc4C69f826a522B2754De4" as Address;
const PASSKEY_FACTORY_RUNTIME_CODE_HASH = "0xbe9db61b4ee533cb4b1136ef244141db4ca3b7867b44d154db9faeb22f39d7bb" as Hex;

export type OrdinaryBaselineProof = Readonly<{
  schemaVersion: 1;
  result: "PASS_TWO_RPC";
  chainId: "11155111";
  planHash: Hex;
  safe: Address;
  transactions: readonly Readonly<{
    id: typeof RECEIPT_IDS[number];
    transactionHash: Hex;
    blockNumber: string;
    blockHash: Hex;
    gasUsed: string;
    effectiveGasPrice: string;
    actualCostWei: string;
  }>[];
  prerequisiteActualCostWei: string;
  safeCreationActualCostWei: string;
  combinedActualCostWei: string;
}>;

export type PublicSignerCapability = Readonly<{
  address: Address;
  kind: "safe-contract" | "ecdsa-extension";
  available: boolean;
  source: string;
}>;

export type OrdinaryRepairDescriptor = Readonly<{
  formatVersion: 1;
  scope: "ordinary-baseline-proposed-contract-secondary-repair";
  chainId: 11155111;
  factory: Address;
  address: Address;
  x: string;
  y: string;
  verifiers: string;
  observedRuntime: "0x";
  deployed: false;
  signed: false;
  broadcast: false;
}>;

export type IndependentObserverDescriptor = Readonly<{
  kind: "https-webhook" | "email" | "second-device";
  publicId: string;
  independentFromProposer: true;
}>;

export type ScenarioTopologyEvidence = Readonly<{ planHash: Hex; ok: boolean; checked: readonly string[]; failures: readonly string[] }>;
const topologyEvidence = new WeakSet<object>();

export async function verifyOrdinaryScenarioTopology(plan: VaultDeploymentPlan, input: TopologyInput): Promise<ScenarioTopologyEvidence> {
  if (!isReviewedVaultDeploymentPlan(plan)) throw new Error("ordinary scenario review requires the opaque reviewed deployment plan");
  if (input.chainId !== plan.chainId || input.safe.toLowerCase() !== plan.safeProxyDeployment.expectedCreatedAddress.toLowerCase() || input.guard.toLowerCase() !== plan.review.transactionGuard.toLowerCase() || input.delay.toLowerCase() !== plan.review.modules[0].toLowerCase()) throw new Error("ordinary scenario topology input does not match the reviewed plan");
  const report = await verifyTopology(input);
  const evidence = Object.freeze({ planHash: planHash(plan), ok: report.ok, checked: Object.freeze([...report.checked]), failures: Object.freeze([...report.failures]) });
  topologyEvidence.add(evidence);
  return evidence;
}

export function brandOrdinaryScenarioTopologyForTestsOnly(plan: VaultDeploymentPlan, ok: boolean): ScenarioTopologyEvidence {
  if (process.env.NODE_ENV !== "test" && process.env.HARDHAT_NETWORK !== "hardhat") throw new Error("test-only topology branding is disabled outside tests");
  const evidence = Object.freeze({ planHash: planHash(plan), ok, checked: Object.freeze(ok ? ["test topology"] : []), failures: Object.freeze(ok ? [] : ["test topology"]) });
  topologyEvidence.add(evidence);
  return evidence;
}

export type OrdinaryScenarioReviewClient = Readonly<{
  chainId(): Promise<number>;
  block(): Promise<Readonly<{ number: bigint; hash: Hex; timestamp: bigint }>>;
  blockHash(blockNumber: bigint): Promise<Hex>;
  safeNonce(safe: Address, blockNumber: bigint): Promise<bigint>;
  funderNonce(funder: Address, blockNumber: bigint): Promise<bigint>;
  delayNonce(delay: Address, blockNumber: bigint): Promise<bigint>;
  spendState(guard: Address, token: Address, blockNumber: bigint): Promise<Readonly<{ window: bigint; baseSpent: bigint; instantSpent: bigint }>>;
  nativeBalance(account: Address, blockNumber: bigint): Promise<bigint>;
  tokenBalance(token: Address, account: Address, blockNumber: bigint): Promise<bigint>;
  tokenMetadata(token: Address, blockNumber: bigint): Promise<Readonly<{ name: string; symbol: string; decimals: number }>>;
  runtimeCode(account: Address, blockNumber: bigint): Promise<Hex | undefined>;
  passkeySignerAddress(factory: Address, x: bigint, y: bigint, verifiers: bigint, blockNumber: bigint): Promise<Address>;
  canonicalReceipt(transactionHash: Hex): Promise<LiveReceipt | undefined>;
}>;

export type OrdinaryScenarioReviewInput = Readonly<{
  plan: VaultDeploymentPlan;
  topology: ScenarioTopologyEvidence;
  baseline: OrdinaryBaselineProof;
  signers: Readonly<{
    primary: PublicSignerCapability;
    safeContractSecondary: PublicSignerCapability;
    ecdsaSecondary: PublicSignerCapability;
  }>;
  observer?: IndependentObserverDescriptor;
  repair?: OrdinaryRepairDescriptor;
  proposedCaps: Readonly<{
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    fundingGasLimit: bigint;
    safeExecutionGasLimit: bigint;
    publicDelayGasLimit: bigint;
  }>;
}>;

type ReviewAction = Readonly<{
  id: string;
  kind: string;
  asset: "native" | "USDC" | "control";
  dependsOn: readonly string[];
  status: "CONDITIONAL_NOT_RUN" | "BLOCKED_INPUT";
  expectedOutcome: "success" | "rejection";
  signerRoles: readonly string[];
  safeTransaction?: Readonly<Record<string, unknown>>;
  publicTransaction?: Readonly<Record<string, unknown>>;
  queue?: Readonly<Record<string, unknown>>;
  timing?: Readonly<Record<string, unknown>>;
  proposedGasAndFee: Readonly<Record<string, string | boolean>>;
  expectedTransition: string;
  observerAlert: string;
}>;

export type OrdinaryScenarioReviewReport = Readonly<{
  schemaVersion: 1;
  status: "BLOCKED" | "READY_FOR_HUMAN_REVIEW";
  authorization: "NONE";
  chainId: "11155111";
  planHash: Hex;
  topologyEvidenceHash: Hex;
  baselineEvidenceHash: Hex;
  snapshot: Readonly<Record<string, unknown>>;
  publicIdentities: Readonly<Record<string, unknown>>;
  requiredInventory: Readonly<{ nativeWei: string; usdcUnits: string; initialExternalUsdcUnits: string; grossUsdcFundingUnits: string; explanation: string }>;
  blockers: readonly Readonly<{ code: string; detail: string }>[];
  actions: readonly ReviewAction[];
  phaseAccounting: Readonly<Record<string, string | boolean>>;
  finalRevalidation: Readonly<Record<string, unknown>>;
  signed: false;
  broadcast: false;
  liveEstimated: false;
}>;

export type OrdinaryScenarioReviewResult = Readonly<{ report: OrdinaryScenarioReviewReport; rendered: string; packageHash: Hex }>;

type CollectedState = Readonly<{
  safeNonce: bigint;
  funderNonce: bigint;
  delayNonce: bigint;
  nativeBalances: readonly [bigint, bigint, bigint];
  usdcBalances: readonly [bigint, bigint, bigint];
  spend: readonly [Readonly<{ window: bigint; baseSpent: bigint; instantSpent: bigint }>, Readonly<{ window: bigint; baseSpent: bigint; instantSpent: bigint }>];
  metadata: Readonly<{ name: string; symbol: string; decimals: number }>;
  runtime: readonly (Hex | undefined)[];
  repairDerivedAddress?: Address;
}>;

const canonical = (value: unknown): string => {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
};
const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const decimal = (value: string, label: string): bigint => {
  if (!DECIMAL.test(value)) throw new Error(`${label} must be a canonical decimal string`);
  return BigInt(value);
};
const assertNoForbiddenFields = (value: unknown, path = "input"): void => {
  if (Array.isArray(value)) return value.forEach((entry, index) => assertNoForbiddenFields(entry, `${path}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_PUBLIC_KEY.test(key)) throw new Error(`forbidden public input field: ${path}.${key}`);
    assertNoForbiddenFields(entry, `${path}.${key}`);
  }
};

function validatePolicy(plan: VaultDeploymentPlan): { native: VaultDeploymentPlan["review"]["assets"][number]; usdc: VaultDeploymentPlan["review"]["assets"][number]; recipient: Address } {
  const native = plan.review.assets[0]; const usdc = plan.review.assets[1];
  if (!native || !usdc || plan.chainId !== 11155111 || !same(plan.safeProxyDeployment.expectedCreatedAddress, "0xd751a1479f49d63DC61E0081B0b4d8c60623D9a6") || !same(native.token, ZERO) || !same(usdc.token, "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238") || native.baseDailyLimit !== 10_000_000_000_000n || native.instantDailyLimit !== 30_000_000_000_000n || usdc.baseDailyLimit !== 10_000_000n || usdc.instantDailyLimit !== 30_000_000n || plan.review.delay.cooldownSeconds !== 120 || plan.review.delay.expirationSeconds !== 600 || native.recipients.length !== 1 || usdc.recipients.length !== 1 || !same(native.recipients[0]!, plan.deployer) || !same(usdc.recipients[0]!, plan.deployer)) throw new Error("ordinary scenario review plan does not match the fixed native/USDC X/Y/Z scope");
  return { native, usdc, recipient: native.recipients[0]! };
}

async function validateBaseline(plan: VaultDeploymentPlan, proof: OrdinaryBaselineProof, client: OrdinaryScenarioReviewClient): Promise<bigint> {
  if (proof.schemaVersion !== 1 || proof.result !== "PASS_TWO_RPC" || proof.chainId !== "11155111" || !same(proof.planHash, planHash(plan)) || !same(proof.safe, plan.safeProxyDeployment.expectedCreatedAddress) || proof.transactions.length !== 5) throw new Error("ordinary scenario baseline proof mismatch");
  let prerequisites = 0n; let safeCreation = 0n;
  for (let index = 0; index < RECEIPT_IDS.length; index++) {
    const entry = proof.transactions[index]!;
    if (entry.id !== RECEIPT_IDS[index] || !HASH.test(entry.transactionHash) || !HASH.test(entry.blockHash)) throw new Error("ordinary scenario baseline receipt identity mismatch");
    const cost = decimal(entry.gasUsed, `${entry.id}.gasUsed`) * decimal(entry.effectiveGasPrice, `${entry.id}.effectiveGasPrice`);
    if (decimal(entry.actualCostWei, `${entry.id}.actualCostWei`) !== cost) throw new Error("ordinary scenario baseline accounting mismatch");
    if (index < 4) prerequisites += cost; else safeCreation += cost;
    const canonicalReceipt = await client.canonicalReceipt(entry.transactionHash);
    if (!canonicalReceipt || canonicalReceipt.status !== "success" || canonicalReceipt.transactionHash !== entry.transactionHash || canonicalReceipt.blockNumber !== decimal(entry.blockNumber, `${entry.id}.blockNumber`) || !same(canonicalReceipt.blockHash, entry.blockHash) || canonicalReceipt.gasUsed !== decimal(entry.gasUsed, `${entry.id}.gasUsed`) || canonicalReceipt.effectiveGasPrice !== decimal(entry.effectiveGasPrice, `${entry.id}.effectiveGasPrice`)) throw new Error("ordinary scenario canonical baseline receipt mismatch");
  }
  const combined = prerequisites + safeCreation;
  if (decimal(proof.prerequisiteActualCostWei, "prerequisiteActualCostWei") !== prerequisites || decimal(proof.safeCreationActualCostWei, "safeCreationActualCostWei") !== safeCreation || decimal(proof.combinedActualCostWei, "combinedActualCostWei") !== combined) throw new Error("ordinary scenario baseline accounting mismatch");
  return combined;
}

function validateCaps(caps: OrdinaryScenarioReviewInput["proposedCaps"]): void {
  if (caps.maxFeePerGas <= 0n || caps.maxPriorityFeePerGas < 0n || caps.maxPriorityFeePerGas > caps.maxFeePerGas || caps.fundingGasLimit <= 0n || caps.safeExecutionGasLimit <= 0n || caps.publicDelayGasLimit <= 0n) throw new Error("ordinary scenario proposed caps are invalid");
}

function validateCapabilities(plan: VaultDeploymentPlan, input: OrdinaryScenarioReviewInput, blockers: { code: string; detail: string }[]): void {
  const expected = [plan.review.owners[0], plan.review.safeContractSecondary, plan.review.ecdsaSecondary];
  const capabilities = [input.signers.primary, input.signers.safeContractSecondary, input.signers.ecdsaSecondary];
  const kinds = ["safe-contract", "safe-contract", "ecdsa-extension"];
  capabilities.forEach((capability, index) => {
    if (!same(capability.address, expected[index]!) || capability.kind !== kinds[index] || !/^[ -~]{1,160}$/.test(capability.source)) throw new Error("ordinary scenario signer capability mismatch");
    if (!capability.available) blockers.push({ code: `MISSING_${index === 0 ? "PRIMARY" : index === 1 ? "CONTRACT_SECONDARY" : "ECDSA_SECONDARY"}_CAPABILITY`, detail: `${capability.address} is not publicly declared available` });
  });
}

async function readState(input: OrdinaryScenarioReviewInput, client: OrdinaryScenarioReviewClient, blockNumber: bigint, usdc: Address, recipient: Address): Promise<CollectedState> {
  const plan = input.plan; const safe = plan.safeProxyDeployment.expectedCreatedAddress; const guard = plan.review.transactionGuard; const delay = plan.review.modules[0];
  const runtimeAddresses = [safe, guard, delay, plan.prerequisites.maintenance.expectedCreatedAddress, input.signers.primary.address, input.signers.safeContractSecondary.address, input.signers.ecdsaSecondary.address, ...(input.repair ? [input.repair.address] : [])] as const;
  const [safeNonce, funderNonce, delayNonce, funderNative, safeNative, recipientNative, funderUsdc, safeUsdc, recipientUsdc, nativeSpend, usdcSpend, metadata, runtime, repairDerivedAddress] = await Promise.all([
    client.safeNonce(safe, blockNumber), client.funderNonce(plan.deployer, blockNumber), client.delayNonce(delay, blockNumber),
    client.nativeBalance(plan.deployer, blockNumber), client.nativeBalance(safe, blockNumber), client.nativeBalance(recipient, blockNumber),
    client.tokenBalance(usdc, plan.deployer, blockNumber), client.tokenBalance(usdc, safe, blockNumber), client.tokenBalance(usdc, recipient, blockNumber),
    client.spendState(guard, ZERO, blockNumber), client.spendState(guard, usdc, blockNumber), client.tokenMetadata(usdc, blockNumber),
    Promise.all(runtimeAddresses.map((address) => client.runtimeCode(address, blockNumber))),
    input.repair ? client.passkeySignerAddress(input.repair.factory, BigInt(input.repair.x), BigInt(input.repair.y), BigInt(input.repair.verifiers), blockNumber) : undefined,
  ]);
  return Object.freeze({ safeNonce, funderNonce, delayNonce, nativeBalances: [funderNative, safeNative, recipientNative], usdcBalances: [funderUsdc, safeUsdc, recipientUsdc], spend: [nativeSpend, usdcSpend], metadata, runtime, repairDerivedAddress });
}

function validateFreshState(state: CollectedState, input: OrdinaryScenarioReviewInput): void {
  if (state.safeNonce !== 0n) throw new Error("ordinary scenario review requires fresh Safe nonce 0");
  if (state.delayNonce !== 0n) throw new Error("ordinary scenario review requires fresh Delay nonce 0");
  for (const spend of state.spend) if (spend.baseSpent !== 0n || spend.instantSpent !== 0n) throw new Error("ordinary scenario review requires zero spend counters");
  if (state.metadata.symbol !== "USDC" || state.metadata.decimals !== 6 || !/^[ -~]{1,64}$/.test(state.metadata.name)) throw new Error("ordinary scenario USDC metadata mismatch");
  for (let index = 0; index < 6; index++) if (!state.runtime[index] || state.runtime[index] === "0x") throw new Error("ordinary scenario required runtime identity is missing");
  if (state.runtime[6] !== "0x") throw new Error("ordinary scenario ECDSA secondary must remain an EOA identity");
  if (input.repair) {
    const repair = input.repair;
    const canonicalNumber = (value: string) => DECIMAL.test(value) && BigInt(value) > 0n;
    const bindingHash = canonicalNumber(repair.x) && canonicalNumber(repair.y) && canonicalNumber(repair.verifiers) ? keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint176" }], [repair.factory, BigInt(repair.x), BigInt(repair.y), BigInt(repair.verifiers)])) : undefined;
    if (repair.formatVersion !== 1 || repair.scope !== "ordinary-baseline-proposed-contract-secondary-repair" || repair.chainId !== 11155111 || same(repair.address, input.plan.review.safeContractSecondary) || !same(repair.factory, PASSKEY_FACTORY) || !bindingHash || repair.observedRuntime !== "0x" || repair.deployed !== false || repair.signed !== false || repair.broadcast !== false || state.runtime[7] !== "0x") throw new Error("ordinary scenario fixed repair descriptor mismatch");
    if (!state.repairDerivedAddress || !same(state.repairDerivedAddress, repair.address)) throw new Error("ordinary scenario factory-derived replacement address mismatch");
  }
}

function repairProofHash(plan: VaultDeploymentPlan, repair: OrdinaryRepairDescriptor): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }],
    ["RecentTxSafeGuard.passkeyReplacement.v1", BigInt(plan.chainId), plan.safeProxyDeployment.expectedCreatedAddress, plan.review.modules[0], plan.review.transactionGuard, plan.review.safeContractSecondary, repair.address],
  ));
}

function repairBindingHash(repair: OrdinaryRepairDescriptor): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint176" }], [repair.factory, BigInt(repair.x), BigInt(repair.y), BigInt(repair.verifiers)]));
}

function safeTransaction(safe: Address, chainId: number, to: Address, value: bigint, data: Hex, operation: 0 | 1, nonce: bigint): Readonly<{ message: SafeTxMessage; hash: Hex; public: Readonly<Record<string, unknown>> }> {
  const message = Object.freeze({ to, value, data, operation, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO, nonce });
  const hash = hashTypedData({ domain: { chainId, verifyingContract: safe }, types: { SafeTx: SAFE_TX_TYPES }, primaryType: "SafeTx", message });
  return Object.freeze({ message, hash, public: Object.freeze({ to, value: value.toString(), data, operation, safeNonce: nonce.toString(), safeTxHash: hash, safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: ZERO, refundReceiver: ZERO }) });
}

function rawPublic(tx: QueueTransaction): Readonly<Record<string, unknown>> {
  return Object.freeze({ to: tx.to, value: tx.value.toString(), data: tx.data, operation: tx.operation, safeNonce: null, safeTxHash: null, outerTransactionNonce: "REVALIDATE_BEFORE_EXECUTION" });
}

function proposedFee(caps: OrdinaryScenarioReviewInput["proposedCaps"], gasClass: "funding" | "safe" | "delay"): Readonly<Record<string, string | boolean>> {
  const gasLimit = gasClass === "funding" ? caps.fundingGasLimit : gasClass === "safe" ? caps.safeExecutionGasLimit : caps.publicDelayGasLimit;
  return Object.freeze({ gasLimit: gasLimit.toString(), maxFeePerGas: caps.maxFeePerGas.toString(), maxPriorityFeePerGas: caps.maxPriorityFeePerGas.toString(), liveEstimated: false, preSendEstimateRequired: true });
}

function queueFields(item: DelayQueueItem): Readonly<Record<string, unknown>> {
  return Object.freeze({ queueNonce: item.queueNonce.toString(), queueFingerprint: queueFingerprint(item), monitoringFingerprint: queueMonitoringFingerprint(item), to: item.to, value: item.value.toString(), data: item.data, operation: item.operation });
}

function queueTiming(): Readonly<Record<string, unknown>> {
  return Object.freeze({ source: "FUTURE_CANONICAL_QUEUE_RECEIPT_BLOCK", createdAt: null, readyAt: null, expiresAt: null, cooldownSeconds: "120", expirationSeconds: "600", status: "CONDITIONAL_NOT_RUN", revalidateFromCanonicalReceipt: true });
}

function buildActions(input: OrdinaryScenarioReviewInput, state: CollectedState, nativeFunding: bigint, initialUsdcFunding: bigint, recycledStepUpFunding: bigint, recycledDelayedFunding: bigint): readonly ReviewAction[] {
  const actions: ReviewAction[] = []; const plan = input.plan; const safe = plan.safeProxyDeployment.expectedCreatedAddress; const guard = plan.review.transactionGuard; const delay = plan.review.modules[0]; const recipient = plan.review.assets[0]!.recipients[0]!; const usdc = plan.review.assets[1]!.token;
  let safeNonce = state.safeNonce; let delayNonce = state.delayNonce; let funderNonce = state.funderNonce;
  const add = (action: ReviewAction) => actions.push(Object.freeze(action));
  const addSafe = (id: string, kind: string, asset: ReviewAction["asset"], dependsOn: readonly string[], expectedOutcome: "success" | "rejection", signerRoles: readonly string[], tx: ReturnType<typeof safeTransaction>, expectedTransition: string, observerAlert = "none") => add({ id, kind, asset, dependsOn, status: "CONDITIONAL_NOT_RUN", expectedOutcome, signerRoles, safeTransaction: tx.public, proposedGasAndFee: proposedFee(input.proposedCaps, "safe"), expectedTransition, observerAlert });
  const addPublic = (id: string, kind: string, asset: ReviewAction["asset"], dependsOn: readonly string[], expectedOutcome: "success" | "rejection", tx: QueueTransaction, item: DelayQueueItem, expectedTransition: string, observerAlert: string) => add({ id, kind, asset, dependsOn, status: "CONDITIONAL_NOT_RUN", expectedOutcome, signerRoles: [], publicTransaction: rawPublic(tx), queue: queueFields(item), timing: queueTiming(), proposedGasAndFee: proposedFee(input.proposedCaps, "delay"), expectedTransition, observerAlert });

  add({ id: "native-funding", kind: "funding", asset: "native", dependsOn: [], status: "CONDITIONAL_NOT_RUN", expectedOutcome: "success", signerRoles: ["funder"], publicTransaction: Object.freeze({ to: safe, value: nativeFunding.toString(), data: "0x", operation: 0, funderNonce: funderNonce.toString(), safeNonce: null, safeTxHash: null }), proposedGasAndFee: proposedFee(input.proposedCaps, "funding"), expectedTransition: `Safe native inventory increases by ${nativeFunding}`, observerAlert: "none" });
  funderNonce += 1n;
  add({ id: "usdc-funding", kind: "funding", asset: "USDC", dependsOn: [], status: state.usdcBalances[0] < initialUsdcFunding ? "BLOCKED_INPUT" : "CONDITIONAL_NOT_RUN", expectedOutcome: "success", signerRoles: ["funder"], publicTransaction: Object.freeze({ to: usdc, value: "0", data: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [safe, initialUsdcFunding] }), operation: 0, funderNonce: funderNonce.toString(), safeNonce: null, safeTxHash: null }), proposedGasAndFee: proposedFee(input.proposedCaps, "funding"), expectedTransition: `Safe USDC inventory increases by ${initialUsdcFunding}; spend counters and Safe/Delay nonces remain unchanged`, observerAlert: "none" });
  funderNonce += 1n;

  const buildAsset = (prefix: "native" | "usdc", token: Address, x: bigint, y: bigint, delayedAmount: bigint, transfer: (amount: bigint) => Readonly<{ to: Address; value: bigint; data: Hex }>, unitLabel: string) => {
    const asset = prefix === "native" ? "native" as const : "USDC" as const; const step = (y - x) / 2n; const fundingId = `${prefix}-funding`;
    const base = safeTransaction(safe, plan.chainId, transfer(x).to, transfer(x).value, transfer(x).data, 0, safeNonce);
    addSafe(`${prefix}-base-x`, "base-transfer", asset, [fundingId], "success", ["primary-passkey"], base, `baseSpent=${x}; instantSpent=${x}`); safeNonce += 1n;
    const contract = safeTransaction(safe, plan.chainId, transfer(step).to, transfer(step).value, transfer(step).data, 0, safeNonce);
    addSafe(`${prefix}-step-up-contract`, "step-up-transfer", asset, [`${prefix}-base-x`], "success", ["primary-passkey", "safe-contract-secondary"], contract, `baseSpent=${x}; instantSpent=${x + step}`, "step-up-executed"); safeNonce += 1n;
    let ecdsaDependency = `${prefix}-step-up-contract`;
    if (prefix === "usdc") {
      add({ id: "usdc-recycle-topup-step-up", kind: "controlled-recipient-recycled-funding", asset: "USDC", dependsOn: [ecdsaDependency], status: "CONDITIONAL_NOT_RUN", expectedOutcome: "success", signerRoles: ["funder"], publicTransaction: Object.freeze({ to: usdc, value: "0", data: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [safe, recycledStepUpFunding] }), operation: 0, funderNonce: funderNonce.toString(), safeNonce: null, safeTxHash: null }), proposedGasAndFee: proposedFee(input.proposedCaps, "funding"), expectedTransition: `Controlled recipient returns ${recycledStepUpFunding} USDC units to Safe; baseSpent=${x}, instantSpent=${x + step}, and both Safe/Delay nonces remain unchanged`, observerAlert: "none" });
      funderNonce += 1n;
      ecdsaDependency = "usdc-recycle-topup-step-up";
    }
    const ecdsa = safeTransaction(safe, plan.chainId, transfer(step).to, transfer(step).value, transfer(step).data, 0, safeNonce);
    addSafe(`${prefix}-step-up-ecdsa`, "step-up-transfer", asset, [ecdsaDependency], "success", ["primary-passkey", "legacy-ecdsa-secondary"], ecdsa, `baseSpent=${x}; instantSpent=${y}`, "step-up-executed"); safeNonce += 1n;
    const overspend = safeTransaction(safe, plan.chainId, transfer(1n).to, transfer(1n).value, transfer(1n).data, 0, safeNonce);
    addSafe(`${prefix}-direct-overspend-rejection`, "expected-direct-rejection", asset, [`${prefix}-step-up-ecdsa`], "rejection", ["primary-passkey", "safe-contract-secondary"], overspend, `No balance/counter change; shared Y remains ${y}`);
    addSafe(`${prefix}-replay-rejection`, "expected-replay-rejection", asset, [`${prefix}-base-x`], "rejection", ["replay previously reviewed signed envelope only in later executor"], base, "No balance/counter/Safe nonce change");
    const unsupported = safeTransaction(safe, plan.chainId, usdc, 0n, encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [recipient, 1n] }), 0, safeNonce);
    addSafe(`${prefix}-unsupported-path-rejection`, "expected-unsupported-rejection", asset, [`${prefix}-step-up-ecdsa`], "rejection", ["primary-passkey", "safe-contract-secondary"], unsupported, "No approval, balance, counter, or Safe nonce change");

    let queueDependency = `${prefix}-step-up-ecdsa`;
    if (prefix === "usdc") {
      add({ id: "usdc-recycle-topup-delayed", kind: "controlled-recipient-recycled-funding", asset: "USDC", dependsOn: [queueDependency], status: "CONDITIONAL_NOT_RUN", expectedOutcome: "success", signerRoles: ["funder"], publicTransaction: Object.freeze({ to: usdc, value: "0", data: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [safe, recycledDelayedFunding] }), operation: 0, funderNonce: funderNonce.toString(), safeNonce: null, safeTxHash: null }), proposedGasAndFee: proposedFee(input.proposedCaps, "funding"), expectedTransition: `Controlled recipient returns ${recycledDelayedFunding} USDC units to Safe after cumulative immediate spend reaches Y; counters and both Safe/Delay nonces remain unchanged`, observerAlert: "none" });
      funderNonce += 1n;
      queueDependency = "usdc-recycle-topup-delayed";
    }
    const cancelItem: DelayQueueItem = { safe, delay, ...transfer(delayedAmount), operation: 0, queueNonce: delayNonce };
    const cancelQueueTx = buildQueueTransaction(cancelItem); const cancelQueue = safeTransaction(safe, plan.chainId, cancelQueueTx.to, cancelQueueTx.value, cancelQueueTx.data, cancelQueueTx.operation, safeNonce);
    add({ id: `${prefix}-queue-cancel`, kind: "queue-proposal", asset, dependsOn: [queueDependency], status: "CONDITIONAL_NOT_RUN", expectedOutcome: "success", signerRoles: ["primary-passkey", "safe-contract-secondary"], safeTransaction: cancelQueue.public, queue: queueFields(cancelItem), timing: queueTiming(), proposedGasAndFee: proposedFee(input.proposedCaps, "safe"), expectedTransition: `Delay item ${delayNonce} queued; counters and balances unchanged`, observerAlert: "delayed-queued" }); safeNonce += 1n;
    addPublic(`${prefix}-queue-cancel-early-rejection`, "expected-early-rejection", asset, [`${prefix}-queue-cancel`], "rejection", buildExecutionTransaction(cancelItem), cancelItem, "No Delay nonce or balance change before Z", "none");
    const cancelTx = buildCancellationTransaction(delay, delayNonce + 1n); const cancelSafe = safeTransaction(safe, plan.chainId, cancelTx.to, cancelTx.value, cancelTx.data, cancelTx.operation, safeNonce);
    addSafe(`${prefix}-queue-cancel-action`, "queue-cancellation", asset, [`${prefix}-queue-cancel`], "success", ["primary-passkey", "safe-contract-secondary"], cancelSafe, `Delay nonce advances from ${delayNonce} to ${delayNonce + 1n}; balance unchanged`, "delayed-cancelled"); safeNonce += 1n;
    addPublic(`${prefix}-queue-cancelled-execution-rejection`, "expected-cancelled-rejection", asset, [`${prefix}-queue-cancel-action`], "rejection", buildExecutionTransaction(cancelItem), cancelItem, "No balance/counter/Delay nonce change", "none"); delayNonce += 1n;

    const expiryItem: DelayQueueItem = { safe, delay, ...transfer(delayedAmount), operation: 0, queueNonce: delayNonce };
    const expiryQueueTx = buildQueueTransaction(expiryItem); const expiryQueue = safeTransaction(safe, plan.chainId, expiryQueueTx.to, expiryQueueTx.value, expiryQueueTx.data, expiryQueueTx.operation, safeNonce);
    add({ id: `${prefix}-queue-expiry`, kind: "queue-proposal", asset, dependsOn: [`${prefix}-queue-cancel-action`], status: "CONDITIONAL_NOT_RUN", expectedOutcome: "success", signerRoles: ["primary-passkey", "safe-contract-secondary"], safeTransaction: expiryQueue.public, queue: queueFields(expiryItem), timing: queueTiming(), proposedGasAndFee: proposedFee(input.proposedCaps, "safe"), expectedTransition: `Delay item ${delayNonce} queued; counters and balances unchanged`, observerAlert: "delayed-queued" }); safeNonce += 1n;
    addPublic(`${prefix}-queue-expiry-early-rejection`, "expected-early-rejection", asset, [`${prefix}-queue-expiry`], "rejection", buildExecutionTransaction(expiryItem), expiryItem, "No Delay nonce or balance change before Z", "none");
    const skip: QueueTransaction = { to: delay, value: 0n, data: encodeFunctionData({ abi: DELAY_ABI, functionName: "skipExpired" }), operation: 0 };
    addPublic(`${prefix}-queue-expiry-skip`, "queue-expiry", asset, [`${prefix}-queue-expiry`], "success", skip, expiryItem, `After canonical createdAt+120+600, Delay nonce advances from ${delayNonce} to ${delayNonce + 1n}; balance unchanged`, "delayed-expired");
    addPublic(`${prefix}-queue-expired-execution-rejection`, "expected-expired-rejection", asset, [`${prefix}-queue-expiry-skip`], "rejection", buildExecutionTransaction(expiryItem), expiryItem, "No balance/counter/Delay nonce change", "none"); delayNonce += 1n;

    const readyItem: DelayQueueItem = { safe, delay, ...transfer(delayedAmount), operation: 0, queueNonce: delayNonce };
    const readyQueueTx = buildQueueTransaction(readyItem); const readyQueue = safeTransaction(safe, plan.chainId, readyQueueTx.to, readyQueueTx.value, readyQueueTx.data, readyQueueTx.operation, safeNonce);
    add({ id: `${prefix}-queue-execute`, kind: "queue-proposal", asset, dependsOn: [`${prefix}-queue-expiry-skip`], status: "CONDITIONAL_NOT_RUN", expectedOutcome: "success", signerRoles: ["primary-passkey", "safe-contract-secondary"], safeTransaction: readyQueue.public, queue: queueFields(readyItem), timing: queueTiming(), proposedGasAndFee: proposedFee(input.proposedCaps, "safe"), expectedTransition: `Delay item ${delayNonce} queued; counters and balances unchanged`, observerAlert: "delayed-queued" }); safeNonce += 1n;
    addPublic(`${prefix}-queue-execute-early-rejection`, "expected-early-rejection", asset, [`${prefix}-queue-execute`], "rejection", buildExecutionTransaction(readyItem), readyItem, "No Delay nonce or balance change before Z", "none");
    addPublic(`${prefix}-queue-ready-execute`, "ready-delay-execution", asset, [`${prefix}-queue-execute-early-rejection`], "success", buildExecutionTransaction(readyItem), readyItem, `After the canonical queue block +120 seconds, recipient outflow reaches 31 ${unitLabel}; Delay nonce advances to ${delayNonce + 1n}`, "delayed-executed"); delayNonce += 1n;
  };

  buildAsset("native", ZERO, 10_000_000_000_000n, 30_000_000_000_000n, 1n, (amount) => ({ to: recipient, value: amount, data: "0x" }), "native matrix units");
  buildAsset("usdc", usdc, 10_000_000n, 30_000_000n, 1_000_000n, (amount) => ({ to: usdc, value: 0n, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [recipient, amount] }) }), "USDC");

  if (input.repair) {
    const proofHash = repairProofHash(input.plan, input.repair);
    const createData = encodeFunctionData({ abi: PASSKEY_FACTORY_ABI, functionName: "createSigner", args: [BigInt(input.repair.x), BigInt(input.repair.y), BigInt(input.repair.verifiers)] });
    add({ id: "repair-signer-create", kind: "conditional-factory-signer-creation", asset: "control", dependsOn: ["usdc-queue-ready-execute"], status: "BLOCKED_INPUT", expectedOutcome: "success", signerRoles: ["funder"], publicTransaction: Object.freeze({ to: input.repair.factory, value: "0", data: createData, operation: 0, outerTransactionNonce: "REVALIDATE_BEFORE_SEPARATE_REVIEW", safeNonce: null, safeTxHash: null }), proposedGasAndFee: proposedFee(input.proposedCaps, "funding"), expectedTransition: `Deploy ${input.repair.address} through the pinned factory; verify factory=${input.repair.factory}, verifier=${PASSKEY_VERIFIER}, factoryRuntime=${PASSKEY_FACTORY_RUNTIME_CODE_HASH}, bindingHash=${repairBindingHash(input.repair)}`, observerAlert: "none" });
    add({ id: "repair-queue", kind: "delayed-contract-secondary-repair", asset: "control", dependsOn: ["repair-signer-create"], status: "BLOCKED_INPUT", expectedOutcome: "success", signerRoles: ["primary-passkey", "current-safe-contract-secondary"], proposedGasAndFee: proposedFee(input.proposedCaps, "safe"), expectedTransition: `repairProofHash=${proofHash}; exact maintenance calldata, queue tuple, Safe nonce ${safeNonce}, SafeTx hash, and Delay nonce ${delayNonce} remain NOT_RUN until a fresh non-public WebAuthn proof is produced and separately reviewed`, observerAlert: "delayed-queued" });
    safeNonce += 1n; delayNonce += 1n;
    add({ id: "repair-ready-execute", kind: "delayed-contract-secondary-repair-execution", asset: "control", dependsOn: ["repair-queue"], status: "BLOCKED_INPUT", expectedOutcome: "success", signerRoles: [], proposedGasAndFee: proposedFee(input.proposedCaps, "delay"), expectedTransition: `Execute only the exact proof-bound queue tuple after Z; contract secondary becomes ${input.repair.address}; owners/guards/modules/policy/counters/balances require rotation-aware re-verification`, observerAlert: "delayed-executed" });
    const proofItem: DelayQueueItem = { safe, delay, to: recipient, value: 1n, data: "0x", operation: 0, queueNonce: delayNonce };
    const proofQueueTx = buildQueueTransaction(proofItem); const proofQueueSafe = safeTransaction(safe, plan.chainId, proofQueueTx.to, proofQueueTx.value, proofQueueTx.data, proofQueueTx.operation, safeNonce);
    addSafe("post-rotation-old-secondary-rejection", "expected-old-secondary-rejection", "control", ["repair-ready-execute"], "rejection", ["primary-passkey", "old-safe-contract-secondary"], proofQueueSafe, "Safe nonce, Delay nonce, counters, and balances remain unchanged");
    add({ id: "post-rotation-new-secondary-queue", kind: "post-rotation-usability-queue", asset: "control", dependsOn: ["post-rotation-old-secondary-rejection"], status: "CONDITIONAL_NOT_RUN", expectedOutcome: "success", signerRoles: ["primary-passkey", "new-safe-contract-secondary"], safeTransaction: proofQueueSafe.public, queue: queueFields(proofItem), timing: queueTiming(), proposedGasAndFee: proposedFee(input.proposedCaps, "safe"), expectedTransition: `New secondary queues the exact one-wei native transfer at Delay nonce ${delayNonce}; counters and balances unchanged`, observerAlert: "delayed-queued" }); safeNonce += 1n;
    const proofCancel = buildCancellationTransaction(delay, delayNonce + 1n); const proofCancelSafe = safeTransaction(safe, plan.chainId, proofCancel.to, proofCancel.value, proofCancel.data, proofCancel.operation, safeNonce);
    addSafe("post-rotation-proof-cancel", "post-rotation-proof-cancellation", "control", ["post-rotation-new-secondary-queue"], "success", ["primary-passkey", "new-safe-contract-secondary"], proofCancelSafe, `Delay nonce advances from ${delayNonce} to ${delayNonce + 1n}; proof transfer never executes`, "delayed-cancelled"); safeNonce += 1n; delayNonce += 1n;
  } else {
    add({ id: "repair-signer-create", kind: "conditional-factory-signer-creation", asset: "control", dependsOn: ["usdc-queue-ready-execute"], status: "BLOCKED_INPUT", expectedOutcome: "success", signerRoles: ["funder"], proposedGasAndFee: proposedFee(input.proposedCaps, "funding"), expectedTransition: "Unavailable until an exact public canonical factory signer descriptor is supplied", observerAlert: "none" });
    add({ id: "repair-queue", kind: "delayed-contract-secondary-repair", asset: "control", dependsOn: ["repair-signer-create"], status: "BLOCKED_INPUT", expectedOutcome: "success", signerRoles: ["primary-passkey", "safe-contract-secondary"], proposedGasAndFee: proposedFee(input.proposedCaps, "safe"), expectedTransition: "Unavailable until an exact public repair identity and later ephemeral WebAuthn proof are separately reviewed", observerAlert: "delayed-queued" });
    add({ id: "post-rotation-proof-cancel", kind: "post-rotation-proof-cancellation", asset: "control", dependsOn: ["repair-queue"], status: "BLOCKED_INPUT", expectedOutcome: "success", signerRoles: ["primary-passkey", "new-safe-contract-secondary"], proposedGasAndFee: proposedFee(input.proposedCaps, "safe"), expectedTransition: "Unavailable until the proof-bound rotation succeeds", observerAlert: "delayed-cancelled" });
    safeNonce += 3n; delayNonce += 2n;
  }
  const freeze = safeTransaction(safe, plan.chainId, guard, 0n, encodeFunctionData({ abi: GUARD_ABI, functionName: "freeze" }), 0, safeNonce);
  addSafe("final-freeze", "emergency-freeze", "control", [input.repair ? "post-rotation-proof-cancel" : "repair-queue"], "success", ["primary-passkey", input.repair ? "new-safe-contract-secondary" : "safe-contract-secondary"], freeze, "Instant and delayed transfer paths reject after freeze; topology and counters remain bound");
  return Object.freeze(actions);
}

function blockSnapshot(state: CollectedState, block: Readonly<{ number: bigint; hash: Hex; timestamp: bigint }>, plan: VaultDeploymentPlan): Readonly<Record<string, unknown>> {
  return Object.freeze({
    blockNumber: block.number.toString(), blockHash: block.hash, blockTimestamp: block.timestamp.toString(), safeNonce: state.safeNonce.toString(), funderNonce: state.funderNonce.toString(), delayNonce: state.delayNonce.toString(),
    balances: Object.freeze({ funder: Object.freeze({ address: plan.deployer, nativeWei: state.nativeBalances[0].toString(), usdcUnits: state.usdcBalances[0].toString() }), safe: Object.freeze({ address: plan.safeProxyDeployment.expectedCreatedAddress, nativeWei: state.nativeBalances[1].toString(), usdcUnits: state.usdcBalances[1].toString() }), recipient: Object.freeze({ address: plan.review.assets[0]!.recipients[0]!, nativeWei: state.nativeBalances[2].toString(), usdcUnits: state.usdcBalances[2].toString() }) }),
    counters: Object.freeze([{ token: ZERO, window: state.spend[0].window.toString(), baseSpent: state.spend[0].baseSpent.toString(), instantSpent: state.spend[0].instantSpent.toString() }, { token: plan.review.assets[1]!.token, window: state.spend[1].window.toString(), baseSpent: state.spend[1].baseSpent.toString(), instantSpent: state.spend[1].instantSpent.toString() }]),
    token: Object.freeze({ address: plan.review.assets[1]!.token, name: state.metadata.name, symbol: state.metadata.symbol, decimals: state.metadata.decimals }),
  });
}

export async function collectOrdinaryScenarioReview(input: OrdinaryScenarioReviewInput, client: OrdinaryScenarioReviewClient): Promise<OrdinaryScenarioReviewResult> {
  assertNoForbiddenFields(input);
  if (!isReviewedVaultDeploymentPlan(input.plan)) throw new Error("ordinary scenario review requires the opaque reviewed deployment plan");
  if (!topologyEvidence.has(input.topology) || !same(input.topology.planHash, planHash(input.plan))) throw new Error("ordinary scenario review requires verified post-setup topology evidence");
  if (!input.topology.ok) throw new Error("ordinary scenario topology did not pass");
  const { usdc, recipient } = validatePolicy(input.plan);
  validateCaps(input.proposedCaps);
  if (await client.chainId() !== 11155111) throw new Error("ordinary scenario review requires Ethereum Sepolia");
  const baselineActual = await validateBaseline(input.plan, input.baseline, client);
  const block = await client.block();
  if (!HASH.test(block.hash) || block.number < 0n || block.timestamp <= 0n) throw new Error("ordinary scenario canonical snapshot is invalid");
  const initial = await readState(input, client, block.number, usdc.token, recipient);
  validateFreshState(initial, input);
  const blockers: { code: string; detail: string }[] = [];
  validateCapabilities(input.plan, input, blockers);
  const requiredNative = 30_000_000_000_001n; const requiredUsdc = 31_000_000n; const initialExternalUsdc = 20_000_000n;
  const nativeFunding = initial.nativeBalances[1] >= requiredNative ? 0n : requiredNative - initial.nativeBalances[1];
  const grossUsdcFunding = initial.usdcBalances[1] >= requiredUsdc ? 0n : requiredUsdc - initial.usdcBalances[1];
  const initialUsdcFunding = grossUsdcFunding < initialExternalUsdc ? grossUsdcFunding : initialExternalUsdc;
  const recycledStepUpFunding = grossUsdcFunding > initialUsdcFunding ? (grossUsdcFunding - initialUsdcFunding < 10_000_000n ? grossUsdcFunding - initialUsdcFunding : 10_000_000n) : 0n;
  const recycledDelayedFunding = grossUsdcFunding - initialUsdcFunding - recycledStepUpFunding;
  if (initial.usdcBalances[0] < initialUsdcFunding) blockers.push({ code: "MISSING_USDC_INVENTORY", detail: `configured funder needs ${initialUsdcFunding} initial USDC units at the pinned block; controlled-recipient returns may fund only later exact top-ups and cannot be presumed before their canonical receipts` });
  if (!input.observer) blockers.push({ code: "MISSING_INDEPENDENT_OBSERVER", detail: "an exact independently operated public alert-channel descriptor and later delivery evidence are required" });
  else if (input.observer.independentFromProposer !== true || !/^[ -~]{1,160}$/.test(input.observer.publicId)) throw new Error("ordinary scenario independent observer descriptor is invalid");
  if (!input.repair) blockers.push({ code: "MISSING_REPAIR_DESCRIPTOR", detail: "an exact fixed replacement signer/maintenance identity is required before the repair Safe transaction can be encoded" });
  else {
    blockers.push({ code: "MISSING_REPAIR_SIGNER_DEPLOYMENT", detail: `replacement ${input.repair.address} has no runtime at the pinned block; factory creation and canonical runtime/binding verification require separate review` });
    blockers.push({ code: "MISSING_REPAIR_WEBAUTHN_PROOF", detail: "the exact non-public WebAuthn assertion over repairProofHash must be produced only at later signing time and separately reviewed before repair calldata can be fixed" });
  }
  const actions = buildActions(input, initial, nativeFunding, initialUsdcFunding, recycledStepUpFunding, recycledDelayedFunding);
  const safeActionCount = BigInt(actions.filter((action) => action.proposedGasAndFee.gasLimit === input.proposedCaps.safeExecutionGasLimit.toString()).length);
  const delayActionCount = BigInt(actions.filter((action) => action.proposedGasAndFee.gasLimit === input.proposedCaps.publicDelayGasLimit.toString()).length);
  const fundingActionCount = BigInt(actions.filter((action) => action.proposedGasAndFee.gasLimit === input.proposedCaps.fundingGasLimit.toString()).length);
  const gasReservation = (safeActionCount * input.proposedCaps.safeExecutionGasLimit + delayActionCount * input.proposedCaps.publicDelayGasLimit + fundingActionCount * input.proposedCaps.fundingGasLimit) * input.proposedCaps.maxFeePerGas;
  const nativePrincipal = 30_000_000_000_001n;
  const gross = baselineActual + nativeFunding + nativePrincipal + gasReservation;
  if (gross > PHASE_OUTLAY_LIMIT) throw new Error("ordinary scenario gross phase outlay exceeds 0.05 Sepolia ETH");
  if (initial.nativeBalances[0] < nativeFunding + gasReservation) blockers.unshift({ code: "MISSING_NATIVE_INVENTORY", detail: "configured funder native balance does not cover planned funding value plus proposed gas reservations" });
  const finalHash = await client.blockHash(block.number);
  const finalState = await readState(input, client, block.number, usdc.token, recipient);
  if (!same(finalHash, block.hash)) throw new Error("ordinary scenario canonical block drift detected");
  if (canonical(initial) !== canonical(finalState)) throw new Error("ordinary scenario pinned state drift detected");
  const runtimeNames = ["safe", "guard", "delay", "maintenance", "primary", "safeContractSecondary", "ecdsaSecondary", "replacementContractSecondary"];
  const report: OrdinaryScenarioReviewReport = Object.freeze({
    schemaVersion: 1,
    status: blockers.length === 0 ? "READY_FOR_HUMAN_REVIEW" : "BLOCKED",
    authorization: "NONE",
    chainId: "11155111",
    planHash: planHash(input.plan),
    topologyEvidenceHash: sha256(input.topology),
    baselineEvidenceHash: sha256(input.baseline),
    snapshot: blockSnapshot(initial, block, input.plan),
    publicIdentities: Object.freeze({ safe: input.plan.safeProxyDeployment.expectedCreatedAddress, guard: input.plan.review.transactionGuard, delay: input.plan.review.modules[0], maintenance: input.plan.prerequisites.maintenance.expectedCreatedAddress, signers: input.signers, runtimeCodeHashes: Object.freeze(Object.fromEntries(initial.runtime.map((code, index) => [runtimeNames[index]!, code && code !== "0x" ? keccak256(code) : "0x"]))), observer: input.observer ?? null, repair: input.repair ?? null }),
    requiredInventory: Object.freeze({ nativeWei: requiredNative.toString(), usdcUnits: requiredUsdc.toString(), initialExternalUsdcUnits: initialExternalUsdc.toString(), grossUsdcFundingUnits: requiredUsdc.toString(), explanation: "20 initial external USDC units fund base X plus the contract-secondary row. Because the controlled recipient is the funder, canonical returns support an exact 10-unit top-up before the ECDSA row and an exact 1-unit top-up before delayed execution. Gross funding is 31, immediate cumulative spend is 30 at shared Y, and the delayed transaction is 1 unit. Funding does not reset counters or consume Safe/Delay nonces." }),
    blockers: Object.freeze(blockers.map((blocker) => Object.freeze(blocker))),
    actions,
    phaseAccounting: Object.freeze({ phaseLimitWei: PHASE_OUTLAY_LIMIT.toString(), prerequisiteAndSafeActualCostWei: baselineActual.toString(), nativeFundingValueWei: nativeFunding.toString(), nativeSafeTransferPrincipalWei: nativePrincipal.toString(), grossUsdcFundingUnits: grossUsdcFunding.toString(), proposedGasReservationWei: gasReservation.toString(), maximumGrossPhaseOutlayWei: gross.toString(), proposedCapsOnly: true, signedSimulationOrEstimateStatus: "NOT_RUN_REQUIRES_LATER_AUTHORIZED_PRE_SEND_GATE" }),
    finalRevalidation: Object.freeze({ blockHashRechecked: true, safeNonceRechecked: true, delayNonceRechecked: true, countersRechecked: true, balancesRechecked: true, runtimeIdentitiesRechecked: true }),
    signed: false,
    broadcast: false,
    liveEstimated: false,
  });
  const rendered = renderOrdinaryScenarioReview(report);
  return Object.freeze({ report, rendered, packageHash: sha256(report) as Hex });
}

export function renderOrdinaryScenarioReview(report: OrdinaryScenarioReviewReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
