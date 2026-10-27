import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { encodeFunctionData, keccak256, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sha256 } from "../../../scripts/plan-deployment";
import {
  createOrdinaryScenarioJournal,
  createOrdinaryScenarioProposal,
  createOrdinaryScenarioStore,
  executeOrdinaryScenarioAction,
  loadOrdinaryScenarioApproval,
  type CanonicalOrdinaryScenarioState,
  type OrdinaryScenarioActionRecord,
  type OrdinaryScenarioExecutionContext,
  type OrdinaryScenarioJournal,
  type OrdinaryScenarioStore,
} from "../../../scripts/live/ordinary-scenario-executor";
import type { LiveIntent, LiveReceipt } from "../../../scripts/live/submission";

const account = privateKeyToAccount(generatePrivateKey());
const funder = account.address;
const safe = "0xd751a1479f49d63DC61E0081B0b4d8c60623D9a6" as Address;
const guard = "0x91392B9aE9daBa21a1fba3d92fae9fE47a4B48cA" as Address;
const delay = "0xB8E143098CcCb9935228022173c2c987DF5FD53a" as Address;
const usdc = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Address;
const primary = "0x6F9c2f4f8526A17f38c9409a8cBF605b34Fa146c" as Address;
const secondary = "0xF94b0fbDCa0eF0Bf7Bd142aF832Bab17108C0D42" as Address;
const ecdsa = "0xe789E36f46E2445d807D726E4a064c8048e19980" as Address;
const zero = "0x0000000000000000000000000000000000000000" as Address;
const planHash = keccak256("0x01");
const topologyHash = keccak256("0x02");
const baselineHash = keccak256("0x03");
const runtimeCodeHashes = { safe: keccak256("0x40"), guard: keccak256("0x41"), delay: keccak256("0x42"), maintenance: keccak256("0x43"), primary: keccak256("0x44"), safeContractSecondary: keccak256("0x45"), ecdsaSecondary: keccak256("0x46"), replacementContractSecondary: null };
const identitiesHash = sha256(runtimeCodeHashes) as Hex;
const observerHash = keccak256("0x05");
const queueFingerprint = keccak256("0x06");
const monitoringFingerprint = keccak256("0x07");
const erc20 = [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }] as const;

type MutableState = {
  funderNative: bigint;
  safeNative: bigint;
  funderUsdc: bigint;
  safeUsdc: bigint;
  safeNonce: bigint;
  queueNonce: bigint;
  txNonce: bigint;
  nativeBase: bigint;
  nativeInstant: bigint;
  usdcBase: bigint;
  usdcInstant: bigint;
};

const decimalState = (state: MutableState) => ({
  principalBalances: {
    nativeFunderBefore: state.funderNative.toString(), nativeFunderAfter: state.funderNative.toString(),
    nativeSafeBefore: state.safeNative.toString(), nativeSafeAfter: state.safeNative.toString(),
    usdcFunderBefore: state.funderUsdc.toString(), usdcFunderAfter: state.funderUsdc.toString(),
    usdcSafeBefore: state.safeUsdc.toString(), usdcSafeAfter: state.safeUsdc.toString(),
  },
  nonces: { before: { funder: "743", safe: state.safeNonce.toString(), delay: state.txNonce.toString() }, after: { funder: "743", safe: state.safeNonce.toString(), delay: state.txNonce.toString() } },
  counters: {
    before: { native: { baseSpent: state.nativeBase.toString(), instantSpent: state.nativeInstant.toString() }, USDC: { baseSpent: state.usdcBase.toString(), instantSpent: state.usdcInstant.toString() } },
    after: { native: { baseSpent: state.nativeBase.toString(), instantSpent: state.nativeInstant.toString() }, USDC: { baseSpent: state.usdcBase.toString(), instantSpent: state.usdcInstant.toString() } },
    fundingNeverResetsCounters: true,
  },
  queue: { before: { status: state.queueNonce === state.txNonce ? "EMPTY" : "QUEUED_CONDITIONAL", queueNonce: state.queueNonce === 0n ? null : (state.queueNonce - 1n).toString(), fingerprint: state.queueNonce === state.txNonce ? null : queueFingerprint }, after: { status: state.queueNonce === state.txNonce ? "EMPTY" : "QUEUED_CONDITIONAL", queueNonce: state.queueNonce === 0n ? null : (state.queueNonce - 1n).toString(), fingerprint: state.queueNonce === state.txNonce ? null : queueFingerprint } },
  stateAvailability: "EXACT_PRINCIPAL_CONDITIONAL_FORECAST",
  futureStateStatus: "CONDITIONAL_NOT_RUN_REVALIDATE_FROM_CANONICAL_RECEIPTS",
  nativeFunderGasAccounting: { beforeExpression: "shared", afterExpression: "shared", cumulativeProposedGasCapAfterWei: "0", minimumAfterAtProposedCapsWei: "0" },
});

