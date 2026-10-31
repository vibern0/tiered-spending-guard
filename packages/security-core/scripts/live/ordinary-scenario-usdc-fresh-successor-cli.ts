import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createPublicClient, decodeEventLog, erc20Abi, http, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import {
  createOrdinaryScenarioStore,
  createUsdcFreshSuccessorExecutionView,
  executeUsdcFreshSuccessorAction,
  selectUsdcFreshSuccessorSubmissionAction,
  type OrdinaryScenarioExecutionContext,
  type OrdinaryScenarioJournal,
} from "./ordinary-scenario-executor";
import { createOrdinaryScenarioExecutionContext, createOrdinaryScenarioStateReader } from "./ordinary-scenario-adapter";
import { createOrdinaryScenarioClosedSignerLoader, createOrdinaryScenarioProductionHarness, type OrdinaryScenarioProductionHarness } from "./ordinary-scenario-executor-cli";
import { createHashlessEvidenceProvider } from "./ordinary-scenario-hashless-continuation-cli";
import { adoptHashlessSourceJournalReadOnlySnapshot } from "./ordinary-scenario-hashless-certificate";
import {
  createUsdcSuccessorEvidenceProvider,
  loadUsdcSuccessorPublicInputs,
  parseUsdcSuccessorCliArguments,
  type UsdcSuccessorPublicProviders,
} from "./ordinary-scenario-usdc-successor-cli";
import {
  loadUsdcRecycleContinuationSourceJournalReadOnly,
  type UsdcRecycleContinuationPrimaryEvidence,
  type UsdcRecycleContinuationSource,
} from "./ordinary-scenario-usdc-recycle-continuation-certificate";
import { withOnePinnedGetCodeRetry } from "./ordinary-scenario-usdc-recycle-continuation-cli";
import {
  reverifyUsdcFreshSuccessorCertificate,
  serializeUsdcFreshSuccessorCertificate,
  verifyUsdcFreshSuccessorCertificate,
  type UsdcFreshSuccessorEvidenceProvider,
  type VerifiedUsdcFreshSuccessorCertificate,
} from "./ordinary-scenario-usdc-fresh-successor-certificate";
import {
  assertUsdcFreshSuccessorAdmission,
  attachUsdcFreshSuccessor,
  createUsdcFreshSuccessorProposal,
  FRESH_SUCCESSOR_SCHEDULE,
  loadUsdcFreshSuccessorApproval,
  parseUsdcFreshSuccessorProposal,
  type UsdcFreshSuccessorApproval,
  type UsdcFreshSuccessorProposal,
} from "./ordinary-scenario-usdc-fresh-successor-proposal";
import type { ContinuationObserverBinding } from "./ordinary-scenario-hashless-continuation";
import { PUBLIC_ARCHIVE_RPC, PUBLIC_HISTORICAL_EVIDENCE_RPC, reconstructReviewedPlan } from "./ordinary-scenario-review-cli";
import type { OperationalCliOutput } from "./operational-cli-entrypoint";

