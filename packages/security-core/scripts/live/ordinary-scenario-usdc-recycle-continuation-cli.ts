import { readFileSync } from "node:fs";
import { createPublicClient, http, type Hex } from "viem";
import { sepolia } from "viem/chains";
import {
  createOrdinaryScenarioStore,
  createUsdcRecycleContinuationExecutionView,
  executeUsdcRecycleContinuationAction,
  selectUsdcRecycleContinuationSubmissionAction,
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
  reverifyUsdcRecycleContinuationCertificate,
  serializeUsdcRecycleContinuationCertificate,
  verifyUsdcRecycleContinuationCertificate,
  loadUsdcRecycleContinuationSourceJournalReadOnly,
  type UsdcRecycleContinuationPrimaryEvidence,
  type UsdcRecycleContinuationSource,
  type VerifiedUsdcRecycleContinuationCertificate,
} from "./ordinary-scenario-usdc-recycle-continuation-certificate";
import {
  assertUsdcRecycleContinuationAdmission,
  attachUsdcRecycleContinuation,
  createUsdcRecycleContinuationProposal,
  loadUsdcRecycleContinuationApproval,
  parseUsdcRecycleContinuationProposal,
  type UsdcRecycleContinuationApproval,
  type UsdcRecycleContinuationProposal,
} from "./ordinary-scenario-usdc-recycle-continuation-proposal";
import type { OperationalCliOutput } from "./operational-cli-entrypoint";
import { PUBLIC_ARCHIVE_RPC, PUBLIC_CURRENT_RPC, reconstructReviewedPlan } from "./ordinary-scenario-review-cli";

export const USDC_RECYCLE_CONTINUATION_COMMANDS = Object.freeze(["review", "submit-one", "resume-one"] as const);
const CAPS = Object.freeze({ fundingGasLimit: "740292", safeExecutionGasLimit: "2000000", publicDelayGasLimit: "300000", maxFeePerGas: "1000000", maxPriorityFeePerGas: "1000000" });
const HASH = /^0x[0-9a-fA-F]{64}$/;
const PRIVATE_ENV = ["LIVE_FUNDING_KEY_FILE", "LIVE_PRIMARY_CREDENTIAL_FILE", "LIVE_SECONDARY_CREDENTIAL_FILE", "LIVE_ECDSA_KEY_FILE", "PRIVATE_KEY", "VAULT_FUNDING_KEY_PATH"] as const;
const OLD_COMMON_FLAGS = ["--source-journal", "--original-report", "--original-package-hash", "--original-artifact-hash", "--original-proposal-hash", "--recovery-certificate", "--recovery-certificate-hash", "--recovery-proposal", "--recovery-approval", "--recovery-approval-hash", "--primary-bundle-manifest", "--successor-certificate", "--successor-certificate-hash", "--successor-proposal", "--successor-approval", "--successor-approval-hash"] as const;
const SOURCE_FLAGS = [...OLD_COMMON_FLAGS, "--source-manifest", "--source-step-up-ledger", "--source-step-up-ack"] as const;
const REVIEW_FLAGS = SOURCE_FLAGS;
const EXECUTION_FLAGS = [...SOURCE_FLAGS, "--recycle-certificate", "--recycle-certificate-hash", "--recycle-proposal", "--recycle-approval", "--recycle-approval-hash", "--journal", "--observer-ledger", "--receiver-ack"] as const;
const KNOWN_FLAGS = new Set<string>([...REVIEW_FLAGS, ...EXECUTION_FLAGS]);

type Command = typeof USDC_RECYCLE_CONTINUATION_COMMANDS[number];
export type UsdcRecycleContinuationCliArguments = Readonly<{ command: Command; values: ReadonlyMap<string, string> }>;

export function parseUsdcRecycleContinuationCliArguments(argv: readonly string[]): UsdcRecycleContinuationCliArguments {
  const args = [...argv], rawCommand = args.shift();
  if (!USDC_RECYCLE_CONTINUATION_COMMANDS.includes(rawCommand as Command)) throw new Error("unknown USDC recycle continuation command");
  const values = new Map<string, string>();
  while (args.length) {
    const flag = args.shift()!, value = args.shift();
    if (!KNOWN_FLAGS.has(flag) || !value || values.has(flag)) throw new Error("USDC recycle continuation arguments are malformed");
    values.set(flag, value);
  }
  const allowed = new Set<string>(rawCommand === "review" ? REVIEW_FLAGS : EXECUTION_FLAGS);
  if ([...values.keys()].some(flag => !allowed.has(flag))) throw new Error("USDC recycle continuation flag is not valid for this command");
  return Object.freeze({ command: rawCommand as Command, values });
}