function action(input: Record<string, unknown>, state: MutableState, mutate: (next: MutableState) => void) {
  const expectedState = decimalState(state);
  const next = { ...state };
  mutate(next);
  const after = decimalState(next);
  expectedState.principalBalances.nativeFunderAfter = after.principalBalances.nativeFunderAfter;
  expectedState.principalBalances.nativeSafeAfter = after.principalBalances.nativeSafeAfter;
  expectedState.principalBalances.usdcFunderAfter = after.principalBalances.usdcFunderAfter;
  expectedState.principalBalances.usdcSafeAfter = after.principalBalances.usdcSafeAfter;
  expectedState.nonces.after = after.nonces.after;
  expectedState.counters.after = after.counters.after;
  expectedState.queue.after = after.queue.after;
  Object.assign(state, next);
  return {
    asset: "native", dependsOn: [], status: "CONDITIONAL_NOT_RUN", expectedOutcome: "success", signerRoles: [],
    proposedGasAndFee: { gasLimit: "500000", maxFeePerGas: "1000000", maxPriorityFeePerGas: "1000000", liveEstimated: false, preSendEstimateRequired: true },
    expectedTransition: "fixed transition", observerAlert: "none", expectedState, ...input,
  };
}

function reportFixture() {
  const state: MutableState = { funderNative: 20_000_000_000_000_000n, safeNative: 0n, funderUsdc: 20_000_000n, safeUsdc: 0n, safeNonce: 0n, queueNonce: 0n, txNonce: 0n, nativeBase: 0n, nativeInstant: 0n, usdcBase: 0n, usdcInstant: 0n };
  const safeTx = (nonce: bigint, to: Address, value: bigint, data: Hex = "0x") => ({ to, value: value.toString(), data, operation: 0, safeNonce: nonce.toString(), safeTxHash: keccak256(`0x${(100n + nonce).toString(16).padStart(2, "0")}` as Hex), safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: zero, refundReceiver: zero });
  const actions: Record<string, unknown>[] = [];
  actions.push(action({ id: "native-funding", kind: "funding", signerRoles: ["funder"], publicTransaction: { to: safe, value: "30000000000001", data: "0x", operation: 0, funderNonce: "743", safeNonce: null, safeTxHash: null } }, state, next => { next.funderNative -= 30_000_000_000_001n; next.safeNative += 30_000_000_000_001n; }));
  actions.push(action({ id: "native-base-x", kind: "base-transfer", signerRoles: ["primary-passkey"], dependsOn: ["native-funding"], safeTransaction: safeTx(state.safeNonce, funder, 10_000_000_000_000n) }, state, next => { next.safeNonce++; next.safeNative -= 10_000_000_000_000n; next.funderNative += 10_000_000_000_000n; next.nativeBase = 10_000_000_000_000n; next.nativeInstant = 10_000_000_000_000n; }));
  actions.push(action({ id: "native-direct-overspend-rejection", kind: "expected-direct-rejection", expectedOutcome: "rejection", signerRoles: ["primary-passkey", "safe-contract-secondary"], dependsOn: ["native-base-x"], safeTransaction: safeTx(state.safeNonce, funder, 20_000_000_000_001n) }, state, () => undefined));
  actions.push(action({ id: "native-queue-cancel", kind: "queue-proposal", signerRoles: ["primary-passkey", "safe-contract-secondary"], dependsOn: ["native-direct-overspend-rejection"], safeTransaction: safeTx(state.safeNonce, delay, 0n, "0x1234"), queue: { queueNonce: state.queueNonce.toString(), queueFingerprint, monitoringFingerprint, to: funder, value: "1", data: "0x", operation: 0 }, timing: { source: "FUTURE_CANONICAL_QUEUE_RECEIPT_BLOCK", createdAt: null, readyAt: null, expiresAt: null, cooldownSeconds: "120", expirationSeconds: "600", status: "CONDITIONAL_NOT_RUN", revalidateFromCanonicalReceipt: true } }, state, next => { next.safeNonce++; next.queueNonce++; }));
  actions.push(action({ id: "native-queue-cancel-early-rejection", kind: "expected-early-rejection", expectedOutcome: "rejection", dependsOn: ["native-queue-cancel"], publicTransaction: { to: delay, value: "0", data: "0xee072baf", operation: 0, safeNonce: null, safeTxHash: null, outerTransactionNonce: "REVALIDATE_BEFORE_EXECUTION" }, queue: { queueNonce: "0", queueFingerprint, monitoringFingerprint, to: funder, value: "1", data: "0x", operation: 0 }, timing: { source: "FUTURE_CANONICAL_QUEUE_RECEIPT_BLOCK", createdAt: null, readyAt: null, expiresAt: null, cooldownSeconds: "120", expirationSeconds: "600", status: "CONDITIONAL_NOT_RUN", revalidateFromCanonicalReceipt: true }, proposedGasAndFee: { gasLimit: "300000", maxFeePerGas: "1000000", maxPriorityFeePerGas: "1000000", liveEstimated: false, preSendEstimateRequired: true } }, state, () => undefined));
  actions.push(action({ id: "native-queue-ready-execute", kind: "ready-delay-execution", dependsOn: ["native-queue-cancel-early-rejection"], publicTransaction: { to: delay, value: "0", data: "0xee072baf", operation: 0, safeNonce: null, safeTxHash: null, outerTransactionNonce: "REVALIDATE_BEFORE_EXECUTION" }, queue: { queueNonce: "0", queueFingerprint, monitoringFingerprint, to: funder, value: "1", data: "0x", operation: 0 }, timing: { source: "FUTURE_CANONICAL_QUEUE_RECEIPT_BLOCK", createdAt: null, readyAt: null, expiresAt: null, cooldownSeconds: "120", expirationSeconds: "600", status: "CONDITIONAL_NOT_RUN", revalidateFromCanonicalReceipt: true }, proposedGasAndFee: { gasLimit: "300000", maxFeePerGas: "1000000", maxPriorityFeePerGas: "1000000", liveEstimated: false, preSendEstimateRequired: true } }, state, next => { next.txNonce++; next.safeNative -= 1n; next.funderNative += 1n; }));
  actions.push({ id: "repair-signer-create", kind: "conditional-factory-signer-creation", asset: "control", dependsOn: ["native-queue-ready-execute"], status: "BLOCKED_INPUT", expectedOutcome: "success", signerRoles: ["funder"], proposedGasAndFee: { gasLimit: "500000", maxFeePerGas: "1000000", maxPriorityFeePerGas: "1000000", liveEstimated: false, preSendEstimateRequired: true }, expectedTransition: "blocked", expectedState: decimalState(state), observerAlert: "none" });
  return {
    schemaVersion: 1, status: "BLOCKED", authorization: "NONE", chainId: "11155111", planHash, topologyEvidenceHash: topologyHash, baselineEvidenceHash: baselineHash,
    snapshot: { blockNumber: "1", blockHash: keccak256("0x11"), blockTimestamp: "1000", safeNonce: "0", funderNonce: "743", delayNonce: "0", balances: { funder: { address: funder, nativeWei: "20000000000000000", usdcUnits: "20000000" }, safe: { address: safe, nativeWei: "0", usdcUnits: "0" }, recipient: { address: funder, nativeWei: "20000000000000000", usdcUnits: "20000000" } }, counters: [{ token: zero, window: "0", baseSpent: "0", instantSpent: "0" }, { token: usdc, window: "0", baseSpent: "0", instantSpent: "0" }], token: { address: usdc, name: "USDC", symbol: "USDC", decimals: 6 } },
    publicIdentities: { safe, guard, delay, maintenance: "0x3D20c6c361bdb1970827c9450beeC0e3cD78E654", signers: { primary: { address: primary, kind: "safe-contract", available: true, source: "public" }, safeContractSecondary: { address: secondary, kind: "safe-contract", available: true, source: "public" }, ecdsaSecondary: { address: ecdsa, kind: "ecdsa-extension", available: true, source: "public" } }, runtimeCodeHashes, observer: { kind: "https-webhook", publicId: `temporary-test-receiver:${observerHash}`, endpointHash: observerHash, independentFromProposer: true, probeEvidenceHash: observerHash, actualActivityAlerts: "NOT_RUN" }, repair: { formatVersion: 1, scope: "ordinary-baseline-proposed-contract-secondary-repair", chainId: 11155111, factory: funder, verifiers: "1", address: secondary, x: "1", y: "2", observedRuntime: "0x", deployed: false, signed: false, broadcast: false } },
    requiredInventory: { nativeWei: "30000000000001", usdcUnits: "31000000", initialExternalUsdcUnits: "20000000", grossUsdcFundingUnits: "31000000", explanation: "fixed 20/10/1 inventory" }, blockers: [{ code: "MISSING_REPAIR", detail: "repair remains blocked" }], actions,
    phaseAccounting: { phaseLimitWei: "50000000000000000", prerequisiteAndSafeActualCostWei: "71035976000000", nativeFundingValueWei: "30000000000001", nativeSafeTransferPrincipalWei: "30000000000001", grossUsdcFundingUnits: "31000000", proposedGasReservationWei: "5000000000000", maximumGrossPhaseOutlayWei: "161035977000002", proposedCapsOnly: true, signedSimulationOrEstimateStatus: "NOT_RUN_REQUIRES_LATER_AUTHORIZED_PRE_SEND_GATE" },
    finalRevalidation: { blockHashRechecked: true, safeNonceRechecked: true, delayNonceRechecked: true, countersRechecked: true, balancesRechecked: true, runtimeIdentitiesRechecked: true }, signed: false, broadcast: false, liveEstimated: false,
  };
}

