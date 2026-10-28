import { decodeAbiParameters, decodeFunctionData, encodeFunctionData, hashTypedData, keccak256, toFunctionSelector, type Address, type Hex } from "viem";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createOrdinaryScenarioProposal, createOrdinaryScenarioStore, PRODUCTION_ORDINARY_SCENARIO_DOMAIN, type OrdinaryScenarioJournal, type OrdinaryScenarioProposalDomain } from "./ordinary-scenario-executor";
import { submitLiveIntent, type JournalEntry, type LiveContext, type LiveIntent, type LiveJournal } from "./submission";
import { SAFE_TX_TYPES } from "../../src/signers/types";
import {
  REPAIR_MAX_APPROVAL_WAIT_MS,
  assertRepairBaselineUnchanged,
  assertRepairCreationState,
  assertRepairQueueTiming,
  assertRepairApproval,
  assertRepairActionState,
  bindRepairCreationApproval,
  createRepairCreationProposal,
  createRepairGroupProposal,
  createRepairPrepareAuthorization,
  extendJournalForRepair,
  loadRepairApproval,
  loadRepairCreationProposal,
  loadRepairGroupProposal,
  recordRepairCreationConfirmation,
  repairOriginalIdentityHash,
  validateRepairCreationReceiptLogs,
  validateRepairCreationSimulation,
  verifyRepairPredecessor,
  type RepairCanonicalState,
  type RepairCreationQuote,
  type RepairCreationProposal,
  type RepairGroupProposal,
  type RepairExecutionDomain,
  PRODUCTION_REPAIR_EXECUTION_DOMAIN,
  type TransientRepairGroup,
} from "./ordinary-scenario-repair";
import { createOrdinaryScenarioProductionHarness } from "./ordinary-scenario-executor-cli";
import type { OrdinaryScenarioProductionHarness } from "./ordinary-scenario-executor-cli";
import { runOperationalCliEntryPoint, type OperationalCliOutput } from "./operational-cli-entrypoint";
import { createRepairAdapterDescriptor, createRepairProductionAdapter, hasExactRepairRevert, type RepairProductionAdapter } from "./ordinary-scenario-repair-adapter";
import { loadObserverConfirmationEvidence } from "./ordinary-scenario-adapter";
import {
  assertContinuationObserverFresh,
  createHashlessContinuationProductionDependencies,
  loadHashlessContinuationPublicInputs,
  parseHashlessContinuationCliArguments,
  type HashlessContinuationPublicInputs,
} from "./ordinary-scenario-hashless-continuation-cli";
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const SAFE_ABI = [{ type: "function", name: "execTransaction", stateMutability: "payable", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }, { name: "operation", type: "uint8" }, { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" }, { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" }, { name: "signatures", type: "bytes" }], outputs: [{ type: "bool" }] }] as const;
const ERC1271_ABI = [{ type: "function", name: "isValidSignature", stateMutability: "view", inputs: [{ type: "bytes32", name: "hash" }, { type: "bytes", name: "signature" }], outputs: [{ type: "bytes4" }] }] as const;
const INVALID_SECONDARY_SIGNATURE = toFunctionSelector("InvalidSecondarySignature()").toLowerCase();
export type RepairQueueSessionInput<Credential> = Readonly<{
  creation: RepairCreationProposal;
  journal: OrdinaryScenarioJournal;
  domain?: import("./ordinary-scenario-repair").RepairExecutionDomain;
  lineage?: Readonly<{ kind: "expired-hashless-continuation-v1"; continuation: import("./ordinary-scenario-hashless-continuation").ExpiredHashlessContinuationProposal; approval: import("./ordinary-scenario-hashless-continuation").ExpiredHashlessContinuationApproval }>;
  maxApprovalWaitMs: number;
  publicPreflight(): Promise<RepairCanonicalState>;
  awaitPrepareAuthorization(authorization: ReturnType<typeof createRepairPrepareAuthorization>): Promise<boolean>;
  loadReplacementCredential(): Promise<Credential>;
  signReplacementProof(credential: Credential, proofHash: Hex): Promise<Hex>;
  verifyReplacementProof(proofHash: Hex, assertion: Hex, blockNumber: bigint): Promise<Hex>;
  publishSanitizedProposal(proposal: RepairGroupProposal): Promise<void>;
  awaitExactApproval(proposal: RepairGroupProposal): Promise<Readonly<{ raw: string; hash: Hex }>>;
  persistJournal(journal: OrdinaryScenarioJournal): Promise<void>;
  materializeSafeTransaction(proposal: RepairGroupProposal, transient: TransientRepairGroup): Promise<Readonly<{ signedSafeCalldata: Hex; liveIntent: LiveIntent }>>;
  simulate(signedSafeCalldata: Hex, proposal: RepairGroupProposal): Promise<Readonly<{ gasEstimate: bigint; success: boolean }>>;
  submit?(intent: LiveIntent, journal: LiveJournal, live: LiveContext): Promise<JournalEntry>;
  live: LiveContext;
}>;

export type RepairQueueSessionResult = Readonly<{ status: "PENDING"; transactionHash: Hex; proposalHash: Hex; approvalHash: Hex }>;

const timeout = async <T>(promise: Promise<T>, milliseconds: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("repair exact approval timed out")), milliseconds); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
};

function sameState(before: RepairCanonicalState, after: RepairCanonicalState): boolean {
  return before.chainId === after.chainId && before.safeNonce === after.safeNonce && before.delayQueueNonce === after.delayQueueNonce && before.delayTxNonce === after.delayTxNonce && before.safeContractSecondary.toLowerCase() === after.safeContractSecondary.toLowerCase() && before.candidateRuntimeCodeHash.toLowerCase() === after.candidateRuntimeCodeHash.toLowerCase() && before.candidateBindingHash.toLowerCase() === after.candidateBindingHash.toLowerCase() && before.policyHash.toLowerCase() === after.policyHash.toLowerCase() && before.frozen === after.frozen && before.nativeWindow === after.nativeWindow && before.nativeBaseSpent === after.nativeBaseSpent && before.nativeInstantSpent === after.nativeInstantSpent && before.usdcWindow === after.usdcWindow && before.usdcBaseSpent === after.usdcBaseSpent && before.usdcInstantSpent === after.usdcInstantSpent && before.nativeBalance === after.nativeBalance && before.usdcBalance === after.usdcBalance && before.observerReady === after.observerReady;
}

