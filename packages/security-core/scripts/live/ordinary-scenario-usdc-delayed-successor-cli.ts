import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createPublicClient, http, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { createOrdinaryScenarioExecutionContext, createOrdinaryScenarioStateReader } from "./ordinary-scenario-adapter";
import { createOrdinaryScenarioClosedSignerLoader, createOrdinaryScenarioProductionHarness, type OrdinaryScenarioProductionHarness } from "./ordinary-scenario-executor-cli";
import { createOrdinaryScenarioStore, createUsdcDelayedSuccessorExecutionView, executeUsdcDelayedSuccessorAction, selectUsdcDelayedSuccessorSubmissionAction, type OrdinaryScenarioExecutionContext } from "./ordinary-scenario-executor";
import { PUBLIC_ARCHIVE_RPC, PUBLIC_HISTORICAL_EVIDENCE_RPC, reconstructReviewedPlan } from "./ordinary-scenario-review-cli";
import { withOnePinnedGetCodeRetry } from "./ordinary-scenario-usdc-recycle-continuation-cli";
import { createUsdcFreshSuccessorEvidenceProvider } from "./ordinary-scenario-usdc-fresh-successor-cli";
import type { UsdcFreshSuccessorEvidenceProvider } from "./ordinary-scenario-usdc-fresh-successor-certificate";
import { createUsdcDelayedCompletionProductionDependencies, loadUsdcDelayedCompletionPublicInputs, type UsdcDelayedCompletionCliArguments, type UsdcDelayedCompletionPublicProviders } from "./ordinary-scenario-usdc-delayed-completion-cli";
import { createUsdcDelayedSuccessorSource, reverifyUsdcDelayedSuccessorCertificate, serializeUsdcDelayedSuccessorCertificate, verifyUsdcDelayedSuccessorCertificate, type UsdcDelayedSuccessorJournal, type UsdcDelayedSuccessorSource, type VerifiedUsdcDelayedSuccessorCertificate } from "./ordinary-scenario-usdc-delayed-successor-certificate";
import { assertUsdcDelayedSuccessorAdmission, attachUsdcDelayedSuccessor, createUsdcDelayedSuccessorProposal, DELAYED_SUCCESSOR_SCHEDULE, loadUsdcDelayedSuccessorApproval, parseUsdcDelayedSuccessorProposal, type UsdcDelayedSuccessorApproval, type UsdcDelayedSuccessorCodeBinding, type UsdcDelayedSuccessorProposal } from "./ordinary-scenario-usdc-delayed-successor-proposal";
import type { OperationalCliOutput } from "./operational-cli-entrypoint";

export const USDC_DELAYED_SUCCESSOR_COMMANDS = Object.freeze(["review", "submit-one", "resume-one"] as const);
export type UsdcDelayedSuccessorCommand = typeof USDC_DELAYED_SUCCESSOR_COMMANDS[number];
export const USDC_DELAYED_SUCCESSOR_CAPS = Object.freeze({ safeExecutionGasLimit: "2000000", publicDelayGasLimit: "300000", maxFeePerGas: "1000000", maxPriorityFeePerGas: "1000000" } as const);
const HASH = /^0x[0-9a-fA-F]{64}$/;
const PREDECESSOR_FLAGS = ["--source-journal", "--original-report", "--original-package-hash", "--original-artifact-hash", "--original-proposal-hash", "--recovery-certificate", "--recovery-certificate-hash", "--recovery-proposal", "--recovery-approval", "--recovery-approval-hash", "--primary-bundle-manifest", "--successor-certificate", "--successor-certificate-hash", "--successor-proposal", "--successor-approval", "--successor-approval-hash", "--source-manifest", "--source-step-up-ledger", "--source-step-up-ack", "--fresh-certificate", "--fresh-certificate-hash", "--fresh-proposal", "--fresh-approval", "--fresh-approval-hash", "--journal", "--observer-ledger", "--receiver-ack", "--delayed-certificate", "--delayed-certificate-hash", "--delayed-proposal", "--delayed-approval", "--delayed-approval-hash"] as const;
const REVIEW_FLAGS = [...PREDECESSOR_FLAGS, "--observer-startup", "--observer-probe"] as const;
const EXECUTION_FLAGS = [...PREDECESSOR_FLAGS, "--delayed-successor-certificate", "--delayed-successor-certificate-hash", "--delayed-successor-proposal", "--delayed-successor-approval", "--delayed-successor-approval-hash"] as const;
const KNOWN_FLAGS = new Set<string>([...REVIEW_FLAGS, ...EXECUTION_FLAGS]);
const WORKFLOW = Object.freeze({ review: DELAYED_SUCCESSOR_SCHEDULE.review, execution: DELAYED_SUCCESSOR_SCHEDULE.execution, confirmations: DELAYED_SUCCESSOR_SCHEDULE.confirmations, delivery: DELAYED_SUCCESSOR_SCHEDULE.delivery, acknowledgement: DELAYED_SUCCESSOR_SCHEDULE.acknowledgement, keylessConfirmation: DELAYED_SUCCESSOR_SCHEDULE.keylessConfirmation });
export type UsdcDelayedSuccessorCliArguments = Readonly<{ command: UsdcDelayedSuccessorCommand; values: ReadonlyMap<string, string> }>;