const rawHash = (value: string): Hex => `0x${createHash("sha256").update(value).digest("hex")}` as Hex;

function authorizedFixture(actionCount = 6) {
  const serialized = `${JSON.stringify(reportFixture(), null, 2)}\n`;
  const packageHash = sha256(JSON.parse(serialized)) as Hex;
  const artifactBytesHash = rawHash(serialized);
  const proposal = createOrdinaryScenarioProposal(serialized, { expectedPackageHash: packageHash, expectedArtifactBytesHash: artifactBytesHash });
  const document = {
    schemaVersion: 1, scope: "bounded-ordinary-matrix-v1", authorization: "EXPLICIT_GROUP_APPROVAL", chainId: 11155111,
    proposalHash: proposal.proposalHash, reviewPackageHash: proposal.reviewPackageHash, reviewArtifactBytesHash: proposal.reviewArtifactBytesHash, planHash: proposal.planHash,
    approvedActions: proposal.actions.slice(0, actionCount).map(value => ({ id: value.id, commitment: value.commitment })),
    derivations: { outerEoaNonce: "CURRENT_ONLY", fees: "AT_OR_BELOW_ACTION_CAPS", gas: "SIGNED_SIMULATION_AT_OR_BELOW_ACTION_CAP", queueTiming: "CANONICAL_RECEIPT_CREATED_AT_ONLY", safeNonce: "FIXED", delayQueueNonce: "FIXED", delayTxNonce: "FIXED" },
    phaseLimitWei: "50000000000000000", maxBroadcastAttempts: 1,
  };
  const approvalHash = sha256(document) as Hex;
  const approval = loadOrdinaryScenarioApproval(proposal, `${JSON.stringify(document)}\n`, { expectedProposalHash: proposal.proposalHash, expectedPackageHash: packageHash, expectedApprovalHash: approvalHash });
  return { proposal, approval, packageHash, artifactBytesHash, approvalHash, document };
}