function validateSignedRepairQueue(proposal: RepairGroupProposal, transient: TransientRepairGroup, signedSafeCalldata: Hex, intent: LiveIntent): void {
  let decoded: ReturnType<typeof decodeFunctionData>;
  try { decoded = decodeFunctionData({ abi: SAFE_ABI, data: signedSafeCalldata }); } catch { throw new Error("repair signed calldata is not Safe execTransaction"); }
  if (decoded.functionName !== "execTransaction") throw new Error("repair signed calldata selector mismatch");
  const args = decoded.args as readonly [Address, bigint, Hex, number, bigint, bigint, bigint, Address, Address, Hex];
  const expected = proposal.actions[0]!;
  if (args[0].toLowerCase() !== proposal.delay.toLowerCase() || args[1] !== 0n || args[2].toLowerCase() !== transient.safeTransactionData.toLowerCase() || args[3] !== 0 || args[4] !== 0n || args[5] !== 0n || args[6] !== 0n || args[7].toLowerCase() !== ZERO || args[8].toLowerCase() !== ZERO || args[9] === "0x") throw new Error("repair decoded Safe tuple/signatures drift");
  const safeTxHash = hashTypedData({ domain: { chainId: proposal.chainId, verifyingContract: proposal.safe }, types: { SafeTx: SAFE_TX_TYPES }, primaryType: "SafeTx", message: { to: args[0], value: args[1], data: args[2], operation: 0, safeTxGas: args[4], baseGas: args[5], gasPrice: args[6], gasToken: args[7], refundReceiver: args[8], nonce: BigInt(expected.safeNonceBefore) } });
  if (!expected.safeTxHash || safeTxHash.toLowerCase() !== expected.safeTxHash.toLowerCase() || intent.id !== "repair-queue" || !intent.to || intent.to.toLowerCase() !== proposal.safe.toLowerCase() || intent.value !== 0n || intent.data.toLowerCase() !== signedSafeCalldata.toLowerCase() || intent.gas <= 0n || intent.gas > 2_000_000n || intent.maxFeePerGas > 1_000_000n || intent.maxPriorityFeePerGas > 1_000_000n || keccak256(args[2]).toLowerCase() !== expected.requestDataHash.toLowerCase()) throw new Error("repair signed Safe request exceeds exact approval");
}

/**
 * One proof, one exact proposal, one exact approval, one submit attempt. The
 * proof and calldata never leave this stack frame through a persistence API.
 */
export async function runRepairQueueSession<Credential>(input: RepairQueueSessionInput<Credential>): Promise<RepairQueueSessionResult> {
  if (!Number.isSafeInteger(input.maxApprovalWaitMs) || input.maxApprovalWaitMs <= 0 || input.maxApprovalWaitMs > REPAIR_MAX_APPROVAL_WAIT_MS) throw new Error("repair approval wait exceeds the 600000ms bound");
  const before = await input.publicPreflight();
  const prepare = createRepairPrepareAuthorization({ creation: input.creation, state: before, purpose: "materialize-one-repair-proof", domain: input.domain });
  if (!await timeout(input.awaitPrepareAuthorization(prepare), input.maxApprovalWaitMs)) throw new Error("repair proof preparation was not authorized");
  let assertion: Hex | undefined;
  let transient: TransientRepairGroup | undefined;
  let approvedRecord: NonNullable<OrdinaryScenarioJournal["repairContinuation"]>["actions"][number] | undefined;
  try {
    const credential = await input.loadReplacementCredential();
    assertion = await input.signReplacementProof(credential, prepare.proofHash);
    if (await input.verifyReplacementProof(prepare.proofHash, assertion, before.blockNumber) !== "0x1626ba7e") throw new Error("repair replacement ERC1271 proof is invalid");
    const prepared = createRepairGroupProposal({ creation: input.creation, journal: input.journal, state: before, assertion, ...(input.lineage ? { lineage: input.lineage } : {}), domain: input.domain });
    transient = prepared.transient;
    await input.publishSanitizedProposal(prepared.proposal);
    const exact = await timeout(input.awaitExactApproval(prepared.proposal), input.maxApprovalWaitMs);
    const approval = loadRepairApproval(prepared.proposal, exact.raw, exact.hash); assertRepairApproval(prepared.proposal, approval);
    const continuation = input.journal.repairContinuation;
    if (!continuation || continuation.groupProposalHash || continuation.groupApprovalHash || continuation.actions.length !== 1) throw new Error("repair continuation group was already prepared or changed");
    continuation.groupProposalHash = prepared.proposal.proposalHash; continuation.groupApprovalHash = approval.approvalHash;
    continuation.actions.push(...prepared.proposal.actions.map(action => ({ id: action.id, commitment: action.commitment, status: "approved" as const })));
    approvedRecord = continuation.actions[1];
    await input.persistJournal(input.journal);
    const fresh = await input.publicPreflight();
    if (!sameState(before, fresh)) throw new Error("repair protocol state changed after exact review");
    const materialized = await input.materializeSafeTransaction(prepared.proposal, transient);
    validateSignedRepairQueue(prepared.proposal, transient, materialized.signedSafeCalldata, materialized.liveIntent);
    const simulation = await input.simulate(materialized.signedSafeCalldata, prepared.proposal);
    if (!simulation.success || simulation.gasEstimate <= 0n || simulation.gasEstimate > 2_000_000n) throw new Error("repair signed simulation failed or exceeded the 2000000 gas cap");
    const live: LiveContext = { ...input.live, verify: async () => {
      const final = await input.publicPreflight();
      if (!sameState(before, final)) throw new Error("repair protocol state changed before outer signing");
      const finalSimulation = await input.simulate(materialized.signedSafeCalldata, prepared.proposal);
      if (!finalSimulation.success || finalSimulation.gasEstimate <= 0n || finalSimulation.gasEstimate > 2_000_000n) throw new Error("repair final signed simulation failed or exceeded the 2000000 gas cap");
      await input.live.verify();
    }, persist: async updated => {
      input.journal.liveJournal = updated;
      const pending = updated.entries.find(entry => entry.id === "repair-queue");
      const action = continuation.actions[1];
      if (pending && action) { action.status = "pending"; action.transactionHash = pending.transactionHash; }
      await input.persistJournal(input.journal);
    } };
    const entry = await (input.submit ?? submitLiveIntent)(materialized.liveIntent, input.journal.liveJournal, live);
    if (entry.status !== "pending") throw new Error("repair queue new submission returned unexpected terminal state");
    const transactionHash = entry.transactionHash;
    return Object.freeze({ status: "PENDING", transactionHash, proposalHash: prepared.proposal.proposalHash, approvalHash: approval.approvalHash });
  } catch (error) {
    if (approvedRecord?.status === "approved") { approvedRecord.status = "stopped"; await input.persistJournal(input.journal); }
    throw error;
  } finally {
    assertion = undefined;
    transient = undefined;
  }
}

export const REPAIR_COMMANDS = Object.freeze(["creation-review", "creation-submit", "prepare-queue", "tail-submit-one", "tail-resume-one"] as const);
export type RepairCommand = typeof REPAIR_COMMANDS[number];