export const USDC_FRESH_SUCCESSOR_COMMANDS = Object.freeze(["review", "submit-one", "resume-one"] as const);
export const USDC_FRESH_SUCCESSOR_CAPS = Object.freeze({ fundingGasLimit: "740292", safeExecutionGasLimit: "2000000", publicDelayGasLimit: "300000", maxFeePerGas: "1000000", maxPriorityFeePerGas: "1000000" });
const HASH = /^0x[0-9a-fA-F]{64}$/;
const PRIVATE_ENV = ["LIVE_FUNDING_KEY_FILE", "LIVE_PRIMARY_CREDENTIAL_FILE", "LIVE_SECONDARY_CREDENTIAL_FILE", "LIVE_ECDSA_KEY_FILE", "PRIVATE_KEY", "VAULT_FUNDING_KEY_PATH"] as const;
const OLD_FLAGS = ["--source-journal", "--original-report", "--original-package-hash", "--original-artifact-hash", "--original-proposal-hash", "--recovery-certificate", "--recovery-certificate-hash", "--recovery-proposal", "--recovery-approval", "--recovery-approval-hash", "--primary-bundle-manifest", "--successor-certificate", "--successor-certificate-hash", "--successor-proposal", "--successor-approval", "--successor-approval-hash"] as const;
const SOURCE_FLAGS = [...OLD_FLAGS, "--source-manifest", "--source-step-up-ledger", "--source-step-up-ack"] as const;
const REVIEW_FLAGS = [...SOURCE_FLAGS, "--observer-startup", "--observer-probe"] as const;
const EXECUTION_FLAGS = [...SOURCE_FLAGS, "--fresh-certificate", "--fresh-certificate-hash", "--fresh-proposal", "--fresh-approval", "--fresh-approval-hash", "--journal", "--observer-ledger", "--receiver-ack"] as const;
const KNOWN_FLAGS = new Set<string>([...REVIEW_FLAGS, ...EXECUTION_FLAGS]);
const OBSERVER_WORKFLOW = Object.freeze({ review: FRESH_SUCCESSOR_SCHEDULE.review, execution: FRESH_SUCCESSOR_SCHEDULE.execution, confirmations: FRESH_SUCCESSOR_SCHEDULE.confirmations, delivery: FRESH_SUCCESSOR_SCHEDULE.delivery, acknowledgement: FRESH_SUCCESSOR_SCHEDULE.acknowledgement, keylessConfirmation: FRESH_SUCCESSOR_SCHEDULE.keylessConfirmation });
type Command = typeof USDC_FRESH_SUCCESSOR_COMMANDS[number];
export type UsdcFreshSuccessorCliArguments = Readonly<{ command: Command; values: ReadonlyMap<string, string> }>;

export function parseUsdcFreshSuccessorCliArguments(argv: readonly string[]): UsdcFreshSuccessorCliArguments {
  const args = [...argv], command = args.shift();
  if (!USDC_FRESH_SUCCESSOR_COMMANDS.includes(command as Command)) throw new Error("unknown fresh USDC successor command");
  const values = new Map<string, string>();
  while (args.length) { const flag = args.shift()!, value = args.shift(); if (!KNOWN_FLAGS.has(flag) || !value || values.has(flag)) throw new Error("fresh USDC successor arguments are malformed"); values.set(flag, value); }
  const allowed = new Set<string>(command === "review" ? REVIEW_FLAGS : EXECUTION_FLAGS);
  if ([...values.keys()].some(flag => !allowed.has(flag))) throw new Error("fresh USDC successor flag is not valid for this command");
  return Object.freeze({ command: command as Command, values });
}