const required = (args: UsdcRecycleContinuationCliArguments, flag: string): string => { const value = args.values.get(flag); if (!value) throw new Error(`USDC recycle continuation requires ${flag}`); return value; };
const requiredHash = (args: UsdcRecycleContinuationCliArguments, flag: string): Hex => { const value = required(args, flag); if (!HASH.test(value)) throw new Error(`USDC recycle continuation ${flag} is malformed`); return value as Hex; };
const readPublicText = (path: string, label: string): string => { try { return readFileSync(path, "utf8"); } catch { throw new Error(`USDC recycle continuation ${label} is unavailable`); } };
const publicComparable = (value: unknown): string => JSON.stringify(value, (_, child) => typeof child === "bigint" ? child.toString() : child);
const publicJson = (value: unknown): string => `${publicComparable(value)}\n`;

type Wait = (milliseconds: number) => Promise<void>;
const defaultWait: Wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const errorCode = (error: unknown): unknown => error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;

export function withOnePinnedGetCodeRetry<T>(client: T, wait: Wait = defaultWait): T {
  let retryAvailable = true;
  return new Proxy(client as object, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if ((property !== "getCode" && property !== "getBytecode") || typeof value !== "function") return value;
      return async (...parameters: unknown[]) => {
        try { return await Reflect.apply(value, target, parameters); }
        catch (error) {
          const input = parameters[0];
          const explicitBlock = !!input && typeof input === "object" && Object.prototype.hasOwnProperty.call(input, "blockNumber") && typeof (input as { blockNumber?: unknown }).blockNumber === "bigint" && !Object.prototype.hasOwnProperty.call(input, "blockTag");
          if (!retryAvailable || !explicitBlock || errorCode(error) !== -32001) throw error;
          retryAvailable = false;
          await wait(250);
          return Reflect.apply(value, target, parameters);
        }
      };
    },
  }) as T;
}

export type UsdcRecycleContinuationPublicProviders = Readonly<{
  predecessor: UsdcSuccessorPublicProviders;
  recycle(source: UsdcRecycleContinuationSource): readonly [ReturnType<typeof createUsdcSuccessorEvidenceProvider>, ReturnType<typeof createUsdcSuccessorEvidenceProvider>] | Promise<readonly [ReturnType<typeof createUsdcSuccessorEvidenceProvider>, ReturnType<typeof createUsdcSuccessorEvidenceProvider>]>;
  now?: () => Date;
}>;
export type UsdcRecycleContinuationPublicInputs = Readonly<{ source: UsdcRecycleContinuationSource; certificate: VerifiedUsdcRecycleContinuationCertificate; continuation: UsdcRecycleContinuationProposal; approval?: UsdcRecycleContinuationApproval }>;

function predecessorArguments(args: UsdcRecycleContinuationCliArguments) {
  const argv: string[] = ["submit-one"];
  for (const flag of OLD_COMMON_FLAGS) argv.push(flag, required(args, flag));
  return parseUsdcSuccessorCliArguments(argv);
}

function loadPrimary(args: UsdcRecycleContinuationCliArguments): UsdcRecycleContinuationPrimaryEvidence {
  return Object.freeze({ manifest: readPublicText(required(args, "--source-manifest"), "source manifest"), stepUpLedger: readPublicText(required(args, "--source-step-up-ledger"), "source step-up ledger"), stepUpAcknowledgement: readPublicText(required(args, "--source-step-up-ack"), "source step-up acknowledgement") });
}