export function parseRepairCommand(argv: readonly string[]): Readonly<{ command: RepairCommand; arguments: readonly string[] }> {
  const [command, ...arguments_] = argv;
  if (!command || !REPAIR_COMMANDS.includes(command as RepairCommand)) throw new Error(`repair command must be exactly one of: ${REPAIR_COMMANDS.join(", ")}`);
  if (arguments_.some(value => !value || value.startsWith("--unknown"))) throw new Error("repair command contains an unknown argument");
  return Object.freeze({ command: command as RepairCommand, arguments: Object.freeze(arguments_) });
}

export type RepairCommandRuntime = Readonly<{
  creationReview(arguments_: readonly string[]): Promise<unknown>;
  creationSubmit(arguments_: readonly string[]): Promise<unknown>;
  prepareQueue(arguments_: readonly string[]): Promise<unknown>;
  tailSubmitOne(arguments_: readonly string[]): Promise<unknown>;
  tailResumeOne(arguments_: readonly string[]): Promise<unknown>;
}>;

export async function runRepairCommand(argv: readonly string[], runtime: RepairCommandRuntime): Promise<unknown> {
  const parsed = parseRepairCommand(argv);
  if (parsed.command === "creation-review") return runtime.creationReview(parsed.arguments);
  if (parsed.command === "creation-submit") return runtime.creationSubmit(parsed.arguments);
  if (parsed.command === "prepare-queue") return runtime.prepareQueue(parsed.arguments);
  if (parsed.command === "tail-submit-one") return runtime.tailSubmitOne(parsed.arguments);
  return runtime.tailResumeOne(parsed.arguments);
}

const PRIVATE_INPUTS = ["LIVE_FUNDING_KEY_FILE", "LIVE_PRIMARY_CREDENTIAL_FILE", "LIVE_SECONDARY_CREDENTIAL_FILE", "LIVE_REPAIR_SECONDARY_CREDENTIAL_FILE", "LIVE_ECDSA_KEY_FILE", "LIVE_SUBMIT", "PRIVATE_KEY"] as const;
const readJson = <T>(path: string, bigintKeys: ReadonlySet<string> = new Set()): T => JSON.parse(readFileSync(path, "utf8"), (key, value) => bigintKeys.has(key) && typeof value === "string" && /^[0-9]+$/.test(value) ? BigInt(value) : value) as T;

export type RepairCommandDependencies = Readonly<{
  environment: Readonly<Record<string, string | undefined>>;
  domain: RepairExecutionDomain;
  ordinaryDomain: OrdinaryScenarioProposalDomain;
  repository(): string;
  createHarness(repository: string): OrdinaryScenarioProductionHarness;
  createAdapter(input: Parameters<typeof createRepairProductionAdapter>[0] & Readonly<{ domain: RepairExecutionDomain }>): RepairProductionAdapter;
  loadCreationQuote(repository: string): RepairCreationQuote;
  submit(intent: LiveIntent, journal: LiveJournal, live: LiveContext): Promise<JournalEntry>;
  now(): Date;
  awaitApprovalHandoff(maxWaitMs: number): Promise<Readonly<{ raw: string; hash: Hex }>>;
  loadHashlessLineage?(argv: readonly string[]): Promise<HashlessContinuationPublicInputs>;
}>;

const productionRepairCommandDependencies = (): RepairCommandDependencies => Object.freeze({
  environment: process.env,
  domain: PRODUCTION_REPAIR_EXECUTION_DOMAIN,
  ordinaryDomain: PRODUCTION_ORDINARY_SCENARIO_DOMAIN,
  repository: () => process.cwd().replace(/\/packages\/security-core$/, ""),
  createHarness: createOrdinaryScenarioProductionHarness,
  createAdapter: input => createRepairProductionAdapter(input),
  loadCreationQuote: loadFixedRepairCreationQuote,
  submit: submitLiveIntent,
  now: () => new Date(),
  awaitApprovalHandoff: readApprovalHandoff,
  loadHashlessLineage: async argv => {
    const repository = process.cwd().replace(/\/packages\/security-core$/, ""); const production = createHashlessContinuationProductionDependencies(repository, argv);
    if (!production.providers) throw new Error("repair continuation two-provider verifier is unavailable");
    return loadHashlessContinuationPublicInputs(parseHashlessContinuationCliArguments(argv), production.providers);
  },
});

const REPAIR_LINEAGE_FLAGS = ["--continuation-certificate", "--continuation-certificate-hash", "--continuation-proposal", "--continuation-approval", "--continuation-approval-hash"] as const;
const repairKnownWithLineage = (base: readonly string[]) => new Set([...base, ...REPAIR_LINEAGE_FLAGS]);
async function loadRepairHashlessLineage(values: ReadonlyMap<string, string>, dependencies: RepairCommandDependencies): Promise<HashlessContinuationPublicInputs | undefined> {
  const present = REPAIR_LINEAGE_FLAGS.filter(flag => values.has(flag)); if (present.length === 0) return undefined;
  if (present.length !== REPAIR_LINEAGE_FLAGS.length || !dependencies.loadHashlessLineage) throw new Error("repair hashless lineage requires the complete shared public loader inputs");
  const requiredValue = (flag: string) => { const value = values.get(flag); if (!value) throw new Error(`repair hashless lineage requires ${flag}`); return value; };
  const argv = ["submit-one", "--source-journal", requiredValue("--journal"), "--original-report", requiredValue("--report"), "--original-package-hash", requiredValue("--package-hash"), "--original-artifact-hash", requiredValue("--artifact-hash"), "--original-proposal-hash", requiredValue("--proposal-hash"), "--certificate", requiredValue("--continuation-certificate"), "--certificate-hash", requiredValue("--continuation-certificate-hash"), "--proposal", requiredValue("--continuation-proposal"), "--approval", requiredValue("--continuation-approval"), "--approval-hash", requiredValue("--continuation-approval-hash"), "--journal", requiredValue("--journal")];
  const loaded = await dependencies.loadHashlessLineage(argv); if (!loaded.approval) throw new Error("repair hashless lineage requires the exact separate continuation approval");
  assertContinuationObserverFresh(loaded.continuation.observer, dependencies.now()); return loaded;
}