const required = (args: UsdcFreshSuccessorCliArguments, flag: string): string => { const value = args.values.get(flag); if (!value) throw new Error(`fresh USDC successor requires ${flag}`); return value; };
const requiredHash = (args: UsdcFreshSuccessorCliArguments, flag: string): Hex => { const value = required(args, flag); if (!HASH.test(value)) throw new Error(`fresh USDC successor ${flag} is malformed`); return value as Hex; };
const readPublicText = (path: string, label: string): string => { try { return readFileSync(path, "utf8"); } catch { throw new Error(`fresh USDC successor ${label} is unavailable`); } };
const publicComparable = (value: unknown): string => JSON.stringify(value, (_, child) => typeof child === "bigint" ? child.toString() : child);
const publicJson = (value: unknown): string => `${publicComparable(value)}\n`;
const rawSha256 = (value: string): Hex => `0x${createHash("sha256").update(value).digest("hex")}` as Hex;
const object = (value: unknown, label: string): Record<string, unknown> => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`); return value as Record<string, unknown>; };
const exactKeys = (value: Record<string, unknown>, expected: readonly string[], label: string): void => { const actual = Object.keys(value).sort(), wanted = [...expected].sort(); if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(`${label} shape mismatch`); };
const knownPendingReconciliation = (journal: OrdinaryScenarioJournal): Readonly<{ outerNonce: number }> => {
  const actions = journal.usdcFreshSuccessor?.actions.filter(action => action.status === "outer-pending") ?? [], live = journal.liveJournal.entries.filter(entry => entry.status === "pending");
  if (actions.length !== 1 || live.length !== 1) throw new Error("fresh USDC successor resume-one requires exactly one durable pending action");
  const action = actions[0] as Record<string, unknown>, entry = live[0]!, outerNonce = action.outerNonce;
  if (typeof outerNonce !== "number" || !Number.isSafeInteger(outerNonce) || outerNonce < 0 || action.id !== entry.id || action.intentHash !== entry.intentHash || action.transactionHash !== entry.transactionHash || outerNonce !== entry.nonce || typeof action.intentHash !== "string" || !HASH.test(action.intentHash) || typeof action.transactionHash !== "string" || !HASH.test(action.transactionHash)) throw new Error("fresh USDC successor pending action and live entry are not exactly bound");
  return Object.freeze({ outerNonce });
};

export function createUsdcFreshSuccessorObserverBinding(startupText: string, probeText: string, now: Date): ContinuationObserverBinding {
  let startupRaw: unknown; let probeRaw: unknown;
  try { startupRaw = JSON.parse(startupText); probeRaw = JSON.parse(probeText); } catch { throw new Error("fresh USDC successor observer proof must be JSON"); }
  const startup = object(startupRaw, "fresh USDC successor observer startup proof"), probe = object(probeRaw, "fresh USDC successor observer probe proof");
  exactKeys(startup, ["schemaVersion", "scope", "publicId", "endpointHash", "startedAt", "expiresAt", "signing", "broadcast"], "fresh USDC successor observer startup proof");
  exactKeys(probe, ["schemaVersion", "scope", "publicId", "endpointHash", "startupEvidenceHash", "probedAt", "expiresAt", "delivery", "acknowledgement", "signing", "broadcast"], "fresh USDC successor observer probe proof");
  const startupEvidenceHash = rawSha256(startupText), probeEvidenceHash = rawSha256(probeText), publicId = startup.publicId, endpointHash = startup.endpointHash;
  if (startup.schemaVersion !== 1 || startup.scope !== "USDC_FRESH_SUCCESSOR_OBSERVER_STARTUP_V1" || startup.signing !== false || startup.broadcast !== false || probe.schemaVersion !== 1 || probe.scope !== "USDC_FRESH_SUCCESSOR_OBSERVER_PROBE_V1" || probe.signing !== false || probe.broadcast !== false || probe.delivery !== "DELIVERED" || probe.acknowledgement !== "ACKNOWLEDGED" || typeof publicId !== "string" || typeof endpointHash !== "string" || !HASH.test(endpointHash) || publicId !== `temporary-test-receiver:${endpointHash}` || probe.publicId !== publicId || probe.endpointHash !== endpointHash || probe.startupEvidenceHash !== startupEvidenceHash || probe.expiresAt !== startup.expiresAt) throw new Error("fresh USDC successor observer startup/probe binding mismatch");
  const startedAt = Date.parse(String(startup.startedAt)), readyAt = Date.parse(String(probe.probedAt)), expiresAt = Date.parse(String(startup.expiresAt)), nowMs = now.getTime();
  if (![startedAt, readyAt, expiresAt, nowMs].every(Number.isFinite) || startedAt > readyAt || readyAt > nowMs) throw new Error("fresh USDC successor observer readiness is future or unordered");
  const readySeconds = BigInt(Math.floor(readyAt / 1000)), expirySeconds = BigInt(Math.floor(expiresAt / 1000)), nowSeconds = BigInt(Math.floor(nowMs / 1000)), budget = 11_640n;
  if (expirySeconds - readySeconds < budget || expirySeconds - nowSeconds < budget) throw new Error("fresh USDC successor observer remaining TTL is insufficient");
  return Object.freeze({ kind: "https-webhook", publicId, endpointHash: endpointHash as Hex, startupEvidenceHash, probeEvidenceHash, independentFromProposer: true, readyAt: readySeconds.toString(), workflowScheduleSeconds: OBSERVER_WORKFLOW, requiredThrough: (readySeconds + budget).toString(), expiresAt: expirySeconds.toString() });
}

export type UsdcFreshSuccessorPublicProviders = Readonly<{ predecessor: UsdcSuccessorPublicProviders; fresh(source: UsdcRecycleContinuationSource): readonly [UsdcFreshSuccessorEvidenceProvider, UsdcFreshSuccessorEvidenceProvider] | Promise<readonly [UsdcFreshSuccessorEvidenceProvider, UsdcFreshSuccessorEvidenceProvider]>; now?: () => Date }>;
export type UsdcFreshSuccessorPublicInputs = Readonly<{ source: UsdcRecycleContinuationSource; certificate: VerifiedUsdcFreshSuccessorCertificate; successor: UsdcFreshSuccessorProposal; approval?: UsdcFreshSuccessorApproval }>;

function predecessorArguments(args: UsdcFreshSuccessorCliArguments) { const argv: string[] = ["submit-one"]; for (const flag of OLD_FLAGS) argv.push(flag, required(args, flag)); return parseUsdcSuccessorCliArguments(argv); }
function loadPrimary(args: UsdcFreshSuccessorCliArguments): UsdcRecycleContinuationPrimaryEvidence { return Object.freeze({ manifest: readPublicText(required(args, "--source-manifest"), "source manifest"), stepUpLedger: readPublicText(required(args, "--source-step-up-ledger"), "source step-up ledger"), stepUpAcknowledgement: readPublicText(required(args, "--source-step-up-ack"), "source step-up acknowledgement") }); }

export async function loadUsdcFreshSuccessorPublicInputs(args: UsdcFreshSuccessorCliArguments, providers: UsdcFreshSuccessorPublicProviders, descendantReconciliation?: Readonly<{ outerNonce: number }>): Promise<UsdcFreshSuccessorPublicInputs> {
  const journal = loadUsdcRecycleContinuationSourceJournalReadOnly(required(args, "--source-journal"), args.command === "review" ? "initial" : "pinned");
  adoptHashlessSourceJournalReadOnlySnapshot(required(args, "--source-journal"), journal);
  const prior = await loadUsdcSuccessorPublicInputs(predecessorArguments(args), providers.predecessor, journal);
  if (!prior.approval) throw new Error("fresh USDC successor predecessor approval is unavailable");
  if (journal.usdcRecycleContinuation !== undefined || journal.repairContinuation !== undefined) throw new Error("fresh USDC successor source is frozen by a recycle or repair descendant");
  const source = Object.freeze({ prior: prior.source, priorCertificate: prior.certificate, priorProposal: prior.successor, priorApproval: prior.approval }), primary = loadPrimary(args), freshProviders = await providers.fresh(source);
  if (args.command === "review") {
    const certificate = await verifyUsdcFreshSuccessorCertificate(source, primary, freshProviders);
    const observer = createUsdcFreshSuccessorObserverBinding(readPublicText(required(args, "--observer-startup"), "observer startup"), readPublicText(required(args, "--observer-probe"), "observer probe"), (providers.now ?? (() => new Date()))());
    const successor = createUsdcFreshSuccessorProposal({ source, certificate, observer, caps: USDC_FRESH_SUCCESSOR_CAPS });
    return Object.freeze({ source, certificate, successor });
  }
  if (descendantReconciliation !== undefined && args.command !== "submit-one") throw new Error("fresh USDC successor descendant reconciliation requires predecessor-only loading");
  const reconciliation = args.command === "resume-one" ? knownPendingReconciliation(journal) : descendantReconciliation;
  const certificate = await reverifyUsdcFreshSuccessorCertificate(readPublicText(required(args, "--fresh-certificate"), "certificate"), requiredHash(args, "--fresh-certificate-hash"), source, primary, freshProviders, reconciliation);
  const successor = parseUsdcFreshSuccessorProposal(readPublicText(required(args, "--fresh-proposal"), "proposal"), source, certificate);
  const approval = loadUsdcFreshSuccessorApproval(successor, readPublicText(required(args, "--fresh-approval"), "approval"), requiredHash(args, "--fresh-approval-hash"));
  return Object.freeze({ source, certificate, successor, approval });
}

export type UsdcFreshSuccessorCliDependencies = Readonly<{ environment: Readonly<Record<string, string | undefined>>; providers: UsdcFreshSuccessorPublicProviders; now?: () => Date; publicPreflight?(mode: "review" | "submit-one", inputs: UsdcFreshSuccessorPublicInputs): Promise<void>; createExecutionContext?(mode: "submit-one" | "resume-one", inputs: UsdcFreshSuccessorPublicInputs, journal: () => OrdinaryScenarioJournal): Promise<OrdinaryScenarioExecutionContext> }>;
function assertEnvironment(command: Command, environment: Readonly<Record<string, string | undefined>>): void {
  for (const key of ["SEPOLIA_RPC_URL", "SEPOLIA_ARCHIVE_RPC_URL", "ORDINARY_SCENARIO_OBSERVER"]) if (environment[key] !== undefined) throw new Error("fresh USDC successor public endpoint overrides are forbidden");
  if (command !== "submit-one") for (const key of PRIVATE_ENV) if (environment[key] !== undefined) throw new Error("fresh USDC successor private authority is forbidden for this command");
  if (command === "submit-one" && environment.LIVE_SUBMIT !== "YES") throw new Error("fresh USDC successor submit-one requires exact live approval switch");
  const allowed = new Set(command === "submit-one" ? ["LIVE_SUBMIT", "LIVE_FUNDING_KEY_FILE", "LIVE_PRIMARY_CREDENTIAL_FILE", "LIVE_SECONDARY_CREDENTIAL_FILE", "LIVE_ECDSA_KEY_FILE"] : []);
  for (const key of Object.keys(environment)) if ((key.startsWith("LIVE_") || key === "PRIVATE_KEY" || key.startsWith("VAULT_")) && !allowed.has(key)) throw new Error("fresh USDC successor unsupported authority input");
}

async function execute(command: "submit-one" | "resume-one", args: UsdcFreshSuccessorCliArguments, dependencies: UsdcFreshSuccessorCliDependencies): Promise<Readonly<Record<string, unknown>>> {
  const inputs = await loadUsdcFreshSuccessorPublicInputs(args, { ...dependencies.providers, now: dependencies.now ?? dependencies.providers.now });
  if (!inputs.approval) throw new Error("fresh USDC successor execution requires exact approval");
  if (command === "submit-one") { if (!dependencies.publicPreflight) throw new Error("fresh USDC successor public submission preflight is unavailable"); await dependencies.publicPreflight("submit-one", inputs); }
  const journalPath = required(args, "--journal"); if (journalPath !== required(args, "--source-journal")) throw new Error("fresh USDC successor must use the same physical source journal");
  const sourceBeforeAttachment = publicComparable(inputs.source.prior.journal);
  const attachedCandidate = command === "submit-one" && !inputs.source.prior.journal.usdcFreshSuccessor ? attachUsdcFreshSuccessor(inputs.source.prior.journal, inputs.successor, inputs.approval) : undefined;
  const original = inputs.source.prior.original;
  const store = createOrdinaryScenarioStore(journalPath, { proposalHash: original.proposalHash, approvalHash: inputs.source.prior.recovery.source.originalApprovalHash, funder: original.funder }, () => { throw new Error("fresh USDC successor source journal is required"); });
  try {
    let current = store.load();
    if (!current.usdcFreshSuccessor) {
      if (command === "resume-one") throw new Error("fresh USDC successor resume-one requires an attached successor");
      if (!attachedCandidate || publicComparable(current) !== sourceBeforeAttachment) throw new Error("fresh USDC successor source changed before attachment under the writer lease");
      current = attachedCandidate; store.save(current);
    }
    const pending = current.usdcFreshSuccessor!.actions.filter(action => action.status === "outer-pending");
    if (command === "resume-one" && pending.length !== 1) throw new Error("fresh USDC successor resume-one requires exactly one durable pending action");
    if (command === "submit-one" && pending.length !== 0) throw new Error("fresh USDC successor submit-one refuses a pending action");
    if (!dependencies.createExecutionContext) throw new Error("fresh USDC successor execution context is unavailable");
    const context = await dependencies.createExecutionContext(command, inputs, () => store.load());
    return await executeUsdcFreshSuccessorAction(inputs.source, inputs.successor, inputs.approval, store, context);
  } finally { store.close?.(); }
}

export async function runUsdcFreshSuccessorCli(argv: readonly string[], dependencies: UsdcFreshSuccessorCliDependencies): Promise<Readonly<Record<string, unknown>>> {
  const args = parseUsdcFreshSuccessorCliArguments(argv); assertEnvironment(args.command, dependencies.environment);
  if (args.command !== "review") return execute(args.command, args, dependencies);
  const inputs = await loadUsdcFreshSuccessorPublicInputs(args, { ...dependencies.providers, now: dependencies.now ?? dependencies.providers.now });
  assertUsdcFreshSuccessorAdmission(inputs.successor, inputs.successor.actions[0]!.id, BigInt(inputs.certificate.snapshot.timestamp), (dependencies.now ?? (() => new Date()))(), "review");
  if (!dependencies.publicPreflight) throw new Error("fresh USDC successor public review preflight is unavailable");
  await dependencies.publicPreflight("review", inputs);
  return Object.freeze({ schemaVersion: 1, scope: "ORDINARY_USDC_FRESH_SUCCESSOR_UNSIGNED_REVIEW_V1", authorization: "NONE", certificate: JSON.parse(serializeUsdcFreshSuccessorCertificate(inputs.certificate)), successor: inputs.successor, certificateHash: inputs.certificate.certificateHash, proposalHash: inputs.successor.proposalHash, actionCount: 18, caps: inputs.successor.caps, signing: false, broadcast: false });
}

type ProductionProviderOptions = Readonly<{ reconstructed(): ReturnType<typeof reconstructReviewedPlan>; queueActions?: Parameters<typeof createUsdcSuccessorEvidenceProvider>[2]["queueActions"] }>;
export function createUsdcFreshSuccessorEvidenceProvider(client: ReturnType<typeof createPublicClient>, source: UsdcRecycleContinuationSource, options: ProductionProviderOptions): UsdcFreshSuccessorEvidenceProvider {
  const predecessor = createUsdcSuccessorEvidenceProvider(client, source.prior, options);
  return Object.freeze({
    ...predecessor,
    readFaucetTransferLog: async (hash: Hex) => { try {
      const receipt = await client.getTransactionReceipt({ hash }); const decoded = [] as Array<ReturnType<UsdcFreshSuccessorEvidenceProvider["readFaucetTransferLog"]> extends Promise<infer T> ? NonNullable<T> : never>;
      for (const log of receipt.logs) { try { const event = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics }); if (event.eventName !== "Transfer") continue; const args = event.args as { from: Address; to: Address; value: bigint }; decoded.push({ address: log.address, transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, logIndex: log.logIndex, removed: log.removed, from: args.from, to: args.to, amount: args.value }); } catch { continue; } }
      return decoded.length === 1 ? decoded[0] : undefined;
    } catch { return undefined; } },
  });
}

type ProductionSeams = Readonly<{ createHarness?: typeof createOrdinaryScenarioProductionHarness; createStateReader?: typeof createOrdinaryScenarioStateReader; createExecutionContext?: typeof createOrdinaryScenarioExecutionContext; now?: () => Date }>;
export function createUsdcFreshSuccessorProductionDependencies(repository: string, argv: readonly string[], seams: ProductionSeams = {}): UsdcFreshSuccessorCliDependencies {
  const baseHarness: OrdinaryScenarioProductionHarness = (seams.createHarness ?? createOrdinaryScenarioProductionHarness)(repository);
  const currentClient = seams.createHarness ? baseHarness.current : createPublicClient({ chain: sepolia, transport: http(PUBLIC_HISTORICAL_EVIDENCE_RPC, { retryCount: 0 }) });
  const archiveClient = seams.createHarness ? baseHarness.archive : createPublicClient({ chain: sepolia, transport: http(PUBLIC_ARCHIVE_RPC, { retryCount: 0 }) });
  const current = withOnePinnedGetCodeRetry(currentClient), archive = withOnePinnedGetCodeRetry(archiveClient), harness = Object.freeze({ ...baseHarness, current, archive });
  const args = parseUsdcFreshSuccessorCliArguments(argv); let reconstruction: ReturnType<typeof reconstructReviewedPlan> | undefined; const reconstructed = () => reconstruction ??= reconstructReviewedPlan(repository, archive);
  const predecessor: UsdcSuccessorPublicProviders = { recovery: [createHashlessEvidenceProvider(current), createHashlessEvidenceProvider(archive)], successor: source => [createUsdcSuccessorEvidenceProvider(current, source, { reconstructed }), createUsdcSuccessorEvidenceProvider(archive, source, { reconstructed })] };
  const providers: UsdcFreshSuccessorPublicProviders = { predecessor, fresh: source => [createUsdcFreshSuccessorEvidenceProvider(current, source, { reconstructed }), createUsdcFreshSuccessorEvidenceProvider(archive, source, { reconstructed })] };
  const readiness = (inputs: UsdcFreshSuccessorPublicInputs) => async () => ({ ready: true, evidenceHash: inputs.successor.observer.probeEvidenceHash }); const now = seams.now ?? (() => new Date());
  return {
    environment: process.env, providers, now,
    publicPreflight: async (mode, inputs) => { const view = createUsdcFreshSuccessorExecutionView(inputs.source, inputs.successor, inputs.approval); const action = !inputs.source.prior.journal.usdcFreshSuccessor ? inputs.successor.actions[0]! : inputs.approval ? selectUsdcFreshSuccessorSubmissionAction(inputs.source, inputs.successor, inputs.approval, inputs.source.prior.journal) : inputs.successor.actions[0]!; const selected = view.proposal.actions.find(candidate => candidate.id === action.id)!; const reader = (seams.createStateReader ?? createOrdinaryScenarioStateReader)({ repository, proposal: view, journal: () => inputs.source.prior.journal, currentClient: current, archiveClient: archive, observerReadiness: readiness(inputs) }); const state = await reader(selected, "pre-private"); assertUsdcFreshSuccessorAdmission(inputs.successor, action.id, state.blockTimestamp, now(), mode === "review" ? "review" : "scenario"); },
    createExecutionContext: async (mode, inputs, journal) => { const view = createUsdcFreshSuccessorExecutionView(inputs.source, inputs.successor, inputs.approval); const live = await harness.createLiveContext(mode, inputs.source.prior.original.funder, async () => {}); return (seams.createExecutionContext ?? createOrdinaryScenarioExecutionContext)({ repository, proposal: view, journal, currentClient: current, archiveClient: archive, observerReadiness: readiness(inputs), live, loadSigners: createOrdinaryScenarioClosedSignerLoader(repository, harness, inputs.source.prior.original), observerLedgerPath: args.values.get("--observer-ledger"), receiverAcknowledgementPath: args.values.get("--receiver-ack"), observerEndpointHash: inputs.successor.observer.endpointHash, receiverReadyAt: new Date(Number(BigInt(inputs.successor.observer.readyAt)) * 1000).toISOString(), receiverExpiresAt: new Date(Number(BigInt(inputs.successor.observer.expiresAt)) * 1000).toISOString(), now }); },
  };
}

export type UsdcFreshSuccessorMainOptions = Readonly<{ repository?: string; dependencies?: UsdcFreshSuccessorCliDependencies; writeStdout?(value: string): void }>;
export async function main(argv = process.argv.slice(2), options: UsdcFreshSuccessorMainOptions = {}): Promise<void> { const repository = options.repository ?? process.cwd().replace(/\/packages\/security-core$/, ""); const result = await runUsdcFreshSuccessorCli(argv, options.dependencies ?? createUsdcFreshSuccessorProductionDependencies(repository, argv)); (options.writeStdout ?? (value => process.stdout.write(value)))(publicJson(result)); }
const processOutput: OperationalCliOutput = Object.freeze({ writeStderr: value => process.stderr.write(value), setExitCode: value => { process.exitCode = value; } });
export async function runUsdcFreshSuccessorEntryPoint(task: Promise<void>, output: OperationalCliOutput = processOutput): Promise<void> { try { await task; } catch { output.writeStderr("[ORDINARY_USDC_FRESH_SUCCESSOR_FAILED] ordinary USDC fresh successor failed\n"); output.setExitCode(1); } }
if (require.main === module) void runUsdcFreshSuccessorEntryPoint(main());