export async function loadUsdcRecycleContinuationPublicInputs(args: UsdcRecycleContinuationCliArguments, providers: UsdcRecycleContinuationPublicProviders): Promise<UsdcRecycleContinuationPublicInputs> {
  const journal = loadUsdcRecycleContinuationSourceJournalReadOnly(required(args, "--source-journal"), args.command === "review" ? "initial" : "pinned");
  adoptHashlessSourceJournalReadOnlySnapshot(required(args, "--source-journal"), journal);
  const prior = await loadUsdcSuccessorPublicInputs(predecessorArguments(args), providers.predecessor, journal);
  if (!prior.approval) throw new Error("USDC recycle continuation predecessor approval is unavailable");
  const source = Object.freeze({ prior: prior.source, priorCertificate: prior.certificate, priorProposal: prior.successor, priorApproval: prior.approval });
  const primary = loadPrimary(args), recycleProviders = await providers.recycle(source);
  if (args.command === "review") {
    const certificate = await verifyUsdcRecycleContinuationCertificate(source, primary, recycleProviders);
    const continuation = createUsdcRecycleContinuationProposal({ source, certificate, observer: structuredClone(source.priorProposal.observer), caps: CAPS });
    return Object.freeze({ source, certificate, continuation });
  }
  const certificate = await reverifyUsdcRecycleContinuationCertificate(readPublicText(required(args, "--recycle-certificate"), "certificate"), requiredHash(args, "--recycle-certificate-hash"), source, primary, recycleProviders);
  const continuation = parseUsdcRecycleContinuationProposal(readPublicText(required(args, "--recycle-proposal"), "proposal"), source, certificate);
  const approval = loadUsdcRecycleContinuationApproval(continuation, readPublicText(required(args, "--recycle-approval"), "approval"), requiredHash(args, "--recycle-approval-hash"));
  return Object.freeze({ source, certificate, continuation, approval });
}

export type UsdcRecycleContinuationCliDependencies = Readonly<{
  environment: Readonly<Record<string, string | undefined>>;
  providers: UsdcRecycleContinuationPublicProviders;
  now?: () => Date;
  publicPreflight?(mode: "review" | "submit-one", inputs: UsdcRecycleContinuationPublicInputs): Promise<void>;
  createExecutionContext?(mode: "submit-one" | "resume-one", inputs: UsdcRecycleContinuationPublicInputs, journal: () => OrdinaryScenarioJournal): Promise<OrdinaryScenarioExecutionContext>;
}>;

function assertEnvironment(command: Command, environment: Readonly<Record<string, string | undefined>>): void {
  for (const key of ["SEPOLIA_RPC_URL", "SEPOLIA_ARCHIVE_RPC_URL", "ORDINARY_SCENARIO_OBSERVER"]) if (environment[key] !== undefined) throw new Error("USDC recycle continuation public endpoint overrides are forbidden");
  if (command !== "submit-one") for (const key of PRIVATE_ENV) if (environment[key] !== undefined) throw new Error("USDC recycle continuation private authority is forbidden for this command");
  if (command === "submit-one" && environment.LIVE_SUBMIT !== "YES") throw new Error("USDC recycle continuation submit-one requires exact live approval switch");
  const allowed = new Set(command === "submit-one" ? ["LIVE_SUBMIT", "LIVE_FUNDING_KEY_FILE", "LIVE_PRIMARY_CREDENTIAL_FILE", "LIVE_SECONDARY_CREDENTIAL_FILE", "LIVE_ECDSA_KEY_FILE"] : []);
  for (const key of Object.keys(environment)) if ((key.startsWith("LIVE_") || key === "PRIVATE_KEY" || key.startsWith("VAULT_")) && !allowed.has(key)) throw new Error("USDC recycle continuation unsupported authority input");
}