function loadFixedRepairCreationQuote(repository: string): RepairCreationQuote {
  const descriptor = readJson<{ formatVersion: number; scope: string; chainId: number; factory: Address; verifiers: string; address: Address; x: string; y: string }>(join(repository, ".superpowers/sdd/2026-10-19-native-safe-4337/repair-secondary-public.json"));
  const quote = readJson<{ scope: string; chainId: number; factory: Address; predictedSigner: Address; calldata: Hex; dataHash: Hex; value: string; proposedGasCap: string; maxFeePerGasCap: string; exactCapCallPassed: boolean; signed: boolean; broadcast: boolean }>(join(repository, ".superpowers/sdd/2026-10-19-native-safe-4337/repair-secondary-creation-quote.json"));
  if (descriptor.formatVersion !== 1 || descriptor.scope !== "ordinary-baseline-proposed-contract-secondary-repair" || quote.scope !== "unsigned-replacement-signer-proposal" || quote.value !== "0" || !quote.exactCapCallPassed || quote.signed || quote.broadcast || descriptor.chainId !== quote.chainId || descriptor.factory.toLowerCase() !== quote.factory.toLowerCase() || descriptor.address.toLowerCase() !== quote.predictedSigner.toLowerCase()) throw new Error("fixed repair descriptor/creation quote mismatch");
  return Object.freeze({ chainId: quote.chainId, factory: quote.factory, candidate: descriptor.address, x: BigInt(descriptor.x), y: BigInt(descriptor.y), verifiers: BigInt(descriptor.verifiers), calldata: quote.calldata, calldataHash: quote.dataHash, gasLimitCap: BigInt(quote.proposedGasCap), maxFeePerGasCap: BigInt(quote.maxFeePerGasCap), maxPriorityFeePerGasCap: 1_000_000n });
}

export async function runPublicRepairCreationReview(arguments_: readonly string[], dependencies: RepairCommandDependencies): Promise<RepairCreationProposal> {
  for (const key of PRIVATE_INPUTS) if (dependencies.environment[key] !== undefined) throw new Error(`repair creation-review rejects authority input: ${key}`);
  const args = [...arguments_]; const values = new Map<string, string>();
  while (args.length) { const key = args.shift()!; const value = args.shift(); if (!key.startsWith("--") || !value || values.has(key)) throw new Error("repair creation-review arguments are malformed"); values.set(key, value); }
  const known = repairKnownWithLineage(["--report", "--artifact-hash", "--package-hash", "--proposal-hash", "--original-approval-hash", "--journal", "--output"]); for (const key of values.keys()) if (!known.has(key)) throw new Error(`repair creation-review rejects unknown flag ${key}`);
  const required = (key: string) => { const value = values.get(key); if (!value) throw new Error(`repair creation-review requires ${key}`); return value; };
  const loadedLineage = await loadRepairHashlessLineage(values, dependencies);
  const proposal = loadedLineage?.original ?? createOrdinaryScenarioProposal(readFileSync(required("--report"), "utf8"), { expectedArtifactBytesHash: required("--artifact-hash") as Hex, expectedPackageHash: required("--package-hash") as Hex }, dependencies.ordinaryDomain);
  if (proposal.proposalHash.toLowerCase() !== required("--proposal-hash").toLowerCase()) throw new Error("repair creation-review original proposal hash mismatch");
  const store = createOrdinaryScenarioStore(required("--journal"), { proposalHash: proposal.proposalHash, approvalHash: required("--original-approval-hash") as Hex, funder: proposal.funder }, () => { throw new Error("repair creation-review requires the terminal journal"); }, dependencies.ordinaryDomain);
  try {
    const journal = store.load(); const repository = dependencies.repository(); const harness = dependencies.createHarness(repository); const reconstructed = await harness.reconstructedProfile(); const quote = dependencies.loadCreationQuote(repository);
    const anchor = await harness.current.getBlock(); if (!anchor.hash) throw new Error("repair creation review canonical block hash unavailable");
    const descriptor = createRepairAdapterDescriptor(proposal, quote, { blockNumber: anchor.number, blockHash: anchor.hash }); const adapter = dependencies.createAdapter({ repository, harness, reconstructed, creation: descriptor, domain: dependencies.domain });
    const evidence = await adapter.validateTerminalPrefix(journal); const observerHash = loadedLineage?.continuation.observer.probeEvidenceHash ?? proposal.observerEvidenceHash; const state = await adapter.readStateAt("pre-rotation", observerHash, anchor.number, anchor.hash);
    const lineage = loadedLineage?.approval ? { kind: "expired-hashless-continuation-v1" as const, continuation: loadedLineage.continuation, approval: loadedLineage.approval } : undefined;
    const creation = createRepairCreationProposal({ proposal, journal, evidence, ...(lineage ? { lineage } : {}), state, quote, domain: dependencies.domain }); extendJournalForRepair(journal, creation); store.save(journal);
    const output = values.get("--output"); if (output) writeFileSync(output, `${JSON.stringify(creation)}\n`, { flag: "wx", mode: 0o600 });
    return creation;
  } finally { store.close?.(); }
}