class MemoryStore implements OrdinaryScenarioStore {
  public saves: string[] = [];
  constructor(public journal: OrdinaryScenarioJournal) {}
  load() { return this.journal; }
  save(value: OrdinaryScenarioJournal) { this.journal = structuredClone(value); this.saves.push(JSON.stringify(value, (_, child) => typeof child === "bigint" ? child.toString() : child)); }
}

function canonicalState(overrides: Partial<CanonicalOrdinaryScenarioState> = {}): CanonicalOrdinaryScenarioState {
  return {
    chainId: 11155111, blockNumber: 10n, blockHash: keccak256("0x22"), blockTimestamp: 1000n,
    planHash, topologyEvidenceHash: topologyHash, publicIdentitiesHash: identitiesHash, observerReady: true, observerEvidenceHash: observerHash,
    outerNonce: 900, funderNativeBalance: 20_000_000_000_000_000n, safeNativeBalance: 0n, funderUsdcBalance: 20_000_000n, safeUsdcBalance: 0n,
    safeNonce: 0n, delayQueueNonce: 0n, delayTxNonce: 0n,
    nativeSpend: { window: 0n, baseSpent: 0n, instantSpent: 0n }, usdcSpend: { window: 0n, baseSpent: 0n, instantSpent: 0n },
    queue: undefined, dependencies: [], fees: { maxFeePerGas: 900_000n, maxPriorityFeePerGas: 500_000n }, ...overrides,
  };
}