export function parseUsdcDelayedSuccessorCommand(argv: readonly string[]): UsdcDelayedSuccessorCommand { if (argv.length !== 1 || !USDC_DELAYED_SUCCESSOR_COMMANDS.includes(argv[0] as UsdcDelayedSuccessorCommand)) throw new Error("unknown delayed successor command"); return argv[0] as UsdcDelayedSuccessorCommand; }
export function parseUsdcDelayedSuccessorCliArguments(argv: readonly string[]): UsdcDelayedSuccessorCliArguments {
  const args = [...argv], command = args.shift(); if (!USDC_DELAYED_SUCCESSOR_COMMANDS.includes(command as UsdcDelayedSuccessorCommand)) throw new Error("unknown delayed successor command");
  const values = new Map<string, string>(); while (args.length) { const flag = args.shift()!, value = args.shift(); if (!KNOWN_FLAGS.has(flag) || !value || values.has(flag)) throw new Error("delayed successor arguments are malformed"); values.set(flag, value); }
  const allowed = new Set<string>(command === "review" ? REVIEW_FLAGS : EXECUTION_FLAGS); if ([...values.keys()].some(flag => !allowed.has(flag))) throw new Error("delayed successor flag is invalid for this command"); return Object.freeze({ command: command as UsdcDelayedSuccessorCommand, values });
}
const required = (args: UsdcDelayedSuccessorCliArguments, flag: string): string => { const value = args.values.get(flag); if (!value) throw new Error(`delayed successor requires ${flag}`); return value; };
const requiredHash = (args: UsdcDelayedSuccessorCliArguments, flag: string): Hex => { const value = required(args, flag); if (!HASH.test(value)) throw new Error(`delayed successor ${flag} is malformed`); return value as Hex; };
const readPublic = (path: string, label: string): string => { try { return readFileSync(path, "utf8"); } catch { throw new Error(`delayed successor ${label} is unavailable`); } };
const rawSha256 = (value: string): Hex => `0x${createHash("sha256").update(value).digest("hex")}` as Hex;
const publicJson = (value: unknown): string => `${JSON.stringify(value, (_, child) => typeof child === "bigint" ? child.toString() : child)}\n`;
const object = (value: unknown, label: string): Record<string, unknown> => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`); return value as Record<string, unknown>; };

export function readUsdcDelayedSuccessorCodeBinding(repository: string): UsdcDelayedSuccessorCodeBinding {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (git("status", "--porcelain") !== "") throw new Error("delayed successor code binding requires a clean tracked worktree");
  const head = rawSha256(`${git("rev-parse", "HEAD")}\n`), tree = rawSha256(`${git("rev-parse", "HEAD^{tree}")}\n`);
  const logHash = rawSha256(`${git("log", "-1", "--format=fuller", "--no-show-signature")}\n`);
  if (![head, tree, logHash].every(value => HASH.test(value))) throw new Error("delayed successor code binding is malformed");
  return Object.freeze({ head, tree, logHash });
}

function predecessorArguments(args: UsdcDelayedSuccessorCliArguments): UsdcDelayedCompletionCliArguments {
  const values = new Map<string, string>(); for (const flag of PREDECESSOR_FLAGS) { const value = args.values.get(flag); if (value) values.set(flag, value); }
  return Object.freeze({ command: "submit-one" as const, values });
}
function predecessorArgv(args: UsdcDelayedSuccessorCliArguments): string[] { const argv = ["submit-one"]; for (const flag of PREDECESSOR_FLAGS) { const value = args.values.get(flag); if (value) argv.push(flag, value); } return argv; }

export function parseUsdcDelayedSuccessorPendingReconciliation(serialized: string): Readonly<{ outerNonce: number }> {
  let value: any; try { value = JSON.parse(serialized); } catch { throw new Error("delayed successor pending journal must be JSON"); }
  const actions = value?.usdcDelayedSuccessor?.actions?.filter((entry: any) => entry?.status === "outer-pending") ?? [];
  if (actions.length !== 1) throw new Error("delayed successor resume requires one exact pending row");
  const action = actions[0], live = value?.liveJournal?.entries?.filter((entry: any) => entry?.id === action.id) ?? [];
  if (live.length !== 1) throw new Error("delayed successor resume requires one exactly bound live envelope");
  const entry = live[0], terminal = entry.status === "success" || entry.status === "reverted", receipt = entry.receipt;
  if (typeof action.id !== "string" || !action.id.startsWith("usdc-delayed-successor-") || typeof action.outerNonce !== "number" || !Number.isSafeInteger(action.outerNonce) || action.outerNonce < 0 || action.id !== entry.id || action.intentHash !== entry.intentHash || action.transactionHash !== entry.transactionHash || action.outerNonce !== entry.nonce || typeof action.intentHash !== "string" || !HASH.test(action.intentHash) || typeof action.transactionHash !== "string" || !HASH.test(action.transactionHash) || !["pending", "success", "reverted"].includes(entry.status) || (entry.status === "pending" && receipt !== undefined) || (terminal && (!receipt || receipt.status !== entry.status || receipt.transactionHash !== entry.transactionHash || !HASH.test(receipt.blockHash)))) throw new Error("delayed successor pending row, receipt, and live envelope are not exactly bound");
  return Object.freeze({ outerNonce: action.outerNonce });
}

export function createUsdcDelayedSuccessorObserverBinding(startupText: string, probeText: string, now: Date) {
  let startupRaw: unknown, probeRaw: unknown; try { startupRaw = JSON.parse(startupText); probeRaw = JSON.parse(probeText); } catch { throw new Error("delayed successor observer proof must be JSON"); }
  const startup = object(startupRaw, "startup"), probe = object(probeRaw, "probe"), startupEvidenceHash = rawSha256(startupText), probeEvidenceHash = rawSha256(probeText), publicId = startup.publicId, endpointHash = startup.endpointHash;
  if (startup.schemaVersion !== 1 || startup.scope !== "USDC_DELAYED_SUCCESSOR_OBSERVER_STARTUP_V1" || startup.signing !== false || startup.broadcast !== false || probe.schemaVersion !== 1 || probe.scope !== "USDC_DELAYED_SUCCESSOR_OBSERVER_PROBE_V1" || probe.signing !== false || probe.broadcast !== false || probe.delivery !== "DELIVERED" || probe.acknowledgement !== "ACKNOWLEDGED" || typeof endpointHash !== "string" || !HASH.test(endpointHash) || publicId !== `temporary-test-receiver:${endpointHash}` || probe.publicId !== publicId || probe.endpointHash !== endpointHash || probe.startupEvidenceHash !== startupEvidenceHash || probe.expiresAt !== startup.expiresAt) throw new Error("delayed successor observer binding mismatch");
  const started = Date.parse(String(startup.startedAt)), readyMs = Date.parse(String(probe.probedAt)), expiryMs = Date.parse(String(startup.expiresAt)), nowMs = now.getTime();
  if (![started, readyMs, expiryMs, nowMs].every(Number.isFinite) || started > readyMs || readyMs > nowMs) throw new Error("delayed successor observer ordering mismatch");
  const ready = BigInt(Math.floor(readyMs / 1000)), expires = BigInt(Math.floor(expiryMs / 1000)), current = BigInt(Math.floor(nowMs / 1000));
  if (expires - ready < 1_800n || expires - current < 1_800n) throw new Error("delayed successor observer TTL is insufficient");
  return Object.freeze({ kind: "https-webhook" as const, publicId: publicId as string, endpointHash: endpointHash as Hex, startupEvidenceHash, probeEvidenceHash, independentFromProposer: true as const, readyAt: ready.toString(), workflowScheduleSeconds: WORKFLOW, requiredThrough: (ready + 1_800n).toString(), expiresAt: expires.toString() });
}

export type UsdcDelayedSuccessorPublicProviders = Readonly<{ predecessor: UsdcDelayedCompletionPublicProviders; successor(source: UsdcDelayedSuccessorSource): readonly [UsdcFreshSuccessorEvidenceProvider, UsdcFreshSuccessorEvidenceProvider] | Promise<readonly [UsdcFreshSuccessorEvidenceProvider, UsdcFreshSuccessorEvidenceProvider]>; codeBinding(): UsdcDelayedSuccessorCodeBinding; now?: () => Date }>;
export type UsdcDelayedSuccessorPublicInputs = Readonly<{ source: UsdcDelayedSuccessorSource; certificate: VerifiedUsdcDelayedSuccessorCertificate; successor: UsdcDelayedSuccessorProposal; approval?: UsdcDelayedSuccessorApproval }>;
export async function loadUsdcDelayedSuccessorPublicInputs(args: UsdcDelayedSuccessorCliArguments, providers: UsdcDelayedSuccessorPublicProviders): Promise<UsdcDelayedSuccessorPublicInputs> {
  const descendant = args.command === "resume-one" ? parseUsdcDelayedSuccessorPendingReconciliation(readPublic(required(args, "--source-journal"), "pending journal")) : undefined;
  const old = await loadUsdcDelayedCompletionPublicInputs(predecessorArguments(args), providers.predecessor, descendant);
  if (!old.approval || !old.source.journal.usdcDelayedCompletion) throw new Error("delayed successor predecessor approval or attachment is unavailable");
  const source = createUsdcDelayedSuccessorSource({ prior: old.source, delayedCertificate: old.certificate, delayedProposal: old.completion, delayedApproval: old.approval, journal: old.source.journal as UsdcDelayedSuccessorJournal }), pair = await providers.successor(source);
  if (args.command === "review") {
    const certificate = await verifyUsdcDelayedSuccessorCertificate(source, pair), observer = createUsdcDelayedSuccessorObserverBinding(readPublic(required(args, "--observer-startup"), "observer startup"), readPublic(required(args, "--observer-probe"), "observer probe"), (providers.now ?? (() => new Date()))()), successor = createUsdcDelayedSuccessorProposal({ source, certificate, observer, caps: USDC_DELAYED_SUCCESSOR_CAPS, codeBinding: providers.codeBinding() });
    return Object.freeze({ source, certificate, successor });
  }
  const certificate = await reverifyUsdcDelayedSuccessorCertificate(readPublic(required(args, "--delayed-successor-certificate"), "certificate"), requiredHash(args, "--delayed-successor-certificate-hash"), source, pair, descendant), successor = parseUsdcDelayedSuccessorProposal(readPublic(required(args, "--delayed-successor-proposal"), "proposal"), source, certificate, providers.codeBinding()), approval = loadUsdcDelayedSuccessorApproval(successor, readPublic(required(args, "--delayed-successor-approval"), "approval"), requiredHash(args, "--delayed-successor-approval-hash"));
  return Object.freeze({ source, certificate, successor, approval });
}

export type UsdcDelayedSuccessorCliDependencies = Readonly<{ environment: Readonly<Record<string, string | undefined>>; providers: UsdcDelayedSuccessorPublicProviders; now?: () => Date; publicPreflight?(mode: "review" | "submit-one", inputs: UsdcDelayedSuccessorPublicInputs): Promise<void>; createExecutionContext?(mode: "submit-one" | "resume-one", inputs: UsdcDelayedSuccessorPublicInputs, journal: () => import("./ordinary-scenario-executor").OrdinaryScenarioJournal): Promise<OrdinaryScenarioExecutionContext> }>;
function assertEnvironment(command: UsdcDelayedSuccessorCommand, environment: Readonly<Record<string, string | undefined>>) { for (const key of ["SEPOLIA_RPC_URL", "SEPOLIA_ARCHIVE_RPC_URL", "ORDINARY_SCENARIO_OBSERVER"]) if (environment[key] !== undefined) throw new Error("delayed successor endpoint overrides are forbidden"); if (command === "submit-one" && environment.LIVE_SUBMIT !== "YES") throw new Error("delayed successor submit-one requires exact live switch"); if (command !== "submit-one" && Object.keys(environment).some(key => (key.startsWith("LIVE_") || key === "PRIVATE_KEY" || key.startsWith("VAULT_")) && environment[key] !== undefined)) throw new Error("delayed successor private authority is forbidden"); }

async function execute(command: "submit-one" | "resume-one", args: UsdcDelayedSuccessorCliArguments, deps: UsdcDelayedSuccessorCliDependencies) {
  const inputs = await loadUsdcDelayedSuccessorPublicInputs(args, { ...deps.providers, now: deps.now ?? deps.providers.now }); if (!inputs.approval) throw new Error("delayed successor approval is unavailable");
  if (command === "submit-one") { if (!deps.publicPreflight) throw new Error("delayed successor preflight is unavailable"); await deps.publicPreflight("submit-one", inputs); }
  const path = required(args, "--journal"); if (path !== required(args, "--source-journal")) throw new Error("delayed successor requires one physical journal");
  const candidate = command === "submit-one" && !inputs.source.journal.usdcDelayedSuccessor ? attachUsdcDelayedSuccessor(inputs.source.journal, inputs.successor, inputs.approval) : undefined, original = inputs.source.prior.historical.prior.original, store = createOrdinaryScenarioStore(path, { proposalHash: original.proposalHash, approvalHash: inputs.source.prior.historical.prior.recovery.source.originalApprovalHash, funder: original.funder }, () => { throw new Error("delayed successor source journal is required"); });
  try {
    let current = store.load(); if (!current.usdcDelayedSuccessor) { if (!candidate || command === "resume-one") throw new Error("delayed successor attachment unavailable"); current = candidate; store.save(current); }
    const pending = current.usdcDelayedSuccessor!.actions.filter(action => action.status === "outer-pending"); if (command === "resume-one" && pending.length !== 1) throw new Error("resume-one requires one pending action"); if (command === "submit-one" && pending.length !== 0) throw new Error("submit-one refuses pending action");
    if (!deps.createExecutionContext) throw new Error("delayed successor execution context unavailable");
    return await executeUsdcDelayedSuccessorAction(inputs.source, inputs.successor, inputs.approval, store, await deps.createExecutionContext(command, inputs, () => store.load()));
  } finally { store.close?.(); }
}

export async function runUsdcDelayedSuccessorCli(argv: readonly string[], deps: UsdcDelayedSuccessorCliDependencies) {
  const args = parseUsdcDelayedSuccessorCliArguments(argv); assertEnvironment(args.command, deps.environment); if (args.command !== "review") return execute(args.command, args, deps);
  const inputs = await loadUsdcDelayedSuccessorPublicInputs(args, { ...deps.providers, now: deps.now ?? deps.providers.now }); assertUsdcDelayedSuccessorAdmission(inputs.successor, inputs.successor.actions[0]!.id, BigInt(inputs.certificate.snapshot.timestamp), (deps.now ?? (() => new Date()))(), "review"); if (!deps.publicPreflight) throw new Error("delayed successor review preflight unavailable"); await deps.publicPreflight("review", inputs);
  return Object.freeze({ schemaVersion: 1, scope: "ORDINARY_USDC_DELAYED_SUCCESSOR_UNSIGNED_REVIEW_V1", authorization: "NONE", certificate: JSON.parse(serializeUsdcDelayedSuccessorCertificate(inputs.certificate)), successor: inputs.successor, certificateHash: inputs.certificate.certificateHash, proposalHash: inputs.successor.proposalHash, actionCount: 5, signing: false, broadcast: false });
}

export function createUsdcDelayedSuccessorProductionDependencies(repository: string, argv: readonly string[], seams: Readonly<{ createHarness?: typeof createOrdinaryScenarioProductionHarness; createStateReader?: typeof createOrdinaryScenarioStateReader; createExecutionContext?: typeof createOrdinaryScenarioExecutionContext; now?: () => Date }> = {}): UsdcDelayedSuccessorCliDependencies {
  const base: OrdinaryScenarioProductionHarness = (seams.createHarness ?? createOrdinaryScenarioProductionHarness)(repository), currentClient = seams.createHarness ? base.current : createPublicClient({ chain: sepolia, transport: http(PUBLIC_HISTORICAL_EVIDENCE_RPC, { retryCount: 0 }) }), archiveClient = seams.createHarness ? base.archive : createPublicClient({ chain: sepolia, transport: http(PUBLIC_ARCHIVE_RPC, { retryCount: 0 }) }), current = withOnePinnedGetCodeRetry(currentClient), archive = withOnePinnedGetCodeRetry(archiveClient), harness = Object.freeze({ ...base, current, archive }), args = parseUsdcDelayedSuccessorCliArguments(argv), old = createUsdcDelayedCompletionProductionDependencies(repository, predecessorArgv(args), seams);
  let reconstruction: ReturnType<typeof reconstructReviewedPlan> | undefined; const reconstructed = () => reconstruction ??= reconstructReviewedPlan(repository, archive), providers: UsdcDelayedSuccessorPublicProviders = { predecessor: old.providers, successor: source => [createUsdcFreshSuccessorEvidenceProvider(current, source.prior.historical, { reconstructed, queueActions: source.delayedProposal.actions }), createUsdcFreshSuccessorEvidenceProvider(archive, source.prior.historical, { reconstructed, queueActions: source.delayedProposal.actions })], codeBinding: () => readUsdcDelayedSuccessorCodeBinding(repository) }, now = seams.now ?? (() => new Date()), readiness = (inputs: UsdcDelayedSuccessorPublicInputs) => async () => ({ ready: true, evidenceHash: inputs.successor.observer.probeEvidenceHash });
  return { environment: process.env, providers, now, publicPreflight: async (mode, inputs) => { const view = createUsdcDelayedSuccessorExecutionView(inputs.source, inputs.successor, inputs.approval), action = inputs.source.journal.usdcDelayedSuccessor && inputs.approval ? selectUsdcDelayedSuccessorSubmissionAction(inputs.source, inputs.successor, inputs.approval, inputs.source.journal) : inputs.successor.actions[0]!, selected = view.proposal.actions.find(candidate => candidate.id === action.id)!, reader = (seams.createStateReader ?? createOrdinaryScenarioStateReader)({ repository, proposal: view, journal: () => inputs.source.journal, currentClient: current, archiveClient: archive, observerReadiness: readiness(inputs) }), state = await reader(selected, "pre-private"); assertUsdcDelayedSuccessorAdmission(inputs.successor, action.id, state.blockTimestamp, now(), mode === "review" ? "review" : "scenario"); }, createExecutionContext: async (mode, inputs, journal) => { const view = createUsdcDelayedSuccessorExecutionView(inputs.source, inputs.successor, inputs.approval), live = await harness.createLiveContext(mode, inputs.source.prior.historical.prior.original.funder, async () => {}); return (seams.createExecutionContext ?? createOrdinaryScenarioExecutionContext)({ repository, proposal: view, journal, currentClient: current, archiveClient: archive, observerReadiness: readiness(inputs), live, loadSigners: createOrdinaryScenarioClosedSignerLoader(repository, harness, inputs.source.prior.historical.prior.original), observerLedgerPath: args.values.get("--observer-ledger"), receiverAcknowledgementPath: args.values.get("--receiver-ack"), observerEndpointHash: inputs.successor.observer.endpointHash, receiverReadyAt: new Date(Number(BigInt(inputs.successor.observer.readyAt)) * 1000).toISOString(), receiverExpiresAt: new Date(Number(BigInt(inputs.successor.observer.expiresAt)) * 1000).toISOString(), now }); } };
}

export async function main(argv = process.argv.slice(2), options: Readonly<{ repository?: string; dependencies?: UsdcDelayedSuccessorCliDependencies; writeStdout?(value: string): void }> = {}) { const repository = options.repository ?? process.cwd().replace(/\/packages\/security-core$/, ""); const result = await runUsdcDelayedSuccessorCli(argv, options.dependencies ?? createUsdcDelayedSuccessorProductionDependencies(repository, argv)); (options.writeStdout ?? (value => process.stdout.write(value)))(publicJson(result)); }
const processOutput: OperationalCliOutput = Object.freeze({ writeStderr: value => process.stderr.write(value), setExitCode: value => { process.exitCode = value; } });
export async function runUsdcDelayedSuccessorEntryPoint(task: Promise<void>, output: OperationalCliOutput = processOutput) { try { await task; } catch { output.writeStderr("[ORDINARY_USDC_DELAYED_SUCCESSOR_FAILED] delayed successor failed\n"); output.setExitCode(1); } }
if (require.main === module) void runUsdcDelayedSuccessorEntryPoint(main());