export async function runRepairCreationSubmit(arguments_: readonly string[], dependencies: RepairCommandDependencies): Promise<Readonly<{ status: "PENDING" | "CONFIRMED_NO_NEW_CREATION"; actionId: "repair-signer-create"; transactionHash?: Hex }>> {
  if (dependencies.environment.LIVE_SUBMIT !== "YES") throw new Error("repair creation-submit requires LIVE_SUBMIT=YES");
  for (const key of PRIVATE_INPUTS) if (key !== "LIVE_SUBMIT" && key !== "LIVE_FUNDING_KEY_FILE" && dependencies.environment[key] !== undefined) throw new Error(`repair creation-submit rejects unsupported authority input: ${key}`);
  const pairs: Array<[string, string]> = []; const args = [...arguments_]; const seen = new Set<string>(); while (args.length) { const key = args.shift()!; const value = args.shift(); if (!key.startsWith("--") || !value || seen.has(key)) throw new Error("repair creation-submit arguments are malformed"); seen.add(key); pairs.push([key, value]); }
  const known = repairKnownWithLineage(["--creation", "--creation-hash", "--report", "--artifact-hash", "--package-hash", "--proposal-hash", "--original-approval-hash", "--journal", "--approval", "--approval-hash"]); for (const [key] of pairs) if (!known.has(key)) throw new Error(`repair creation-submit rejects unknown flag ${key}`);
  const value = (key: string) => { const found = pairs.find(([name]) => name === key)?.[1]; if (!found) throw new Error(`repair creation-submit requires ${key}`); return found; };
  const values = new Map(pairs); const loadedLineage = await loadRepairHashlessLineage(values, dependencies);
  const creation = loadRepairCreationProposal(readFileSync(value("--creation"), "utf8"), value("--creation-hash") as Hex, dependencies.domain);
  const approvalRaw = readFileSync(value("--approval"), "utf8"); const approval = loadRepairApproval(creation, approvalRaw, value("--approval-hash") as Hex);
  const report = readFileSync(value("--report"), "utf8"); const original = loadedLineage?.original ?? createOrdinaryScenarioProposal(report, { expectedArtifactBytesHash: value("--artifact-hash") as Hex, expectedPackageHash: value("--package-hash") as Hex }, dependencies.ordinaryDomain);
  if (original.proposalHash.toLowerCase() !== value("--proposal-hash").toLowerCase()) throw new Error("repair creation-submit original proposal mismatch"); assertCreationOriginalBinding(creation, original, value("--original-approval-hash") as Hex);
  const store = createOrdinaryScenarioStore(value("--journal"), { proposalHash: original.proposalHash, approvalHash: value("--original-approval-hash") as Hex, funder: original.funder }, () => { throw new Error("repair creation-submit requires the terminal journal"); }, dependencies.ordinaryDomain);
  try {
    const journal = store.load(); const repository = dependencies.repository(); const harness = dependencies.createHarness(repository); const reconstructed = await harness.reconstructedProfile(); const adapter = dependencies.createAdapter({ repository, harness, reconstructed, creation, domain: dependencies.domain });
    const evidence = await adapter.validateTerminalPrefix(journal); const observerHash = loadedLineage?.continuation.observer.probeEvidenceHash ?? original.observerEvidenceHash; const lineage = loadedLineage?.approval ? { kind: "expired-hashless-continuation-v1" as const, continuation: loadedLineage.continuation, approval: loadedLineage.approval } : undefined;
    const verified = verifyRepairPredecessor(original, journal, evidence, lineage); if (verified.prefixHash !== creation.prefixHash || verified.kind !== creation.predecessor.kind) throw new Error("repair creation predecessor changed under the writer lease");
    bindRepairCreationApproval(journal, creation, approval); store.save(journal);
    if (creation.alreadyDeployed) { const state = await adapter.readState("pre-rotation", observerHash); assertRepairCreationState(creation, state, true, dependencies.domain); recordRepairCreationConfirmation(journal, creation, evidenceHash({ noNewCreation: true, blockNumber: state.blockNumber, blockHash: state.blockHash, runtimeCodeHash: state.candidateRuntimeCodeHash, bindingHash: state.candidateBindingHash })); store.save(journal); return Object.freeze({ status: "CONFIRMED_NO_NEW_CREATION", actionId: "repair-signer-create" }); }
    const nonce = Number(await harness.current.getTransactionCount({ address: creation.funder }));
    const intent: LiveIntent = { id: "repair-signer-create", to: creation.factory, data: creation.creationCalldata, value: 0n, nonce, gas: BigInt(creation.action.gasLimitCap), maxFeePerGas: BigInt(creation.action.maxFeePerGasCap), maxPriorityFeePerGas: BigInt(creation.action.maxPriorityFeePerGasCap) };
    const liveBase = await harness.createLiveContext("submit-one", creation.funder, async updated => { journal.liveJournal = updated; const entry = updated.entries.find(item => item.id === intent.id); const record = journal.repairContinuation?.actions[0]; if (entry && record) { record.status = "pending"; record.transactionHash = entry.transactionHash; } store.save(journal); });
    const live: LiveContext = { ...liveBase, verify: async () => {
      const freshEvidence = await adapter.validateTerminalPrefix(journal); const freshVerified = verifyRepairPredecessor(original, journal, freshEvidence, lineage); if (freshVerified.prefixHash !== creation.prefixHash) throw new Error("repair creation predecessor changed before signing"); const state = await adapter.readState("pre-rotation", observerHash); assertRepairCreationState(creation, state, false, dependencies.domain);
      const simulation = await harness.current.call({ account: creation.funder, to: creation.factory, data: creation.creationCalldata, gas: intent.gas });
      validateRepairCreationSimulation(creation, simulation.data ?? "0x");
      const estimate = await harness.current.estimateGas({ account: creation.funder, to: creation.factory, data: creation.creationCalldata, value: 0n }); if (estimate <= 0n || estimate > intent.gas) throw new Error("repair creation estimate exceeds approved cap");
    } };
    const entry = await dependencies.submit(intent, journal.liveJournal, live); if (entry.status !== "pending") throw new Error("repair creation new submission returned unexpected terminal state");
    return Object.freeze({ status: "PENDING", actionId: "repair-signer-create", transactionHash: entry.transactionHash });
  } finally { store.close?.(); }
}

const argumentMap = (arguments_: readonly string[], scope: string): Map<string, string> => {
  const args = [...arguments_]; const values = new Map<string, string>(); while (args.length) { const key = args.shift()!; const value = args.shift(); if (!key.startsWith("--") || !value || values.has(key)) throw new Error(`${scope} arguments are malformed`); values.set(key, value); } return values;
};
const requireArgument = (values: ReadonlyMap<string, string>, key: string, scope: string): string => { const value = values.get(key); if (!value) throw new Error(`${scope} requires ${key}`); return value; };

async function readApprovalHandoff(maxWaitMs: number): Promise<Readonly<{ raw: string; hash: Hex }>> {
  const line = await timeout(new Promise<string>((resolve, reject) => {
    let text = ""; const onData = (chunk: Buffer | string) => { text += chunk.toString(); const index = text.indexOf("\n"); if (index >= 0) { cleanup(); resolve(text.slice(0, index)); } }; const onEnd = () => { cleanup(); reject(new Error("repair approval stdin ended before handoff")); }; const cleanup = () => { process.stdin.off("data", onData); process.stdin.off("end", onEnd); }; process.stdin.on("data", onData); process.stdin.on("end", onEnd); process.stdin.resume();
  }), maxWaitMs);
  let parsed: unknown; try { parsed = JSON.parse(line); } catch { throw new Error("repair approval stdin handoff must be JSON"); }
  const value = parsed as Record<string, unknown>; if (!value || typeof value.path !== "string" || typeof value.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value.hash)) throw new Error("repair approval stdin handoff is malformed");
  return Object.freeze({ raw: readFileSync(value.path, "utf8"), hash: value.hash as Hex });
}