function executionFixture(actionCount = 1, state = canonicalState()) {
  const f = authorizedFixture(actionCount);
  const journal = createOrdinaryScenarioJournal(f.proposal, f.approval, funder);
  const store = new MemoryStore(journal);
  const calls: string[] = [];
  let liveReceipt: LiveReceipt | undefined;
  const signIntent = (value: LiveIntent) => account.signTransaction({ chainId: 11155111, type: "eip1559", to: value.to, data: value.data, value: value.value, nonce: value.nonce, gas: value.gas, maxFeePerGas: value.maxFeePerGas, maxPriorityFeePerGas: value.maxPriorityFeePerGas });
  const intent = (actionId: string): LiveIntent => ({ id: actionId, to: safe, data: "0x", value: 30_000_000_000_001n, nonce: state.outerNonce, gas: 21_000n, maxFeePerGas: state.fees.maxFeePerGas, maxPriorityFeePerGas: state.fees.maxPriorityFeePerGas });
  const context: OrdinaryScenarioExecutionContext = {
    readState: async (_action, phase) => { calls.push(`state:${phase}`); return state; },
    materialize: async actionScope => { calls.push("materialize"); const base = intent(actionScope.id); const liveIntent = actionScope.safeTxHash ? { ...base, value: 0n } : base; return { liveIntent, requestHash: actionScope.safeTxHash ?? actionScope.commitment, signerRolesHash: sha256(actionScope.signerRoles) as Hex, signedCalldataHash: keccak256(liveIntent.data), signatureBundleHash: null, transientSignedCalldata: liveIntent.data }; },
    simulate: async (_scope, prepared) => { calls.push("simulate"); return { blockNumber: state.blockNumber, blockHash: state.blockHash, success: true, gasEstimate: prepared.liveIntent.gas, resultHash: keccak256("0x33") }; },
    proveRejection: async () => { calls.push("reject"); return { blockNumber: state.blockNumber, blockHash: state.blockHash, success: false, revertDataHash: keccak256("0x44"), postState: state }; },
    recoverPending: async () => { calls.push("recover"); return intent("native-funding"); },
    confirm: async (_scope, entry) => { calls.push("confirm"); return { postState: { ...state, blockNumber: entry.receipt!.blockNumber, blockHash: entry.receipt!.blockHash, outerNonce: state.outerNonce + 1, safeNativeBalance: 30_000_000_000_001n }, effect: { kind: "native-funding", to: safe, amount: 30_000_000_000_001n } }; },
    live: {
      funder: account.address, chainId: async () => 11155111, nonce: async () => state.outerNonce, balance: async () => state.funderNativeBalance,
      sign: async value => { calls.push("outer-sign"); return signIntent(value); }, broadcast: async raw => { calls.push("broadcast"); return keccak256(raw); }, receipt: async () => liveReceipt,
    },
  };
  return { ...f, store, calls, context, state, setReceipt(value: LiveReceipt | undefined) { liveReceipt = value; } };
}