async function execute(command: "submit-one" | "resume-one", args: UsdcRecycleContinuationCliArguments, dependencies: UsdcRecycleContinuationCliDependencies): Promise<Readonly<Record<string, unknown>>> {
  const inputs = await loadUsdcRecycleContinuationPublicInputs(args, { ...dependencies.providers, now: dependencies.now ?? dependencies.providers.now });
  if (!inputs.approval) throw new Error("USDC recycle continuation execution requires exact approval");
  if (command === "submit-one") await dependencies.publicPreflight?.("submit-one", inputs);
  const journalPath = required(args, "--journal");
  if (journalPath !== required(args, "--source-journal")) throw new Error("USDC recycle continuation must use the same physical source journal");
  const sourceBeforeAttachment = publicComparable(inputs.source.prior.journal);
  const attachedCandidate = command === "submit-one" && !inputs.source.prior.journal.usdcRecycleContinuation ? attachUsdcRecycleContinuation(inputs.source.prior.journal, inputs.continuation, inputs.approval) : undefined;
  const original = inputs.source.prior.original;
  const store = createOrdinaryScenarioStore(journalPath, { proposalHash: original.proposalHash, approvalHash: inputs.source.prior.recovery.source.originalApprovalHash, funder: original.funder }, () => { throw new Error("USDC recycle continuation source journal is required"); });
  try {
    let current = store.load();
    if (!current.usdcRecycleContinuation) {
      if (command === "resume-one") throw new Error("USDC recycle continuation resume-one requires an attached continuation");
      if (!attachedCandidate || publicComparable(current) !== sourceBeforeAttachment) throw new Error("USDC recycle continuation source changed before attachment under the writer lease");
      current = attachedCandidate; store.save(current);
    }
    const pending = current.usdcRecycleContinuation!.actions.filter(action => action.status === "outer-pending");
    if (command === "resume-one" && pending.length !== 1) throw new Error("USDC recycle continuation resume-one requires exactly one durable pending action");
    if (command === "submit-one" && pending.length !== 0) throw new Error("USDC recycle continuation submit-one refuses a pending action");
    if (!dependencies.createExecutionContext) throw new Error("USDC recycle continuation execution context is unavailable");
    const context = await dependencies.createExecutionContext(command, inputs, () => store.load());
    return await executeUsdcRecycleContinuationAction(inputs.source, inputs.continuation, inputs.approval, store, context);
  } finally { store.close?.(); }
}

export async function runUsdcRecycleContinuationCli(argv: readonly string[], dependencies: UsdcRecycleContinuationCliDependencies): Promise<Readonly<Record<string, unknown>>> {
  const args = parseUsdcRecycleContinuationCliArguments(argv); assertEnvironment(args.command, dependencies.environment);
  if (args.command !== "review") return execute(args.command, args, dependencies);
  const inputs = await loadUsdcRecycleContinuationPublicInputs(args, { ...dependencies.providers, now: dependencies.now ?? dependencies.providers.now });
  assertUsdcRecycleContinuationAdmission(inputs.continuation, inputs.continuation.actions[0]!.id, BigInt(inputs.certificate.snapshot.timestamp), (dependencies.now ?? (() => new Date()))(), "review");
  await dependencies.publicPreflight?.("review", inputs);
  return Object.freeze({ schemaVersion: 1, scope: "ORDINARY_USDC_RECYCLE_CONTINUATION_UNSIGNED_REVIEW_V1", authorization: "NONE", certificate: JSON.parse(serializeUsdcRecycleContinuationCertificate(inputs.certificate)), continuation: inputs.continuation, certificateHash: inputs.certificate.certificateHash, proposalHash: inputs.continuation.proposalHash, actionCount: 17, caps: inputs.continuation.caps, signing: false, broadcast: false });
}