export async function runRepairPrepareQueue(arguments_: readonly string[], dependencies: RepairCommandDependencies): Promise<RepairQueueSessionResult> {
  if (dependencies.environment.LIVE_SUBMIT !== "YES") throw new Error("repair prepare-queue requires LIVE_SUBMIT=YES");
  for (const key of ["LIVE_ECDSA_KEY_FILE", "PRIVATE_KEY"] as const) if (dependencies.environment[key] !== undefined) throw new Error(`repair prepare-queue rejects unsupported authority input: ${key}`);
  const values = argumentMap(arguments_, "repair prepare-queue"); const known = repairKnownWithLineage(["--creation", "--creation-hash", "--report", "--artifact-hash", "--package-hash", "--proposal-hash", "--original-approval-hash", "--journal", "--prepare-authorization", "--group-output", "--observer-ledger", "--receiver-ack", "--approval-wait-ms"]); for (const key of values.keys()) if (!known.has(key)) throw new Error(`repair prepare-queue rejects unknown flag ${key}`);
  const get = (key: string) => requireArgument(values, key, "repair prepare-queue"); const maxWait = Number(values.get("--approval-wait-ms") ?? REPAIR_MAX_APPROVAL_WAIT_MS); if (!Number.isSafeInteger(maxWait) || maxWait <= 0 || maxWait > REPAIR_MAX_APPROVAL_WAIT_MS) throw new Error("repair prepare-queue approval wait is invalid");
  const loadedLineage = await loadRepairHashlessLineage(values, dependencies);
  const creation = loadRepairCreationProposal(readFileSync(get("--creation"), "utf8"), get("--creation-hash") as Hex, dependencies.domain);
  const original = loadedLineage?.original ?? createOrdinaryScenarioProposal(readFileSync(get("--report"), "utf8"), { expectedArtifactBytesHash: get("--artifact-hash") as Hex, expectedPackageHash: get("--package-hash") as Hex }, dependencies.ordinaryDomain); if (original.proposalHash.toLowerCase() !== get("--proposal-hash").toLowerCase()) throw new Error("repair prepare-queue original proposal mismatch"); assertCreationOriginalBinding(creation, original, get("--original-approval-hash") as Hex);
  const store = createOrdinaryScenarioStore(get("--journal"), { proposalHash: original.proposalHash, approvalHash: get("--original-approval-hash") as Hex, funder: original.funder }, () => { throw new Error("repair prepare-queue requires terminal journal"); }, dependencies.ordinaryDomain);
  try {
    const journal = store.load(); const repository = dependencies.repository(); const harness = dependencies.createHarness(repository); const reconstructed = await harness.reconstructedProfile(); const adapter = dependencies.createAdapter({ repository, harness, reconstructed, creation, domain: dependencies.domain });
    const observerHash = loadedLineage?.continuation.observer.probeEvidenceHash ?? original.observerEvidenceHash; const live = await harness.createLiveContext("submit-one", creation.funder, async () => {});
    const evidence = await adapter.validateTerminalPrefix(journal); const lineage = loadedLineage?.approval ? { kind: "expired-hashless-continuation-v1" as const, continuation: loadedLineage.continuation, approval: loadedLineage.approval } : undefined; const verified = verifyRepairPredecessor(original, journal, evidence, lineage); if (verified.prefixHash !== creation.prefixHash || verified.kind !== creation.predecessor.kind) throw new Error("repair predecessor changed before proof preparation");
    return await runRepairQueueSession({ creation, journal, ...(lineage ? { lineage } : {}), domain: dependencies.domain, maxApprovalWaitMs: maxWait,
      publicPreflight: () => adapter.readState("pre-rotation", observerHash),
      awaitPrepareAuthorization: async authorization => { const raw = readFileSync(get("--prepare-authorization"), "utf8"); let parsed: unknown; try { parsed = JSON.parse(raw); } catch { return false; } return JSON.stringify(parsed) === JSON.stringify(authorization); },
      loadReplacementCredential: () => harness.loadClosedProofSigner("repair-secondary", creation.candidate),
      signReplacementProof: (signer, proofHash) => signer.signDigest(proofHash),
      verifyReplacementProof: async (proofHash, assertion, blockNumber) => harness.current.readContract({ address: creation.candidate, abi: ERC1271_ABI, functionName: "isValidSignature", args: [proofHash, assertion], blockNumber }),
      publishSanitizedProposal: async proposal => { writeFileSync(get("--group-output"), `${JSON.stringify(proposal)}\n`, { flag: "wx", mode: 0o600 }); process.stdout.write(`${JSON.stringify({ proposalHash: proposal.proposalHash, approvalHandoff: "stdin-json-path-and-hash", maxWaitMs: maxWait })}\n`); },
      awaitExactApproval: () => dependencies.awaitApprovalHandoff(maxWait), persistJournal: async updated => store.save(updated),
      materializeSafeTransaction: (proposal, transient) => adapter.materializeRepairQueue(proposal, transient),
      simulate: async signedSafeCalldata => { const state = await adapter.readState("pre-rotation", observerHash); const result = await harness.current.call({ account: creation.funder, to: creation.safe, data: signedSafeCalldata, gas: 2_000_000n, blockNumber: state.blockNumber }); const [success] = decodeAbiParameters([{ type: "bool" }], result.data ?? "0x"); const gasEstimate = await harness.current.estimateGas({ account: creation.funder, to: creation.safe, data: signedSafeCalldata, value: 0n }); return { gasEstimate, success }; },
      submit: dependencies.submit,
      live: { ...live, verify: async () => {}, persist: async () => { throw new Error("repair session owns atomic persistence"); } },
    });
  } finally { store.close?.(); }
}

const evidenceHash = (value: unknown): Hex => `0x${createHash("sha256").update(JSON.stringify(value, (_, child) => typeof child === "bigint" ? child.toString() : child)).digest("hex")}` as Hex;

function assertCreationOriginalBinding(creation: RepairCreationProposal, original: ReturnType<typeof createOrdinaryScenarioProposal>, originalApprovalHash: Hex): void {
  if (creation.originalProposalHash.toLowerCase() !== original.proposalHash.toLowerCase() || creation.originalApprovalHash.toLowerCase() !== originalApprovalHash.toLowerCase() || creation.originalIdentityHash.toLowerCase() !== repairOriginalIdentityHash(original).toLowerCase() || creation.safe.toLowerCase() !== original.safe.toLowerCase() || creation.guard.toLowerCase() !== original.guard.toLowerCase() || creation.delay.toLowerCase() !== original.delay.toLowerCase() || creation.funder.toLowerCase() !== original.funder.toLowerCase() || creation.periodAnchor !== original.periodAnchor) throw new Error("repair creation original identity binding mismatch");
}

export async function validateRepairTailSimulation(current: Pick<OrdinaryScenarioProductionHarness["current"], "call" | "estimateGas">, funder: Address, action: Pick<RepairGroupProposal["actions"][number], "kind" | "gasLimitCap">, intent: LiveIntent, blockNumber: bigint): Promise<void> {
  const result = await current.call({ account: funder, to: intent.to, data: intent.data, value: intent.value, gas: intent.gas, blockNumber }); const estimate = await current.estimateGas({ account: funder, to: intent.to, data: intent.data, value: intent.value, blockNumber });
  if (action.kind === "safe-queue" || action.kind === "safe-cancel" || action.kind === "safe-freeze") { const [ok] = decodeAbiParameters([{ type: "bool" }], result.data ?? "0x"); if (!ok) throw new Error("repair Safe simulation returned false"); }
  else if ((result.data ?? "0x") !== "0x") throw new Error("repair public Delay simulation returned unexpected data");
  if (estimate <= 0n || estimate > BigInt(action.gasLimitCap) || estimate > intent.gas) throw new Error("repair fresh gas estimate exceeds approved cap");
}