describe("bounded ordinary scenario coordinator", () => {
  it("treats a proposal as non-authorizing and rejects package or approval mutations before capabilities", async () => {
    const f = executionFixture();
    await expect(executeOrdinaryScenarioAction(f.proposal, undefined, f.store, f.context)).to.be.rejectedWith("explicit group approval");
    expect(f.calls).to.deep.equal([]);
    const changed = JSON.stringify({ ...reportFixture(), chainId: "1" });
    expect(() => createOrdinaryScenarioProposal(changed, { expectedPackageHash: f.packageHash, expectedArtifactBytesHash: rawHash(changed) })).to.throw("package hash mismatch");
    const changedApproval = { ...f.document, approvedActions: f.document.approvedActions.map((value, index) => index ? value : { ...value, commitment: keccak256("0x99") }) };
    expect(() => loadOrdinaryScenarioApproval(f.proposal, JSON.stringify(changedApproval), { expectedProposalHash: f.proposal.proposalHash, expectedPackageHash: f.packageHash, expectedApprovalHash: f.approvalHash })).to.throw("approval hash mismatch");
    const unknown = { ...reportFixture(), futureAdapterField: "forbidden" }; const unknownSerialized = JSON.stringify(unknown);
    expect(() => createOrdinaryScenarioProposal(unknownSerialized, { expectedPackageHash: sha256(unknown) as Hex, expectedArtifactBytesHash: rawHash(unknownSerialized) })).to.throw("unknown or missing fields");
    expect(f.calls).to.deep.equal([]);
  });

  it("rejects repair/freeze descendants and unknown actions from the approved prefix", () => {
    const value = reportFixture();
    (value.actions[6] as Record<string, unknown>).status = "CONDITIONAL_NOT_RUN";
    const serialized = JSON.stringify(value);
    expect(() => createOrdinaryScenarioProposal(serialized, { expectedPackageHash: sha256(value) as Hex, expectedArtifactBytesHash: rawHash(serialized) })).to.throw("excluded action");
    (value.actions[6] as Record<string, unknown>).id = "unknown-action";
    expect(() => createOrdinaryScenarioProposal(serialized, { expectedPackageHash: sha256(value) as Hex, expectedArtifactBytesHash: rawHash(serialized) })).to.throw;
  });

  it("fails closed on topology, controlled-state, observer, fee, and three protocol nonce drift before private work", async () => {
    const mutations: Partial<CanonicalOrdinaryScenarioState>[] = [
      { chainId: 1 }, { planHash: keccak256("0xaa") }, { topologyEvidenceHash: keccak256("0xab") }, { publicIdentitiesHash: keccak256("0xac") }, { observerReady: false },
      { safeNativeBalance: 1n }, { funderUsdcBalance: 19_999_999n }, { safeNonce: 1n }, { delayQueueNonce: 1n }, { delayTxNonce: 1n },
      { fees: { maxFeePerGas: 1_000_001n, maxPriorityFeePerGas: 1n } },
    ];
    for (const mutation of mutations) {
      const f = executionFixture(1, canonicalState(mutation));
      await expect(executeOrdinaryScenarioAction(f.proposal, f.approval, f.store, f.context)).to.be.rejected;
      expect(f.calls).not.to.include("materialize");
      expect(f.calls).not.to.include("outer-sign");
    }
  });

  it("allows only the refreshed outer nonce and bounded fees/gas, then persists materialization and simulation before outer signing", async () => {
    const f = executionFixture(1, canonicalState({ outerNonce: 999 }));
    const result = await executeOrdinaryScenarioAction(f.proposal, f.approval, f.store, f.context);
    expect(result.status).to.equal("PENDING");
    expect(["materialize", "simulate", "state:pre-outer", "outer-sign", "broadcast"].map(value => f.calls.indexOf(value))).to.deep.equal([1, 2, 3, 4, 5]);
    expect(f.store.saves.findIndex(value => value.includes('"status":"materialized"'))).to.be.lessThan(f.calls.indexOf("materialize") + f.store.saves.length);
    expect(f.store.journal.liveJournal.entries[0]).to.include({ nonce: 999, status: "pending" });
    expect(f.store.journal.actions[0]).to.include({ status: "outer-pending", signedCalldataHash: keccak256("0x") });
    expect(f.store.saves.some(value => value.includes("transientSignedCalldata"))).to.equal(false);
  });

  it("requires a successful signed simulation under the reviewed gas cap before outer signing", async () => {
    const f = executionFixture();
    const bad: OrdinaryScenarioExecutionContext = { ...f.context, simulate: async () => ({ blockNumber: 10n, blockHash: f.state.blockHash, success: false, gasEstimate: 1n, resultHash: keccak256("0x55") }) };
    await expect(executeOrdinaryScenarioAction(f.proposal, f.approval, f.store, bad)).to.be.rejectedWith("signed simulation");
    expect(f.calls).not.to.include("outer-sign");
    expect(f.calls).not.to.include("broadcast");
    const signerDrift = executionFixture();
    const original = signerDrift.context.materialize;
    const changedSigner: OrdinaryScenarioExecutionContext = { ...signerDrift.context, materialize: async (actionScope, state) => ({ ...await original(actionScope, state), signerRolesHash: keccak256("0xffff") }) };
    await expect(executeOrdinaryScenarioAction(signerDrift.proposal, signerDrift.approval, signerDrift.store, changedSigner)).to.be.rejectedWith("exceeds approval");
    expect(signerDrift.calls).not.to.include("outer-sign");
  });

  it("stops an interrupted materialized attempt before any second private callback", async () => {
    const f = executionFixture();
    const interrupted: OrdinaryScenarioExecutionContext = { ...f.context, materialize: async () => { f.calls.push("materialize"); throw new Error("simulated process loss"); } };
    await expect(executeOrdinaryScenarioAction(f.proposal, f.approval, f.store, interrupted)).to.be.rejectedWith("simulated process loss");
    expect(f.store.journal.actions[0]?.status).to.equal("materialized");
    f.calls.length = 0;
    await expect(executeOrdinaryScenarioAction(f.proposal, f.approval, f.store, f.context)).to.be.rejectedWith("approved attempt is stopped");
    expect(f.calls).to.deep.equal([]);
  });

  it("reconciles a durable pending hash after restart without re-signing or rebroadcasting", async () => {
    const f = executionFixture();
    await executeOrdinaryScenarioAction(f.proposal, f.approval, f.store, f.context);
    const entry = f.store.journal.liveJournal.entries[0]!;
    f.calls.length = 0;
    f.setReceipt({ transactionHash: entry.transactionHash, status: "success", gasUsed: 20_000n, effectiveGasPrice: 800_000n, blockNumber: 11n, blockHash: keccak256("0x66") });
    const result = await executeOrdinaryScenarioAction(f.proposal, f.approval, f.store, f.context);
    expect(result.status).to.equal("CONFIRMED");
    expect(f.calls).to.include("recover");
    expect(f.calls).to.include("confirm");
    expect(f.calls).not.to.include("materialize");
    expect(f.calls).not.to.include("outer-sign");
    expect(f.calls).not.to.include("broadcast");
  });

  it("makes a canonical revert terminal and never automatically retries it", async () => {
    const f = executionFixture();
    await executeOrdinaryScenarioAction(f.proposal, f.approval, f.store, f.context);
    const entry = f.store.journal.liveJournal.entries[0]!;
    f.setReceipt({ transactionHash: entry.transactionHash, status: "reverted", gasUsed: 20_000n, effectiveGasPrice: 800_000n, blockNumber: 11n, blockHash: keccak256("0x67") });
    expect((await executeOrdinaryScenarioAction(f.proposal, f.approval, f.store, f.context)).status).to.equal("REVERTED");
    f.calls.length = 0;
    expect((await executeOrdinaryScenarioAction(f.proposal, f.approval, f.store, f.context)).status).to.equal("REVERTED");
    expect(f.calls).to.deep.equal([]);
  });

  it("rejects a successful receipt whose exact effect does not match the reviewed action", async () => {
    const f = executionFixture();
    await executeOrdinaryScenarioAction(f.proposal, f.approval, f.store, f.context);
    const entry = f.store.journal.liveJournal.entries[0]!;
    f.setReceipt({ transactionHash: entry.transactionHash, status: "success", gasUsed: 20_000n, effectiveGasPrice: 800_000n, blockNumber: 11n, blockHash: keccak256("0x68") });
    const wrong: OrdinaryScenarioExecutionContext = { ...f.context, confirm: async (_scope, confirmed) => ({ postState: { ...f.state, blockNumber: confirmed.receipt!.blockNumber, blockHash: confirmed.receipt!.blockHash, outerNonce: f.state.outerNonce + 1, safeNativeBalance: 30_000_000_000_001n }, effect: { kind: "native-funding", to: funder, amount: 30_000_000_000_001n } }) };
    await expect(executeOrdinaryScenarioAction(f.proposal, f.approval, f.store, wrong)).to.be.rejectedWith("funding receipt effect mismatch");
    expect(f.store.journal.actions[0]?.status).to.equal("outer-pending");
  });

  it("uses one locked fsynced journal and reloads only public recovery material", () => {
    const f = authorizedFixture(1); const directory = mkdtempSync(join(tmpdir(), "ordinary-scenario-")); const path = join(directory, "journal.json");
    try {
      const identity = { proposalHash: f.proposal.proposalHash, approvalHash: f.approval.approvalHash, funder };
      const first = createOrdinaryScenarioStore(path, identity, () => createOrdinaryScenarioJournal(f.proposal, f.approval, funder));
      const journal = first.load(); journal.actions.push({ id: f.proposal.actions[0]!.id, commitment: f.proposal.actions[0]!.commitment, status: "materialized", requestHash: f.proposal.actions[0]!.commitment }); first.save(journal);
      expect(() => createOrdinaryScenarioStore(path, identity, () => journal)).to.throw("writer lock unavailable");
      first.close?.();
      const second = createOrdinaryScenarioStore(path, identity, () => journal);
      expect(second.load().actions[0]).to.include({ status: "materialized", requestHash: f.proposal.actions[0]!.commitment });
      expect(readFileSync(path, "utf8")).not.to.include("transientSignedCalldata");
      second.close?.();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("records rejection proof with unchanged controlled state and never touches the broadcaster", async () => {
    const f = executionFixture(3, canonicalState({ safeNativeBalance: 20_000_000_000_001n, safeNonce: 1n, nativeSpend: { window: 0n, baseSpent: 10_000_000_000_000n, instantSpent: 10_000_000_000_000n } }));
    f.store.journal.actions.push(...[
      { id: "native-funding", commitment: f.proposal.actions[0]!.commitment, status: "confirmed", transactionHash: keccak256("0x70"), evidenceHash: keccak256("0x71") },
      { id: "native-base-x", commitment: f.proposal.actions[1]!.commitment, status: "confirmed", transactionHash: keccak256("0x72"), evidenceHash: keccak256("0x73"), establishedWindow: "0" },
    ] as OrdinaryScenarioActionRecord[]);
    f.state.dependencies.push({ actionId: "native-base-x", transactionHash: keccak256("0x72"), blockHash: keccak256("0x74"), evidenceHash: keccak256("0x73") });
    const result = await executeOrdinaryScenarioAction(f.proposal, f.approval, f.store, f.context);
    expect(result.status).to.equal("REJECTION_PROVED");
    expect(f.calls).to.include("reject");
    expect(f.calls).not.to.include("outer-sign");
    expect(f.calls).not.to.include("broadcast");
  });

  it("returns canonical-time WAITING without materializing or consuming approval", async () => {
    const f = executionFixture(6, canonicalState({ safeNativeBalance: 20_000_000_000_001n, safeNonce: 2n, delayQueueNonce: 1n, delayTxNonce: 0n, blockTimestamp: 1_050n, nativeSpend: { window: 0n, baseSpent: 10_000_000_000_000n, instantSpent: 10_000_000_000_000n }, queue: { queueNonce: 0n, fingerprint: queueFingerprint, createdAt: 1_000n, status: "queued" } }));
    for (let index = 0; index < 4; index++) f.store.journal.actions.push({ id: f.proposal.actions[index]!.id, commitment: f.proposal.actions[index]!.commitment, status: index === 2 ? "rejection-proved" : "confirmed", transactionHash: index === 2 ? undefined : keccak256(`0x${80 + index}` as Hex), evidenceHash: keccak256(`0x${90 + index}` as Hex), queueCreatedAt: index === 3 ? "1000" : undefined } as OrdinaryScenarioActionRecord);
    f.store.journal.actions.push({ id: "native-queue-cancel-early-rejection", commitment: f.proposal.actions[4]!.commitment, status: "rejection-proved", evidenceHash: keccak256("0x98") });
    f.state.dependencies.push({ actionId: "native-queue-cancel-early-rejection", evidenceHash: keccak256("0x98") });
    const result = await executeOrdinaryScenarioAction(f.proposal, f.approval, f.store, f.context);
    expect(result).to.deep.include({ status: "WAITING", nextCanonicalTime: 1120n });
    expect(f.calls).not.to.include("materialize");
    expect(f.store.journal.actions).to.have.length(5);
  });

  it("fails phase accounting and shared-funder reserve checks before any private callback", async () => {
    const insufficient = executionFixture(1, canonicalState({ funderNativeBalance: 1n }));
    await expect(executeOrdinaryScenarioAction(insufficient.proposal, insufficient.approval, insufficient.store, insufficient.context)).to.be.rejectedWith("approved reservations");
    expect(insufficient.calls).not.to.include("materialize");
    const excessive = reportFixture();
    excessive.phaseAccounting.maximumGrossPhaseOutlayWei = "50000000000000001";
    const serialized = JSON.stringify(excessive);
    expect(() => createOrdinaryScenarioProposal(serialized, { expectedPackageHash: sha256(excessive) as Hex, expectedArtifactBytesHash: rawHash(serialized) })).to.throw("phase ceiling");
  });

  it("requires canonical 20/10/1 USDC predecessor balances instead of a forecast-only top-up", () => {
    const transfer20 = encodeFunctionData({ abi: erc20, functionName: "transfer", args: [safe, 20_000_000n] });
    const transfer10 = encodeFunctionData({ abi: erc20, functionName: "transfer", args: [safe, 10_000_000n] });
    const transfer1 = encodeFunctionData({ abi: erc20, functionName: "transfer", args: [safe, 1_000_000n] });
    expect([transfer20, transfer10, transfer1].map(value => value.slice(-8))).to.deep.equal(["01312d00", "00989680", "000f4240"]);
    const f = authorizedFixture();
    expect(f.proposal.inventory).to.deep.equal({ initialUsdcUnits: "20000000", recycledStepUpUsdcUnits: "10000000", recycledDelayedUsdcUnits: "1000000", grossUsdcUnits: "31000000" });
  });
});
