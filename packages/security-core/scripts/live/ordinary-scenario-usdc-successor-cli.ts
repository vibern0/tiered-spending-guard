import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { createPublicClient, erc20Abi, http, keccak256, parseAbi, recoverTransactionAddress, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { createOrdinaryScenarioProposal, createOrdinaryScenarioStore, createUsdcSuccessorExecutionView, executeUsdcSuccessorAction, selectUsdcSuccessorSubmissionAction, type OrdinaryScenarioExecutionContext, type OrdinaryScenarioJournal } from "./ordinary-scenario-executor";
import { createOrdinaryScenarioExecutionContext, createOrdinaryScenarioStateReader, reconstructCanonicalType2Transaction } from "./ordinary-scenario-adapter";
import { createHashlessEvidenceProvider, reconstructCanonicalLegacyTransaction } from "./ordinary-scenario-hashless-continuation-cli";
import { loadHashlessSourceJournalReadOnly, reverifyHashlessStateCertificate, type HashlessEvidenceProvider } from "./ordinary-scenario-hashless-certificate";
import { loadExpiredHashlessContinuationApproval, parseExpiredHashlessContinuationProposal, type ContinuationActionCaps, type ContinuationObserverBinding } from "./ordinary-scenario-hashless-continuation";
import { createOrdinaryScenarioClosedSignerLoader, createOrdinaryScenarioProductionHarness, type OrdinaryScenarioProductionHarness } from "./ordinary-scenario-executor-cli";
import { PUBLIC_ARCHIVE_RPC, PUBLIC_CURRENT_RPC, reconstructReviewedPlan, verifyReconstructedPlanAtBlock } from "./ordinary-scenario-review-cli";
import { assertUsdcSuccessorAdmission, attachUsdcSuccessor, createUsdcSuccessorProposal, loadUsdcSuccessorApproval, parseUsdcSuccessorProposal, USDC_SUCCESSOR_SCHEDULE, type UsdcSuccessorApproval, type UsdcSuccessorProposal } from "./ordinary-scenario-usdc-successor-proposal";
import { reverifyUsdcSuccessorCertificate, serializeUsdcSuccessorCertificate, verifyUsdcSuccessorCertificate, type UsdcSuccessorCanonicalState, type UsdcSuccessorEvidenceProvider, type UsdcSuccessorPrimaryEvidence, type UsdcSuccessorSource, type VerifiedUsdcSuccessorCertificate } from "./ordinary-scenario-usdc-successor-certificate";
import { runOperationalCliEntryPoint, type OperationalCliOutput } from "./operational-cli-entrypoint";

export const USDC_SUCCESSOR_COMMANDS = Object.freeze(["review", "submit-one", "resume-one"] as const);
export const USDC_SUCCESSOR_CAPS = Object.freeze({ fundingGasLimit: "740292", safeExecutionGasLimit: "2000000", publicDelayGasLimit: "300000", maxFeePerGas: "1000000", maxPriorityFeePerGas: "1000000" }) satisfies ContinuationActionCaps;
const OBSERVER_WORKFLOW = Object.freeze({ review: USDC_SUCCESSOR_SCHEDULE.review, execution: USDC_SUCCESSOR_SCHEDULE.execution, confirmations: USDC_SUCCESSOR_SCHEDULE.confirmations, delivery: USDC_SUCCESSOR_SCHEDULE.delivery, acknowledgement: USDC_SUCCESSOR_SCHEDULE.acknowledgement, keylessConfirmation: USDC_SUCCESSOR_SCHEDULE.keylessConfirmation });
const HASH = /^0x[0-9a-fA-F]{64}$/;
const PRIVATE_ENV = ["LIVE_FUNDING_KEY_FILE", "LIVE_PRIMARY_CREDENTIAL_FILE", "LIVE_SECONDARY_CREDENTIAL_FILE", "LIVE_ECDSA_KEY_FILE", "PRIVATE_KEY", "VAULT_FUNDING_KEY_PATH"] as const;
const POLICY_HASH = "0x5b19fb0f9dcc35db4d45ec227f01348985431d74a2092d887bc7b4f26ade4a82" as Hex;
const SAFE_ABI = parseAbi(["function nonce() view returns (uint256)"]);
const DELAY_ABI = parseAbi(["function txNonce() view returns (uint256)", "function queueNonce() view returns (uint256)", "function getTxHash(uint256) view returns (bytes32)", "function getTxCreatedAt(uint256) view returns (uint256)"]);
const GUARD_ABI = parseAbi(["function spendState(address) view returns (uint256,uint256,uint256)"]);
const publicJson = (value: unknown): string => `${JSON.stringify(value, (_, child) => typeof child === "bigint" ? child.toString() : child)}\n`;
const publicComparable = (value: unknown): string => JSON.stringify(value, (_, child) => typeof child === "bigint" ? child.toString() : child);
const rawSha256 = (value: string): Hex => `0x${createHash("sha256").update(value).digest("hex")}` as Hex;
const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const object = (value: unknown, label: string): Record<string, unknown> => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`); return value as Record<string, unknown>; };
const exactKeys = (value: Record<string, unknown>, expected: readonly string[], label: string): void => { const actual = Object.keys(value).sort(), wanted = [...expected].sort(); if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(`${label} shape mismatch`); };
const readPublicText = (path: string, label: string): string => { try { return readFileSync(path, "utf8"); } catch { throw new Error(`USDC successor ${label} is unavailable`); } };
const requiredHashValue = (value: string, label: string): Hex => { if (!HASH.test(value)) throw new Error(`USDC successor ${label} is malformed`); return value as Hex; };

export function createUsdcSuccessorObserverBinding(startupText: string, probeText: string, now: Date): ContinuationObserverBinding {
  let startupRaw: unknown; let probeRaw: unknown;
  try { startupRaw = JSON.parse(startupText); probeRaw = JSON.parse(probeText); } catch { throw new Error("USDC successor observer proof must be JSON"); }
  const startup = object(startupRaw, "USDC successor observer startup proof"), probe = object(probeRaw, "USDC successor observer probe proof");
  exactKeys(startup, ["schemaVersion", "scope", "publicId", "endpointHash", "startedAt", "expiresAt", "signing", "broadcast"], "USDC successor observer startup proof");
  exactKeys(probe, ["schemaVersion", "scope", "publicId", "endpointHash", "startupEvidenceHash", "probedAt", "expiresAt", "delivery", "acknowledgement", "signing", "broadcast"], "USDC successor observer probe proof");
  const startupEvidenceHash = rawSha256(startupText), probeEvidenceHash = rawSha256(probeText), publicId = startup.publicId, endpointHash = startup.endpointHash;
  if (startup.schemaVersion !== 1 || startup.scope !== "USDC_SUCCESSOR_OBSERVER_STARTUP_V1" || startup.signing !== false || startup.broadcast !== false || probe.schemaVersion !== 1 || probe.scope !== "USDC_SUCCESSOR_OBSERVER_PROBE_V1" || probe.signing !== false || probe.broadcast !== false || probe.delivery !== "DELIVERED" || probe.acknowledgement !== "ACKNOWLEDGED" || typeof publicId !== "string" || typeof endpointHash !== "string" || !HASH.test(endpointHash) || publicId !== `temporary-test-receiver:${endpointHash}` || probe.publicId !== publicId || probe.endpointHash !== endpointHash || probe.startupEvidenceHash !== startupEvidenceHash || probe.expiresAt !== startup.expiresAt) throw new Error("USDC successor observer startup/probe binding mismatch");
  const startedAt = Date.parse(String(startup.startedAt)), readyAt = Date.parse(String(probe.probedAt)), expiresAt = Date.parse(String(startup.expiresAt)), nowMs = now.getTime();
  if (![startedAt, readyAt, expiresAt, nowMs].every(Number.isFinite) || startedAt > readyAt || readyAt > nowMs) throw new Error("USDC successor observer readiness is future or unordered");
  const readySeconds = BigInt(Math.floor(readyAt / 1000)), expirySeconds = BigInt(Math.floor(expiresAt / 1000)), nowSeconds = BigInt(Math.floor(nowMs / 1000)), budget = 11_640n;
  if (expirySeconds - readySeconds < budget || expirySeconds - nowSeconds < budget) throw new Error("USDC successor observer remaining TTL is insufficient");
  return Object.freeze({ kind: "https-webhook", publicId, endpointHash: endpointHash as Hex, startupEvidenceHash, probeEvidenceHash, independentFromProposer: true, readyAt: readySeconds.toString(), workflowScheduleSeconds: OBSERVER_WORKFLOW, requiredThrough: (readySeconds + budget).toString(), expiresAt: expirySeconds.toString() });
}

type Command = typeof USDC_SUCCESSOR_COMMANDS[number];
export type UsdcSuccessorCliArguments = Readonly<{ command: Command; values: ReadonlyMap<string, string> }>;
const COMMON_FLAGS = ["--source-journal", "--original-report", "--original-package-hash", "--original-artifact-hash", "--original-proposal-hash", "--recovery-certificate", "--recovery-certificate-hash", "--recovery-proposal", "--recovery-approval", "--recovery-approval-hash", "--primary-bundle-manifest"] as const;
const REVIEW_FLAGS = [...COMMON_FLAGS, "--observer-startup", "--observer-probe"] as const;
const EXECUTION_FLAGS = [...COMMON_FLAGS, "--successor-certificate", "--successor-certificate-hash", "--successor-proposal", "--successor-approval", "--successor-approval-hash", "--journal", "--observer-ledger", "--receiver-ack"] as const;
const KNOWN_FLAGS = new Set<string>([...REVIEW_FLAGS, ...EXECUTION_FLAGS]);
export function parseUsdcSuccessorCliArguments(argv: readonly string[]): UsdcSuccessorCliArguments {
  const args = [...argv], rawCommand = args.shift();
  if (!USDC_SUCCESSOR_COMMANDS.includes(rawCommand as Command)) throw new Error("unknown USDC successor command");
  const values = new Map<string, string>();
  while (args.length) { const flag = args.shift()!, value = args.shift(); if (!KNOWN_FLAGS.has(flag) || !value || values.has(flag)) throw new Error("USDC successor arguments are malformed"); values.set(flag, value); }
  const allowed = new Set<string>(rawCommand === "review" ? REVIEW_FLAGS : EXECUTION_FLAGS); if ([...values.keys()].some(flag => !allowed.has(flag))) throw new Error("USDC successor flag is not valid for this command");
  return Object.freeze({ command: rawCommand as Command, values });
}
const required = (args: UsdcSuccessorCliArguments, flag: string): string => { const value = args.values.get(flag); if (!value) throw new Error(`USDC successor requires ${flag}`); return value; };
const requiredHash = (args: UsdcSuccessorCliArguments, flag: string): Hex => requiredHashValue(required(args, flag), flag);

export type UsdcSuccessorPublicProviders = Readonly<{
  recovery: readonly [HashlessEvidenceProvider, HashlessEvidenceProvider];
  successor(source: UsdcSuccessorSource): readonly [UsdcSuccessorEvidenceProvider, UsdcSuccessorEvidenceProvider];
  now?: () => Date;
}>;
export type UsdcSuccessorPublicInputs = Readonly<{ source: UsdcSuccessorSource; certificate: VerifiedUsdcSuccessorCertificate; successor: UsdcSuccessorProposal; approval?: UsdcSuccessorApproval }>;

async function loadSource(args: UsdcSuccessorCliArguments, providers: UsdcSuccessorPublicProviders): Promise<UsdcSuccessorSource> {
  const original = createOrdinaryScenarioProposal(readPublicText(required(args, "--original-report"), "original report"), { expectedPackageHash: requiredHash(args, "--original-package-hash"), expectedArtifactBytesHash: requiredHash(args, "--original-artifact-hash") });
  if (!same(original.proposalHash, requiredHash(args, "--original-proposal-hash"))) throw new Error("USDC successor original proposal hash mismatch");
  const journal = loadHashlessSourceJournalReadOnly(required(args, "--source-journal"));
  const recoveryCertificate = await reverifyHashlessStateCertificate(readPublicText(required(args, "--recovery-certificate"), "recovery certificate"), requiredHash(args, "--recovery-certificate-hash"), journal, providers.recovery);
  const recovery = parseExpiredHashlessContinuationProposal(readPublicText(required(args, "--recovery-proposal"), "recovery proposal"), original, journal, recoveryCertificate);
  const recoveryApproval = loadExpiredHashlessContinuationApproval(recovery, readPublicText(required(args, "--recovery-approval"), "recovery approval"), requiredHash(args, "--recovery-approval-hash"));
  return Object.freeze({ original, recovery, recoveryApproval, journal });
}

function loadPrimaryEvidence(manifestPath: string): UsdcSuccessorPrimaryEvidence {
  const directory = dirname(manifestPath);
  return Object.freeze({ manifest: readPublicText(manifestPath, "primary evidence manifest"), ledgerSourceNativeItem2: readPublicText(join(directory, "ledger-source-native-item2.json"), "primary source ledger"), ledgerReplacementNativeItem3: readPublicText(join(directory, "ledger-replacement-native-item3.json"), "primary replacement ledger"), ackNativeQueueReadyHashlessSkip: readPublicText(join(directory, "ack-native-queue-ready-hashless-skip.json"), "primary skip acknowledgement"), ackNativeQueueReadyReplacement: readPublicText(join(directory, "ack-native-queue-ready-replacement.json"), "primary replacement acknowledgement"), ackNativeQueueReadyReplacementExecute: readPublicText(join(directory, "ack-native-queue-ready-replacement-execute.json"), "primary execution acknowledgement") });
}

export async function loadUsdcSuccessorPublicInputs(args: UsdcSuccessorCliArguments, providers: UsdcSuccessorPublicProviders): Promise<UsdcSuccessorPublicInputs> {
  const source = await loadSource(args, providers), primary = loadPrimaryEvidence(required(args, "--primary-bundle-manifest")), successorProviders = providers.successor(source);
  if (args.command === "review") {
    const certificate = await verifyUsdcSuccessorCertificate(source, primary, successorProviders);
    const observer = createUsdcSuccessorObserverBinding(readPublicText(required(args, "--observer-startup"), "observer startup"), readPublicText(required(args, "--observer-probe"), "observer probe"), (providers.now ?? (() => new Date()))());
    const successor = createUsdcSuccessorProposal({ source, certificate, observer, caps: USDC_SUCCESSOR_CAPS });
    return Object.freeze({ source, certificate, successor });
  }
  const certificate = await reverifyUsdcSuccessorCertificate(readPublicText(required(args, "--successor-certificate"), "successor certificate"), requiredHash(args, "--successor-certificate-hash"), source, primary, successorProviders);
  const successor = parseUsdcSuccessorProposal(readPublicText(required(args, "--successor-proposal"), "successor proposal"), source, certificate);
  const approval = loadUsdcSuccessorApproval(successor, readPublicText(required(args, "--successor-approval"), "successor approval"), requiredHash(args, "--successor-approval-hash"));
  return Object.freeze({ source, certificate, successor, approval });
}

export type UsdcSuccessorCliDependencies = Readonly<{
  environment: Readonly<Record<string, string | undefined>>;
  providers: UsdcSuccessorPublicProviders;
  now?: () => Date;
  publicPreflight?(mode: "review" | "submit-one", inputs: UsdcSuccessorPublicInputs): Promise<void>;
  createExecutionContext?(mode: "submit-one" | "resume-one", inputs: UsdcSuccessorPublicInputs, journal: () => OrdinaryScenarioJournal): Promise<OrdinaryScenarioExecutionContext>;
}>;

function assertEnvironment(command: Command, environment: Readonly<Record<string, string | undefined>>): void {
  for (const key of ["SEPOLIA_RPC_URL", "SEPOLIA_ARCHIVE_RPC_URL", "ORDINARY_SCENARIO_OBSERVER"]) if (environment[key] !== undefined) throw new Error("USDC successor public endpoint overrides are forbidden");
  if (command !== "submit-one") for (const key of PRIVATE_ENV) if (environment[key] !== undefined) throw new Error("USDC successor private authority is forbidden for this command");
  if (command === "submit-one" && environment.LIVE_SUBMIT !== "YES") throw new Error("USDC successor submit-one requires exact live approval switch");
  const allowed = new Set(command === "submit-one" ? ["LIVE_SUBMIT", "LIVE_FUNDING_KEY_FILE", "LIVE_PRIMARY_CREDENTIAL_FILE", "LIVE_SECONDARY_CREDENTIAL_FILE", "LIVE_ECDSA_KEY_FILE"] : []);
  for (const key of Object.keys(environment)) if ((key.startsWith("LIVE_") || key === "PRIVATE_KEY" || key.startsWith("VAULT_")) && !allowed.has(key)) throw new Error("USDC successor unsupported authority input");
}

async function execute(command: "submit-one" | "resume-one", args: UsdcSuccessorCliArguments, dependencies: UsdcSuccessorCliDependencies): Promise<Readonly<Record<string, unknown>>> {
  const inputs = await loadUsdcSuccessorPublicInputs(args, { ...dependencies.providers, now: dependencies.now ?? dependencies.providers.now });
  if (!inputs.approval) throw new Error("USDC successor execution requires exact approval");
  if (command === "submit-one") await dependencies.publicPreflight?.("submit-one", inputs);
  const journalPath = required(args, "--journal"); if (journalPath !== required(args, "--source-journal")) throw new Error("USDC successor must use the same physical source journal");
  const sourceBeforeAttachment = publicComparable(inputs.source.journal);
  const attachedCandidate = command === "submit-one" && !inputs.source.journal.usdcSuccessor ? attachUsdcSuccessor(inputs.source.journal, inputs.successor, inputs.approval) : undefined;
  const store = createOrdinaryScenarioStore(journalPath, { proposalHash: inputs.source.original.proposalHash, approvalHash: inputs.source.recovery.source.originalApprovalHash, funder: inputs.source.original.funder }, () => { throw new Error("USDC successor source journal is required"); });
  try {
    let current = store.load();
    if (!current.usdcSuccessor) {
      if (command === "resume-one") throw new Error("USDC successor resume-one requires an attached successor");
      if (!attachedCandidate || publicComparable(current) !== sourceBeforeAttachment) throw new Error("USDC successor source changed before attachment under the writer lease");
      current = attachedCandidate; store.save(current);
    }
    const pending = current.usdcSuccessor!.actions.filter(action => action.status === "outer-pending");
    if (command === "resume-one" && pending.length !== 1) throw new Error("USDC successor resume-one requires exactly one durable pending action");
    if (command === "submit-one" && pending.length !== 0) throw new Error("USDC successor submit-one refuses a pending action");
    if (!dependencies.createExecutionContext) throw new Error("USDC successor execution context is unavailable");
    const context = await dependencies.createExecutionContext(command, inputs, () => store.load());
    return await executeUsdcSuccessorAction(inputs.source, inputs.successor, inputs.approval, store, context);
  } finally { store.close?.(); }
}

export async function runUsdcSuccessorCli(argv: readonly string[], dependencies: UsdcSuccessorCliDependencies): Promise<Readonly<Record<string, unknown>>> {
  const args = parseUsdcSuccessorCliArguments(argv); assertEnvironment(args.command, dependencies.environment);
  if (args.command !== "review") return execute(args.command, args, dependencies);
  const inputs = await loadUsdcSuccessorPublicInputs(args, { ...dependencies.providers, now: dependencies.now ?? dependencies.providers.now });
  assertUsdcSuccessorAdmission(inputs.successor, inputs.successor.actions[0]!.id, inputs.certificate.snapshot.block.timestamp, (dependencies.now ?? (() => new Date()))(), "review");
  await dependencies.publicPreflight?.("review", inputs);
  return Object.freeze({ schemaVersion: 1, scope: "ORDINARY_USDC_SUCCESSOR_UNSIGNED_REVIEW_V1", authorization: "NONE", certificate: JSON.parse(serializeUsdcSuccessorCertificate(inputs.certificate)), successor: inputs.successor, certificateHash: inputs.certificate.certificateHash, proposalHash: inputs.successor.proposalHash, actionCount: 19, caps: inputs.successor.caps, signing: false, broadcast: false });
}

type ProductionProviderOptions = Readonly<{ reconstructed(): ReturnType<typeof reconstructReviewedPlan>; verifyAtBlock?: typeof verifyReconstructedPlanAtBlock }>;
export function createUsdcSuccessorEvidenceProvider(client: ReturnType<typeof createPublicClient>, source: UsdcSuccessorSource, options: ProductionProviderOptions): UsdcSuccessorEvidenceProvider {
  const readBlock = async (number: bigint) => { try { const block = await client.getBlock({ blockNumber: number }); return block.hash ? { number: block.number, hash: block.hash, timestamp: block.timestamp } : undefined; } catch { return undefined; } };
  return Object.freeze({
    readLatestBlock: async () => { const block = await client.getBlock({ blockTag: "latest" }); if (!block.hash) throw new Error("USDC successor latest canonical block is unavailable"); return { number: block.number, hash: block.hash, timestamp: block.timestamp }; },
    readBlock,
    readTransaction: async hash => { try {
      const tx = await client.getTransaction({ hash });
      if (tx.to === null || tx.blockNumber === null || tx.blockHash === null || tx.r === undefined || tx.s === undefined) return undefined;
      const chainId = Number(tx.chainId); let serialized: Hex; let fees: Record<string, unknown>;
      if (tx.type === "legacy") { if (tx.gasPrice === undefined || tx.v === undefined) return undefined; serialized = reconstructCanonicalLegacyTransaction({ chainId, nonce: tx.nonce, gas: tx.gas, gasPrice: tx.gasPrice, to: tx.to, value: tx.value, data: tx.input, r: tx.r, s: tx.s, v: tx.v, hash: tx.hash }); fees = { type: "legacy", chainId, gasPrice: tx.gasPrice, v: tx.v }; }
      else if (tx.type === "eip1559") { if (tx.maxFeePerGas === undefined || tx.maxPriorityFeePerGas === undefined || (tx.yParity !== 0 && tx.yParity !== 1) || tx.accessList.length !== 0) return undefined; serialized = reconstructCanonicalType2Transaction({ chainId, nonce: tx.nonce, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, to: tx.to, value: tx.value, data: tx.input, accessList: [], r: tx.r, s: tx.s, yParity: tx.yParity, hash: tx.hash }); fees = { type: "eip1559", chainId, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas }; }
      else return undefined;
      const from = await recoverTransactionAddress({ serializedTransaction: serialized as never }); if (tx.from && !same(from, tx.from)) return undefined;
      return { hash: tx.hash, from, nonce: tx.nonce, to: tx.to, value: tx.value, inputHash: keccak256(tx.input), gas: tx.gas, blockNumber: tx.blockNumber, blockHash: tx.blockHash, ...fees } as never;
    } catch { return undefined; } },
    readReceipt: async hash => { try { const receipt = await client.getTransactionReceipt({ hash }); return { transactionHash: receipt.transactionHash, status: receipt.status, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice }; } catch { return undefined; } },
    readTransactionCount: async (address, block) => Number(await client.getTransactionCount(block === "latest" || block === "pending" ? { address, blockTag: block } : { address, blockNumber: block })),
    readControlledState: async blockNumber => {
      const reconstructed = await options.reconstructed(); await (options.verifyAtBlock ?? verifyReconstructedPlanAtBlock)(reconstructed, client, blockNumber);
      const original = source.original, read = (address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) => client.readContract({ address, abi, functionName, args, blockNumber } as never) as Promise<unknown>;
      const [block, chainId, safeNonce, delayTxNonce, delayQueueNonce, safeNativeBalance, safeUsdcBalance, funderUsdcBalance, nativeSpend, usdcSpend] = await Promise.all([client.getBlock({ blockNumber }), client.getChainId(), read(original.safe, SAFE_ABI, "nonce"), read(original.delay, DELAY_ABI, "txNonce"), read(original.delay, DELAY_ABI, "queueNonce"), client.getBalance({ address: original.safe, blockNumber }), read(original.usdc, erc20Abi, "balanceOf", [original.safe]), read(original.usdc, erc20Abi, "balanceOf", [original.funder]), read(original.guard, GUARD_ABI, "spendState", ["0x0000000000000000000000000000000000000000"]), read(original.guard, GUARD_ABI, "spendState", [original.usdc])]);
      if (!block.hash) throw new Error("USDC successor controlled-state block hash is unavailable");
      const txNonce = BigInt(delayTxNonce as bigint), queueNonce = BigInt(delayQueueNonce as bigint); let queue: UsdcSuccessorCanonicalState["queue"] = null;
      if (queueNonce === txNonce + 1n) { const candidates = source.recovery.actions.filter(action => action.kind === "queue-proposal" && action.queue && BigInt(action.queue.queueNonce) === txNonce); if (candidates.length !== 1) throw new Error("USDC successor historical queue preimage is missing or ambiguous"); const item = candidates[0]!.queue!; const [fingerprint, createdAt] = await Promise.all([read(original.delay, DELAY_ABI, "getTxHash", [txNonce]), read(original.delay, DELAY_ABI, "getTxCreatedAt", [txNonce])]); if (!same(fingerprint as string, item.fingerprint)) throw new Error("USDC successor historical queue fingerprint mismatch"); queue = { queueNonce: txNonce, fingerprint: item.fingerprint, createdAt: BigInt(createdAt as bigint), to: item.to, value: BigInt(item.value), data: item.data, operation: item.operation }; }
      else if (queueNonce !== txNonce) throw new Error("USDC successor Delay nonce relationship is unsupported");
      const final = await client.getBlock({ blockNumber }); if (!final.hash || !same(final.hash, block.hash)) throw new Error("USDC successor controlled-state block changed during pinned read");
      const native = nativeSpend as readonly bigint[], token = usdcSpend as readonly bigint[];
      return { blockNumber, blockHash: block.hash, chainId, identityHash: original.publicIdentitiesHash, topologyHash: original.topologyEvidenceHash, policyHash: POLICY_HASH, safe: original.safe, guard: original.guard, delay: original.delay, funder: original.funder, usdc: original.usdc, recipient: original.recipient, primarySigner: original.primarySigner, safeContractSecondary: original.safeContractSecondary, ecdsaSecondary: original.ecdsaSecondary, safeNonce: BigInt(safeNonce as bigint), delayQueueNonce: queueNonce, delayTxNonce: txNonce, queue, safeNativeBalance, safeUsdcBalance: BigInt(safeUsdcBalance as bigint), funderUsdcBalance: BigInt(funderUsdcBalance as bigint), nativeSpend: { window: native[0]!, baseSpent: native[1]!, instantSpent: native[2]! }, usdcSpend: { window: token[0]!, baseSpent: token[1]!, instantSpent: token[2]! } };
    },
  });
}

type ProductionSeams = Readonly<{ createHarness?: typeof createOrdinaryScenarioProductionHarness; createStateReader?: typeof createOrdinaryScenarioStateReader; createExecutionContext?: typeof createOrdinaryScenarioExecutionContext }>;
export function createUsdcSuccessorProductionDependencies(repository: string, argv: readonly string[], seams: ProductionSeams = {}): UsdcSuccessorCliDependencies {
  const harness: OrdinaryScenarioProductionHarness = (seams.createHarness ?? createOrdinaryScenarioProductionHarness)(repository), args = parseUsdcSuccessorCliArguments(argv); let reconstruction: ReturnType<typeof reconstructReviewedPlan> | undefined;
  const reconstructed = () => reconstruction ??= harness.reconstructedProfile();
  const providers: UsdcSuccessorPublicProviders = { recovery: [createHashlessEvidenceProvider(harness.current), createHashlessEvidenceProvider(harness.archive)], successor: source => [createUsdcSuccessorEvidenceProvider(harness.current, source, { reconstructed }), createUsdcSuccessorEvidenceProvider(harness.archive, source, { reconstructed })] };
  const readiness = (inputs: UsdcSuccessorPublicInputs) => async () => ({ ready: true, evidenceHash: inputs.successor.observer.probeEvidenceHash });
  return {
    environment: process.env, providers,
    publicPreflight: async (mode, inputs) => { const view = createUsdcSuccessorExecutionView(inputs.source, inputs.successor, inputs.approval); const action = !inputs.source.journal.usdcSuccessor ? view.proposal.actions.slice(-19)[0]! : inputs.approval ? selectUsdcSuccessorSubmissionAction(inputs.source, inputs.successor, inputs.approval, inputs.source.journal) : view.proposal.actions.slice(-19)[0]!; const reader = (seams.createStateReader ?? createOrdinaryScenarioStateReader)({ repository, proposal: view, journal: () => inputs.source.journal, currentClient: harness.current, archiveClient: harness.archive, observerReadiness: readiness(inputs) }); const state = await reader(action, "pre-private"); assertUsdcSuccessorAdmission(inputs.successor, action.id, state.blockTimestamp, new Date(), mode === "review" ? "review" : "scenario"); },
    createExecutionContext: async (mode, inputs, journal) => { const view = createUsdcSuccessorExecutionView(inputs.source, inputs.successor, inputs.approval); const live = await harness.createLiveContext(mode, inputs.source.original.funder, async () => {}); return (seams.createExecutionContext ?? createOrdinaryScenarioExecutionContext)({ repository, proposal: view, journal, currentClient: harness.current, archiveClient: harness.archive, observerReadiness: readiness(inputs), live, loadSigners: createOrdinaryScenarioClosedSignerLoader(repository, harness, inputs.source.original), observerLedgerPath: args.values.get("--observer-ledger"), receiverAcknowledgementPath: args.values.get("--receiver-ack"), observerEndpointHash: inputs.successor.observer.endpointHash, receiverReadyAt: new Date(Number(BigInt(inputs.successor.observer.readyAt)) * 1000).toISOString(), receiverExpiresAt: new Date(Number(BigInt(inputs.successor.observer.expiresAt)) * 1000).toISOString() }); },
  };
}

export type UsdcSuccessorMainOptions = Readonly<{ repository?: string; dependencies?: UsdcSuccessorCliDependencies; writeStdout?(value: string): void }>;
export async function main(argv = process.argv.slice(2), options: UsdcSuccessorMainOptions = {}): Promise<void> { const repository = options.repository ?? process.cwd().replace(/\/packages\/security-core$/, ""); const result = await runUsdcSuccessorCli(argv, options.dependencies ?? createUsdcSuccessorProductionDependencies(repository, argv)); (options.writeStdout ?? (value => process.stdout.write(value)))(publicJson(result)); }
export const runUsdcSuccessorEntryPoint = (task: Promise<void>, output?: OperationalCliOutput): Promise<void> => runOperationalCliEntryPoint(task, "ordinary-usdc-successor", output);
if (require.main === module) void runUsdcSuccessorEntryPoint(main());