type ProductionSeams = Readonly<{ createHarness?: typeof createOrdinaryScenarioProductionHarness; createStateReader?: typeof createOrdinaryScenarioStateReader; createExecutionContext?: typeof createOrdinaryScenarioExecutionContext; wait?: Wait; now?: () => Date }>;
export function createUsdcRecycleContinuationProductionDependencies(repository: string, argv: readonly string[], seams: ProductionSeams = {}): UsdcRecycleContinuationCliDependencies {
  const baseHarness: OrdinaryScenarioProductionHarness = (seams.createHarness ?? createOrdinaryScenarioProductionHarness)(repository);
  const currentClient = seams.createHarness ? baseHarness.current : createPublicClient({ chain: sepolia, transport: http(PUBLIC_CURRENT_RPC, { retryCount: 0 }) });
  const archiveClient = seams.createHarness ? baseHarness.archive : createPublicClient({ chain: sepolia, transport: http(PUBLIC_ARCHIVE_RPC, { retryCount: 0 }) });
  const current = withOnePinnedGetCodeRetry(currentClient, seams.wait), archive = withOnePinnedGetCodeRetry(archiveClient, seams.wait);
  const harness = Object.freeze({ ...baseHarness, current, archive });
  const args = parseUsdcRecycleContinuationCliArguments(argv); let reconstruction: ReturnType<typeof reconstructReviewedPlan> | undefined;
  const reconstructed = () => reconstruction ??= reconstructReviewedPlan(repository, archive);
  const predecessor: UsdcSuccessorPublicProviders = { recovery: [createHashlessEvidenceProvider(current), createHashlessEvidenceProvider(archive)], successor: source => [createUsdcSuccessorEvidenceProvider(current, source, { reconstructed }), createUsdcSuccessorEvidenceProvider(archive, source, { reconstructed })] };
  const providers: UsdcRecycleContinuationPublicProviders = { predecessor, recycle: source => [createUsdcSuccessorEvidenceProvider(current, source.prior, { reconstructed }), createUsdcSuccessorEvidenceProvider(archive, source.prior, { reconstructed })] };
  const readiness = (inputs: UsdcRecycleContinuationPublicInputs) => async () => ({ ready: true, evidenceHash: inputs.continuation.observer.probeEvidenceHash });
  const now = seams.now ?? (() => new Date());
  return {
    environment: process.env, providers, now,
    publicPreflight: async (mode, inputs) => { const view = createUsdcRecycleContinuationExecutionView(inputs.source, inputs.continuation, inputs.approval); const action = !inputs.source.prior.journal.usdcRecycleContinuation ? view.proposal.actions.slice(-17)[0]! : inputs.approval ? selectUsdcRecycleContinuationSubmissionAction(inputs.source, inputs.continuation, inputs.approval, inputs.source.prior.journal) : view.proposal.actions.slice(-17)[0]!; const reader = (seams.createStateReader ?? createOrdinaryScenarioStateReader)({ repository, proposal: view, journal: () => inputs.source.prior.journal, currentClient: current, archiveClient: archive, observerReadiness: readiness(inputs) }); const state = await reader(action, "pre-private"); assertUsdcRecycleContinuationAdmission(inputs.continuation, action.id, state.blockTimestamp, now(), mode === "review" ? "review" : "scenario"); },
    createExecutionContext: async (mode, inputs, journal) => { const view = createUsdcRecycleContinuationExecutionView(inputs.source, inputs.continuation, inputs.approval); const live = await harness.createLiveContext(mode, inputs.source.prior.original.funder, async () => {}); return (seams.createExecutionContext ?? createOrdinaryScenarioExecutionContext)({ repository, proposal: view, journal, currentClient: current, archiveClient: archive, observerReadiness: readiness(inputs), live, loadSigners: createOrdinaryScenarioClosedSignerLoader(repository, harness, inputs.source.prior.original), observerLedgerPath: args.values.get("--observer-ledger"), receiverAcknowledgementPath: args.values.get("--receiver-ack"), observerEndpointHash: inputs.continuation.observer.endpointHash, receiverReadyAt: new Date(Number(BigInt(inputs.continuation.observer.readyAt)) * 1000).toISOString(), receiverExpiresAt: new Date(Number(BigInt(inputs.continuation.observer.expiresAt)) * 1000).toISOString(), now }); },
  };
}

export type UsdcRecycleContinuationMainOptions = Readonly<{ repository?: string; dependencies?: UsdcRecycleContinuationCliDependencies; writeStdout?(value: string): void }>;
export async function main(argv = process.argv.slice(2), options: UsdcRecycleContinuationMainOptions = {}): Promise<void> { const repository = options.repository ?? process.cwd().replace(/\/packages\/security-core$/, ""); const result = await runUsdcRecycleContinuationCli(argv, options.dependencies ?? createUsdcRecycleContinuationProductionDependencies(repository, argv)); (options.writeStdout ?? (value => process.stdout.write(value)))(publicJson(result)); }
const processOutput: OperationalCliOutput = Object.freeze({ writeStderr: value => { process.stderr.write(value); }, setExitCode: value => { process.exitCode = value; } });
export async function runUsdcRecycleContinuationEntryPoint(task: Promise<void>, output: OperationalCliOutput = processOutput): Promise<void> { try { await task; } catch { output.writeStderr("[ORDINARY_USDC_RECYCLE_CONTINUATION_FAILED] ordinary USDC recycle continuation failed\n"); output.setExitCode(1); } }
if (require.main === module) void runUsdcRecycleContinuationEntryPoint(main());