export function repairObserverExpectedEffect(group: RepairGroupProposal, action: RepairGroupProposal["actions"][number], blockNumber: bigint): Readonly<{ kind: "delayed-queued" | "delayed-executed" | "delayed-cancelled"; safe: Address; delay: Address; blockNumber: bigint; queueNonce?: bigint; queueFingerprint?: Hex; cancelledThrough?: bigint }> {
  const common = { kind: action.alert as "delayed-queued" | "delayed-executed" | "delayed-cancelled", safe: group.safe, delay: group.delay, blockNumber };
  if (action.id === "repair-queue" || action.id === "repair-ready-execute") return Object.freeze({ ...common, queueNonce: BigInt(group.actions[0]!.delayQueueNonceBefore), queueFingerprint: action.queueFingerprint! });
  if (action.id === "post-rotation-new-secondary-queue") return Object.freeze({ ...common, queueNonce: BigInt(action.delayQueueNonceBefore), queueFingerprint: action.queueFingerprint! });
  if (action.id === "post-rotation-proof-cancel") return Object.freeze({ ...common, cancelledThrough: BigInt(action.delayTxNonceAfter) });
  throw new Error("repair action has no observer effect");
}

export async function runRepairTail(arguments_: readonly string[], mode: "submit-one" | "resume-one", dependencies: RepairCommandDependencies): Promise<Readonly<Record<string, unknown>>> {
  if (mode === "submit-one" && dependencies.environment.LIVE_SUBMIT !== "YES") throw new Error("repair tail-submit-one requires LIVE_SUBMIT=YES");
  if (mode === "submit-one") for (const key of ["LIVE_ECDSA_KEY_FILE", "PRIVATE_KEY"] as const) if (dependencies.environment[key] !== undefined) throw new Error(`repair tail-submit-one rejects unsupported authority input: ${key}`);
  if (mode === "resume-one" && PRIVATE_INPUTS.some(key => dependencies.environment[key] !== undefined)) throw new Error("repair tail-resume-one rejects private authority input");
  const values = argumentMap(arguments_, `repair tail-${mode}`); const get = (key: string) => requireArgument(values, key, `repair tail-${mode}`);
  const known = repairKnownWithLineage(["--creation", "--creation-hash", "--report", "--artifact-hash", "--package-hash", "--proposal-hash", "--original-approval-hash", "--journal", "--group", "--group-hash", "--observer-ledger", "--receiver-ack"]); for (const key of values.keys()) if (!known.has(key)) throw new Error(`repair tail-${mode} rejects unknown flag ${key}`);
  const loadedLineage = await loadRepairHashlessLineage(values, dependencies);
  const creation = loadRepairCreationProposal(readFileSync(get("--creation"), "utf8"), get("--creation-hash") as Hex, dependencies.domain); const original = loadedLineage?.original ?? createOrdinaryScenarioProposal(readFileSync(get("--report"), "utf8"), { expectedArtifactBytesHash: get("--artifact-hash") as Hex, expectedPackageHash: get("--package-hash") as Hex }, dependencies.ordinaryDomain);
  if (original.proposalHash.toLowerCase() !== get("--proposal-hash").toLowerCase()) throw new Error("repair tail original proposal mismatch"); assertCreationOriginalBinding(creation, original, get("--original-approval-hash") as Hex);
  const store = createOrdinaryScenarioStore(get("--journal"), { proposalHash: original.proposalHash, approvalHash: get("--original-approval-hash") as Hex, funder: original.funder }, () => { throw new Error("repair tail requires journal"); }, dependencies.ordinaryDomain);
  try {
    const journal = store.load(); const continuation = journal.repairContinuation; if (!continuation) throw new Error("repair tail continuation is missing");
    const repository = dependencies.repository(); const harness = dependencies.createHarness(repository); const reconstructed = await harness.reconstructedProfile(); const adapter = dependencies.createAdapter({ repository, harness, reconstructed, creation, domain: dependencies.domain });
    const lineage = loadedLineage?.approval ? { kind: "expired-hashless-continuation-v1" as const, continuation: loadedLineage.continuation, approval: loadedLineage.approval } : undefined; const observerHash = loadedLineage?.continuation.observer.probeEvidenceHash ?? original.observerEvidenceHash;
    const prefixEvidence = await adapter.validateTerminalPrefix(journal); const verified = verifyRepairPredecessor(original, journal, prefixEvidence, lineage); if (verified.prefixHash.toLowerCase() !== creation.prefixHash.toLowerCase() || verified.kind !== creation.predecessor.kind) throw new Error("repair predecessor changed before tail execution");
    const persist = async (updated: OrdinaryScenarioJournal["liveJournal"]) => { journal.liveJournal = updated; for (const entry of updated.entries) { const actionRecord = continuation.actions.find(item => item.id === entry.id && item.status === "approved"); if (actionRecord && entry.status === "pending") { actionRecord.status = "pending"; actionRecord.transactionHash = entry.transactionHash; } } store.save(journal); };
    const liveBase = await harness.createLiveContext(mode, creation.funder, persist); const live: LiveContext = { ...liveBase, verify: async () => {}, persist };
    const creationRecord = continuation.actions[0];
    if (creationRecord?.status === "pending") {
      if (mode !== "resume-one" || !creationRecord.transactionHash) throw new Error("repair creation pending record requires resume-one");
      const intent = await adapter.recoverPendingIntent(undefined, creation.action, creationRecord.transactionHash); const entry = await dependencies.submit(intent, journal.liveJournal, live); if (entry.status === "pending") return { status: "PENDING", actionId: creationRecord.id };
      if (entry.status !== "success" || !entry.receipt) throw new Error("repair creation reverted"); const receipt = await harness.current.getTransactionReceipt({ hash: entry.transactionHash }); validateRepairCreationReceiptLogs(creation, receipt.logs); const state = await adapter.readStateAt("pre-rotation", observerHash, entry.receipt.blockNumber, entry.receipt.blockHash); assertRepairCreationState(creation, state, true, dependencies.domain);
      recordRepairCreationConfirmation(journal, creation, evidenceHash({ receipt: entry.receipt, runtimeCodeHash: state.candidateRuntimeCodeHash, bindingHash: state.candidateBindingHash }), entry.transactionHash); store.save(journal); return { status: "CONFIRMED", actionId: creationRecord.id };
    }
    const groupPath = get("--group"); const group = loadRepairGroupProposal(readFileSync(groupPath, "utf8"), get("--group-hash") as Hex, dependencies.domain); if (continuation.groupProposalHash?.toLowerCase() !== group.proposalHash.toLowerCase() || !continuation.groupApprovalHash || group.creationProposalHash.toLowerCase() !== creation.proposalHash.toLowerCase() || group.originalProposalHash.toLowerCase() !== original.proposalHash.toLowerCase() || group.originalApprovalHash.toLowerCase() !== creation.originalApprovalHash.toLowerCase() || group.prefixHash.toLowerCase() !== creation.prefixHash.toLowerCase() || JSON.stringify(group.predecessor) !== JSON.stringify(creation.predecessor) || group.safe.toLowerCase() !== creation.safe.toLowerCase() || group.guard.toLowerCase() !== creation.guard.toLowerCase() || group.delay.toLowerCase() !== creation.delay.toLowerCase() || group.candidate.toLowerCase() !== creation.candidate.toLowerCase()) throw new Error("repair tail group journal binding mismatch");
    const record = continuation.actions.find(action => action.id !== "repair-signer-create" && action.status !== "confirmed" && action.status !== "rejection-proved"); if (!record) return { status: "COMPLETE" };
    const action = group.actions.find(item => item.id === record.id); if (!action || record.commitment.toLowerCase() !== action.commitment.toLowerCase()) throw new Error("repair tail action commitment mismatch");
    if (record.status === "pending") {
      if (mode !== "resume-one" || !record.transactionHash) throw new Error("repair pending action requires resume-one"); const intent = await adapter.recoverPendingIntent(group, action, record.transactionHash); const entry = await dependencies.submit(intent, journal.liveJournal, live); if (entry.status === "pending") return { status: "PENDING", actionId: action.id }; if (entry.status !== "success" || !entry.receipt) throw new Error("repair tail transaction reverted"); const receipt = await harness.current.getTransactionReceipt({ hash: entry.transactionHash }); const queueEvidence = action.id === "repair-queue" ? await adapter.recoverCanonicalRepairQueue(group, entry.transactionHash) : undefined; adapter.validateReceiptEffect(group, action, receipt.logs, queueEvidence?.maintenanceCalldata); const afterPhase = action.id === "repair-ready-execute" ? "post-rotation" : action.policyPhase; const after = await adapter.readStateAt(afterPhase, observerHash, entry.receipt.blockNumber, entry.receipt.blockHash); assertRepairActionState(group, action, after, "after", dependencies.domain); assertRepairBaselineUnchanged(group, after); if (action.id === "final-freeze") await adapter.proveFrozenRejections(group, observerHash, after);
      let observerEvidenceHash: Hex | null = null; if (action.alert !== "none") observerEvidenceHash = loadObserverConfirmationEvidence({ ledgerPath: get("--observer-ledger"), acknowledgementPath: get("--receiver-ack"), endpointHash: "0x8a3e2db19f160da76a08385670e22e08a293ee5b09276b90e74cd2dc65029ae0", transactionHash: entry.transactionHash, expected: repairObserverExpectedEffect(group, action, entry.receipt.blockNumber), now: dependencies.now() }); record.status = "confirmed"; record.evidenceHash = evidenceHash({ receipt: entry.receipt, after, observerEvidenceHash }); store.save(journal); return { status: "CONFIRMED", actionId: action.id };
    }
    if (mode !== "submit-one" || record.status !== "approved") throw new Error("repair tail action is not submit-ready");
    const phase = action.policyPhase; const before = await adapter.readState(phase, observerHash); assertRepairActionState(group, action, before, "before", dependencies.domain); assertRepairBaselineUnchanged(group, before);
    let maintenanceCalldata: Hex | undefined; let queueTiming: Awaited<ReturnType<typeof adapter.recoverCanonicalRepairQueue>> | undefined; if (action.id === "repair-ready-execute") { const queue = continuation.actions.find(item => item.id === "repair-queue"); if (!queue?.transactionHash) throw new Error("repair execution lacks canonical queue transaction"); queueTiming = await adapter.recoverCanonicalRepairQueue(group, queue.transactionHash); maintenanceCalldata = queueTiming.maintenanceCalldata; assertRepairQueueTiming(group, queueTiming, before); }
    const materialized = await adapter.materializeTailAction(group, action, maintenanceCalldata);
    if (action.id === "post-rotation-old-secondary-rejection") { if (!materialized.rejectionCalldata) throw new Error("repair old-secondary rejection calldata is missing"); let expected = false; try { await harness.current.call({ account: creation.funder, to: creation.safe, data: materialized.rejectionCalldata, gas: 2_000_000n, blockNumber: before.blockNumber }); } catch (error) { expected = hasExactRepairRevert(error, INVALID_SECONDARY_SIGNATURE as Hex); } if (!expected) throw new Error("repair old secondary lacks exact InvalidSecondarySignature rejection"); const unchanged = await adapter.readStateAt(phase, observerHash, before.blockNumber, before.blockHash); if (!sameState(before, unchanged)) throw new Error("repair old-secondary rejection state changed"); assertRepairBaselineUnchanged(group, unchanged); record.status = "rejection-proved"; record.evidenceHash = evidenceHash({ safeTxHash: action.safeTxHash, blockNumber: before.blockNumber, blockHash: before.blockHash, rejectionSelector: INVALID_SECONDARY_SIGNATURE, unchanged }); store.save(journal); return { status: "REJECTION_PROVED", actionId: action.id }; }
    if (!materialized.liveIntent) throw new Error("repair tail live intent is missing"); await validateRepairTailSimulation(harness.current, creation.funder, action, materialized.liveIntent, before.blockNumber); const entry = await dependencies.submit(materialized.liveIntent, journal.liveJournal, { ...live, verify: async () => { const fresh = await adapter.readState(phase, observerHash); assertRepairActionState(group, action, fresh, "before", dependencies.domain); assertRepairBaselineUnchanged(group, fresh); if (queueTiming) assertRepairQueueTiming(group, queueTiming, fresh); await validateRepairTailSimulation(harness.current, creation.funder, action, materialized.liveIntent!, fresh.blockNumber); } }); record.status = "pending"; record.transactionHash = entry.transactionHash; store.save(journal); return { status: "PENDING", actionId: action.id };
  } finally { store.close?.(); }
}

/** The review command is public-only; every submitting command retains exact approval and capability gates. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const result = await runRepairCommand(argv, createRepairCommandRuntime());
  process.stdout.write(`${JSON.stringify(result, (_, value) => typeof value === "bigint" ? value.toString() : value)}\n`);
}

export function createRepairCommandRuntime(dependencies: RepairCommandDependencies = productionRepairCommandDependencies()): RepairCommandRuntime {
  return Object.freeze({
    creationReview: arguments_ => runPublicRepairCreationReview(arguments_, dependencies),
    creationSubmit: arguments_ => runRepairCreationSubmit(arguments_, dependencies),
    prepareQueue: arguments_ => runRepairPrepareQueue(arguments_, dependencies),
    tailSubmitOne: arguments_ => runRepairTail(arguments_, "submit-one", dependencies),
    tailResumeOne: arguments_ => runRepairTail(arguments_, "resume-one", dependencies),
  });
}

export const runOrdinaryScenarioRepairEntryPoint = (task: Promise<void>, output?: OperationalCliOutput): Promise<void> => runOperationalCliEntryPoint(task, "ordinary-scenario-repair", output);

if (require.main === module) void runOrdinaryScenarioRepairEntryPoint(main());
