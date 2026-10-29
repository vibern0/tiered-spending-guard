import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createPublicClient, erc20Abi, http, keccak256, parseAbi, recoverTransactionAddress, serializeTransaction, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { PUBLIC_ARCHIVE_RPC, PUBLIC_CURRENT_RPC } from "./ordinary-scenario-review-cli";
import { createOrdinaryScenarioClosedSignerLoader, createOrdinaryScenarioProductionHarness } from "./ordinary-scenario-executor-cli";
import { createExpiredHashlessContinuationExecutionView, selectExpiredHashlessContinuationSubmissionAction } from "./ordinary-scenario-executor";
import { createOrdinaryScenarioExecutionContext, createOrdinaryScenarioStateReader, reconstructCanonicalType2Transaction } from "./ordinary-scenario-adapter";
import {
  createOrdinaryScenarioProposal,
  createOrdinaryScenarioStore,
  executeExpiredHashlessContinuationAction,
  type OrdinaryScenarioExecutionContext,
  type OrdinaryScenarioExecutionResult,
  type OrdinaryScenarioJournal,
  type OrdinaryScenarioProposal,
} from "./ordinary-scenario-executor";
import {
  loadHashlessSourceJournalReadOnly,
  reverifyHashlessStateCertificate,
  serializeHashlessStateCertificate,
  verifyHashlessStateCertificate,
  type HashlessEvidenceProvider,
  type VerifiedHashlessStateCertificate,
} from "./ordinary-scenario-hashless-certificate";
import {
  attachExpiredHashlessContinuation,
  createExpiredHashlessContinuationProposal,
  loadExpiredHashlessContinuationApproval,
  parseExpiredHashlessContinuationProposal,
  type ContinuationActionCaps,
  type ContinuationObserverBinding,
  type ContinuationWorkflowSchedule,
  type ExpiredHashlessContinuationApproval,
  type ExpiredHashlessContinuationProposal,
} from "./ordinary-scenario-hashless-continuation";
import { runOperationalCliEntryPoint, type OperationalCliOutput } from "./operational-cli-entrypoint";

export const HASHLESS_CONTINUATION_COMMANDS = Object.freeze(["review", "submit-one", "resume-one"] as const);
export const HASHLESS_CONTINUATION_WORKFLOW_SCHEDULE = Object.freeze({ review: "3600", execution: "960", confirmations: "180", delivery: "60", acknowledgement: "300", keylessConfirmation: "300" }) satisfies ContinuationWorkflowSchedule;
export const HASHLESS_CONTINUATION_CAPS = Object.freeze({ fundingGasLimit: "740292", safeExecutionGasLimit: "2000000", publicDelayGasLimit: "300000", maxFeePerGas: "1000000", maxPriorityFeePerGas: "1000000" }) satisfies ContinuationActionCaps;

const HASH = /^0x[0-9a-fA-F]{64}$/;
const PRIVATE_ENV = ["LIVE_FUNDING_KEY_FILE", "LIVE_PRIMARY_CREDENTIAL_FILE", "LIVE_SECONDARY_CREDENTIAL_FILE", "LIVE_ECDSA_KEY_FILE", "PRIVATE_KEY", "VAULT_FUNDING_KEY_PATH"] as const;
const rawSha256 = (value: string): Hex => `0x${createHash("sha256").update(value).digest("hex")}` as Hex;
const publicJson = (value: unknown): string => `${JSON.stringify(value, (_, child) => typeof child === "bigint" ? child.toString() : child)}\n`;
const object = (value: unknown, label: string): Record<string, unknown> => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`); return value as Record<string, unknown>; };
const exactKeys = (value: Record<string, unknown>, keys: readonly string[], label: string): void => { const actual = Object.keys(value).sort(); const expected = [...keys].sort(); if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${label} shape mismatch`); };
const timestamp = (value: unknown, label: string): number => { if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} timestamp is invalid`); return Math.floor(Date.parse(value) / 1000); };
const readPublicText = (path: string, label: string): string => { try { return readFileSync(path, "utf8"); } catch { throw new Error(`hashless continuation ${label} is unavailable`); } };

export function createContinuationObserverBinding(startupText: string, probeText: string, now: Date): ContinuationObserverBinding {
  let startupRaw: unknown; let probeRaw: unknown;
  try { startupRaw = JSON.parse(startupText); probeRaw = JSON.parse(probeText); } catch { throw new Error("continuation observer proof must be JSON"); }
  const startup = object(startupRaw, "observer startup proof"); const probe = object(probeRaw, "observer probe proof");
  exactKeys(startup, ["schemaVersion", "scope", "publicId", "endpointHash", "startedAt", "expiresAt", "signing", "broadcast"], "observer startup proof");
  exactKeys(probe, ["schemaVersion", "scope", "publicId", "endpointHash", "startupEvidenceHash", "probedAt", "expiresAt", "delivery", "acknowledgement", "signing", "broadcast"], "observer probe proof");
  const startupEvidenceHash = rawSha256(startupText); const probeEvidenceHash = rawSha256(probeText);
  const publicId = startup.publicId; const endpointHash = startup.endpointHash;
  if (startup.schemaVersion !== 1 || startup.scope !== "HASHLESS_CONTINUATION_OBSERVER_STARTUP_V1" || startup.signing !== false || startup.broadcast !== false || probe.schemaVersion !== 1 || probe.scope !== "HASHLESS_CONTINUATION_OBSERVER_PROBE_V1" || probe.signing !== false || probe.broadcast !== false || probe.delivery !== "DELIVERED" || probe.acknowledgement !== "ACKNOWLEDGED" || typeof publicId !== "string" || typeof endpointHash !== "string" || !HASH.test(endpointHash) || publicId !== `temporary-test-receiver:${endpointHash}` || probe.publicId !== publicId || probe.endpointHash !== endpointHash || probe.startupEvidenceHash !== startupEvidenceHash || probe.expiresAt !== startup.expiresAt) throw new Error("continuation observer startup/probe binding mismatch");
  const startedAt = timestamp(startup.startedAt, "observer startup"); const readyAt = timestamp(probe.probedAt, "observer probe"); const expiresAt = timestamp(startup.expiresAt, "observer expiry"); const nowSeconds = Math.floor(now.getTime() / 1000);
  if (!Number.isFinite(nowSeconds) || startedAt > readyAt || readyAt > nowSeconds) throw new Error("continuation observer readiness is future or unordered");
  const budget = Object.values(HASHLESS_CONTINUATION_WORKFLOW_SCHEDULE).reduce((sum, value) => sum + BigInt(value), 0n); const requiredThrough = BigInt(readyAt) + budget;
  if (BigInt(expiresAt) < requiredThrough || BigInt(expiresAt - nowSeconds) < budget) throw new Error("continuation observer remaining TTL is insufficient");
  return Object.freeze({ kind: "https-webhook", publicId, endpointHash: endpointHash as Hex, startupEvidenceHash, probeEvidenceHash, independentFromProposer: true, readyAt: readyAt.toString(), workflowScheduleSeconds: HASHLESS_CONTINUATION_WORKFLOW_SCHEDULE, requiredThrough: requiredThrough.toString(), expiresAt: expiresAt.toString() });
}

export function assertContinuationObserverFresh(binding: ContinuationObserverBinding, now: Date): void {
  const nowSeconds = BigInt(Math.floor(now.getTime() / 1000)); const expiry = BigInt(binding.expiresAt); const budget = Object.values(binding.workflowScheduleSeconds).reduce((sum, value) => sum + BigInt(value), 0n);
  if (BigInt(binding.readyAt) > nowSeconds || expiry - nowSeconds < budget) throw new Error("continuation observer no longer has sufficient remaining lifetime");
}

type Command = typeof HASHLESS_CONTINUATION_COMMANDS[number];
export type HashlessContinuationCliArguments = Readonly<{ command: Command; values: ReadonlyMap<string, string> }>;
const COMMON_FLAGS = ["--source-journal", "--original-report", "--original-package-hash", "--original-artifact-hash", "--original-proposal-hash"] as const;
const REVIEW_FLAGS = [...COMMON_FLAGS, "--source-artifact", "--source-artifact-hash", "--observer-startup", "--observer-probe"] as const;
const EXECUTION_FLAGS = [...COMMON_FLAGS, "--certificate", "--certificate-hash", "--proposal", "--approval", "--approval-hash", "--journal", "--observer-ledger", "--receiver-ack"] as const;
const KNOWN_FLAGS = new Set<string>([...REVIEW_FLAGS, ...EXECUTION_FLAGS]);
export function parseHashlessContinuationCliArguments(argv: readonly string[]): HashlessContinuationCliArguments {
  const args = [...argv]; const command = args.shift(); if (!HASHLESS_CONTINUATION_COMMANDS.includes(command as Command)) throw new Error("unknown hashless continuation command");
  const values = new Map<string, string>(); while (args.length) { const flag = args.shift()!; const value = args.shift(); if (!KNOWN_FLAGS.has(flag) || !value || values.has(flag)) throw new Error("hashless continuation arguments are malformed"); values.set(flag, value); }
  const allowed = new Set<string>(command === "review" ? REVIEW_FLAGS : EXECUTION_FLAGS); if ([...values.keys()].some(flag => !allowed.has(flag))) throw new Error("hashless continuation flag is not valid for this command");
  return { command: command as Command, values };
}
const required = (args: HashlessContinuationCliArguments, flag: string): string => { const value = args.values.get(flag); if (!value) throw new Error(`hashless continuation requires ${flag}`); return value; };
const requiredHash = (args: HashlessContinuationCliArguments, flag: string): Hex => { const value = required(args, flag); if (!HASH.test(value)) throw new Error(`hashless continuation ${flag} is malformed`); return value as Hex; };

export type HashlessContinuationPublicInputs = Readonly<{ original: OrdinaryScenarioProposal; journal: OrdinaryScenarioJournal; certificate: VerifiedHashlessStateCertificate; continuation: ExpiredHashlessContinuationProposal; approval?: ExpiredHashlessContinuationApproval }>;
export type HashlessContinuationCliDependencies = Readonly<{
  environment: Readonly<Record<string, string | undefined>>;
  providers?: readonly [HashlessEvidenceProvider, HashlessEvidenceProvider];
  now?: () => Date;
  publicPreflight?(mode: "review" | "submit-one", inputs: HashlessContinuationPublicInputs): Promise<void>;
  createExecutionContext?(mode: "submit-one" | "resume-one", inputs: HashlessContinuationPublicInputs, journal: () => OrdinaryScenarioJournal): Promise<OrdinaryScenarioExecutionContext>;
}>;

function assertEnvironment(command: Command, environment: Readonly<Record<string, string | undefined>>): void {
  for (const key of ["SEPOLIA_RPC_URL", "SEPOLIA_ARCHIVE_RPC_URL", "ORDINARY_SCENARIO_OBSERVER"]) if (environment[key] !== undefined) throw new Error("public endpoint overrides are forbidden");
  if (command !== "submit-one") for (const key of PRIVATE_ENV) if (environment[key] !== undefined) throw new Error("private authority is forbidden for this command");
  if (command === "submit-one" && environment.LIVE_SUBMIT !== "YES") throw new Error("submit-one requires exact live approval switch");
  if (command !== "submit-one") for (const key of Object.keys(environment)) if (key.startsWith("LIVE_") || key === "PRIVATE_KEY" || key.startsWith("VAULT_")) throw new Error("unsupported authority input");
}
function loadOriginal(args: HashlessContinuationCliArguments): OrdinaryScenarioProposal {
  const original = createOrdinaryScenarioProposal(readPublicText(required(args, "--original-report"), "original report"), { expectedPackageHash: requiredHash(args, "--original-package-hash"), expectedArtifactBytesHash: requiredHash(args, "--original-artifact-hash") });
  if (original.proposalHash.toLowerCase() !== requiredHash(args, "--original-proposal-hash").toLowerCase()) throw new Error("exact original proposal hash mismatch"); return original;
}

/** Shared Task-5 public loader. It restores all runtime-opaque capabilities only after exact files and two-provider certificate history verify. */
export async function loadHashlessContinuationPublicInputs(args: HashlessContinuationCliArguments, providers: readonly [HashlessEvidenceProvider, HashlessEvidenceProvider]): Promise<HashlessContinuationPublicInputs> {
  const original = loadOriginal(args); const journal = loadHashlessSourceJournalReadOnly(required(args, "--source-journal"));
  const certificate = await reverifyHashlessStateCertificate(readPublicText(required(args, "--certificate"), "recorded certificate"), requiredHash(args, "--certificate-hash"), journal, providers);
  const continuation = parseExpiredHashlessContinuationProposal(readPublicText(required(args, "--proposal"), "continuation proposal"), original, journal, certificate);
  const approvalPath = args.values.get("--approval"); const approvalHash = args.values.get("--approval-hash"); if ((approvalPath === undefined) !== (approvalHash === undefined)) throw new Error("continuation approval path and hash must be supplied together");
  const approval = approvalPath && approvalHash ? loadExpiredHashlessContinuationApproval(continuation, readPublicText(approvalPath, "continuation approval"), approvalHash as Hex) : undefined;
  return Object.freeze({ original, journal, certificate, continuation, ...(approval ? { approval } : {}) });
}

async function review(args: HashlessContinuationCliArguments, dependencies: HashlessContinuationCliDependencies): Promise<Readonly<Record<string, unknown>>> {
  if (!dependencies.providers) throw new Error("two fixed public providers are unavailable"); const original = loadOriginal(args); const journal = loadHashlessSourceJournalReadOnly(required(args, "--source-journal"));
  const certificate = await verifyHashlessStateCertificate(readPublicText(required(args, "--source-artifact"), "source artifact"), requiredHash(args, "--source-artifact-hash"), journal, dependencies.providers);
  const observer = createContinuationObserverBinding(readPublicText(required(args, "--observer-startup"), "observer startup proof"), readPublicText(required(args, "--observer-probe"), "observer probe proof"), (dependencies.now ?? (() => new Date()))());
  const continuation = createExpiredHashlessContinuationProposal({ original, journal, certificate, observer, caps: HASHLESS_CONTINUATION_CAPS }); const inputs = Object.freeze({ original, journal, certificate, continuation }); await dependencies.publicPreflight?.("review", inputs);
  return Object.freeze({ schemaVersion: 1, scope: "FIRST38_HASHLESS_CONTINUATION_UNSIGNED_REVIEW_V1", authorization: "NONE", certificate: JSON.parse(serializeHashlessStateCertificate(certificate)), continuation, certificateHash: certificate.certificateHash, proposalHash: continuation.proposalHash, actionCount: 22, caps: continuation.caps, signing: false, broadcast: false });
}

async function execute(command: "submit-one" | "resume-one", args: HashlessContinuationCliArguments, dependencies: HashlessContinuationCliDependencies): Promise<OrdinaryScenarioExecutionResult> {
  if (!dependencies.providers) throw new Error("two fixed public providers are unavailable"); const inputs = await loadHashlessContinuationPublicInputs(args, dependencies.providers); if (!inputs.approval) throw new Error("execution requires exact continuation approval");
  if (command === "submit-one") { await dependencies.publicPreflight?.("submit-one", inputs); assertContinuationObserverFresh(inputs.continuation.observer, (dependencies.now ?? (() => new Date()))()); }
  const journalPath = required(args, "--journal"); if (journalPath !== required(args, "--source-journal")) throw new Error("continuation must use the same physical source journal");
  const store = createOrdinaryScenarioStore(journalPath, { proposalHash: inputs.original.proposalHash, approvalHash: inputs.continuation.source.originalApprovalHash, funder: inputs.original.funder }, () => { throw new Error("source journal is required"); });
  try {
    let current = store.load(); if (!current.hashlessContinuation) { if (command === "resume-one") throw new Error("resume-one requires an attached continuation"); current = attachExpiredHashlessContinuation(current, inputs.continuation, inputs.approval); store.save(current); }
    const pending = current.hashlessContinuation!.actions.filter(action => action.status === "outer-pending"); if (command === "resume-one" && pending.length !== 1) throw new Error("resume-one requires exactly one durable pending continuation action"); if (command === "submit-one" && pending.length !== 0) throw new Error("submit-one refuses a journal with a pending continuation action");
    if (!dependencies.createExecutionContext) throw new Error("execution context is unavailable"); const context = await dependencies.createExecutionContext(command, inputs, () => store.load()); return await executeExpiredHashlessContinuationAction(inputs.original, inputs.continuation, inputs.approval, store, context);
  } finally { store.close?.(); }
}

export async function runExpiredHashlessContinuationCli(argv: readonly string[], dependencies: HashlessContinuationCliDependencies): Promise<Readonly<Record<string, unknown>>> {
  const args = parseHashlessContinuationCliArguments(argv); assertEnvironment(args.command, dependencies.environment); return args.command === "review" ? review(args, dependencies) : execute(args.command, args, dependencies);
}

export const runHashlessContinuationEntryPoint = (task: Promise<void>, output?: OperationalCliOutput): Promise<void> => runOperationalCliEntryPoint(task, "ordinary-scenario-hashless-continuation", output);

const SAFE_ABI = parseAbi(["function nonce() view returns (uint256)"]);
const DELAY_ABI = parseAbi(["function txNonce() view returns (uint256)", "function queueNonce() view returns (uint256)", "function getTxHash(uint256) view returns (bytes32)", "function getTxCreatedAt(uint256) view returns (uint256)"]);
const GUARD_ABI = parseAbi(["function spendState(address) view returns (uint256,uint256,uint256)"]);
const FIXED = Object.freeze({ funder: "0xaD4D5cd2Ec5beCdB9608baD4c36F0dBe8b2492Bc" as Address, safe: "0xd751a1479f49d63DC61E0081B0b4d8c60623D9a6" as Address, delay: "0xB8E143098CcCb9935228022173c2c987DF5FD53a" as Address, guard: "0x91392B9aE9daBa21a1fba3d92fae9fE47a4B48cA" as Address, usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Address, queueFingerprint: "0xbc952941d43eba0cc5b9f3f0e3b98e7984a10e085ab43d623e15224af13f4e67" as Hex });
const CANONICAL_LEGACY_V = 22_310_258n;

export function reconstructCanonicalLegacyTransaction(source: Readonly<{ chainId: number; nonce: number; gas: bigint; gasPrice: bigint; to: Address; value: bigint; data: Hex; r: Hex; s: Hex; v: bigint; hash: Hex }>): Hex {
  const parity = source.v - (2n * BigInt(source.chainId) + 35n); if (parity !== 0n && parity !== 1n) throw new Error("canonical legacy transaction EIP-155 v mismatch");
  const serialized = serializeTransaction({ type: "legacy", chainId: source.chainId, nonce: source.nonce, gas: source.gas, gasPrice: source.gasPrice, to: source.to, value: source.value, data: source.data }, { r: source.r, s: source.s, v: 27n + parity });
  if (keccak256(serialized).toLowerCase() !== source.hash.toLowerCase()) throw new Error("canonical legacy transaction hash mismatch"); return serialized;
}

/** Fixed read-only Sepolia adapter. It reconstructs and sender-recovers the canonical signed nonce-809 transaction before returning evidence. */
export function createHashlessEvidenceProvider(client: ReturnType<typeof createPublicClient>): HashlessEvidenceProvider {
  const readBlock = async (number: bigint) => { try { const block = await client.getBlock({ blockNumber: number }); return block.hash ? { number: block.number, hash: block.hash, timestamp: block.timestamp } : undefined; } catch { return undefined; } };
  return Object.freeze({
    readLatestBlock: async () => { const block = await client.getBlock({ blockTag: "latest" }); if (!block.hash) throw new Error("latest canonical block hash unavailable"); return { number: block.number, hash: block.hash, timestamp: block.timestamp }; },
    readBlock,
    readTransaction: async hash => { try {
      const tx = await client.getTransaction({ hash });
      if (tx.to === null || tx.blockNumber === null || tx.blockHash === null || tx.r === undefined || tx.s === undefined) return undefined;
      const chainId = Number(tx.chainId); let serialized: Hex; let feeIdentity: Readonly<{ type: "legacy"; chainId: number; gasPrice: bigint; v: bigint }> | Readonly<{ type: "eip1559"; chainId: number; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
      if (tx.type === "legacy") {
        if (tx.gasPrice === undefined || tx.v === undefined || tx.v !== CANONICAL_LEGACY_V) return undefined;
        serialized = reconstructCanonicalLegacyTransaction({ chainId, nonce: tx.nonce, gas: tx.gas, gasPrice: tx.gasPrice, to: tx.to, value: tx.value, data: tx.input, r: tx.r, s: tx.s, v: tx.v, hash: tx.hash }); feeIdentity = { type: "legacy", chainId, gasPrice: tx.gasPrice, v: tx.v };
      } else if (tx.type === "eip1559") {
        if (tx.maxFeePerGas === undefined || tx.maxPriorityFeePerGas === undefined || (tx.yParity !== 0 && tx.yParity !== 1) || tx.accessList.length !== 0) return undefined;
        serialized = reconstructCanonicalType2Transaction({ chainId, nonce: tx.nonce, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, to: tx.to, value: tx.value, data: tx.input, accessList: [], r: tx.r, s: tx.s, yParity: tx.yParity, hash: tx.hash }); feeIdentity = { type: "eip1559", chainId, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas };
      } else return undefined;
      const recoveredSender = await recoverTransactionAddress({ serializedTransaction: serialized as never });
      return { hash: tx.hash, recoveredSender, nonce: tx.nonce, to: tx.to, value: tx.value, inputHash: keccak256(tx.input), gas: tx.gas, blockNumber: tx.blockNumber, blockHash: tx.blockHash, ...feeIdentity };
    } catch { return undefined; } },
    readReceipt: async hash => { try { const receipt = await client.getTransactionReceipt({ hash }); return { transactionHash: receipt.transactionHash, status: receipt.status, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash }; } catch { return undefined; } },
    readTransactionCount: async (address, at) => Number(await client.getTransactionCount(at === "latest" || at === "pending" ? { address, blockTag: at } : { address, blockNumber: at })),
    readControlledState: async blockNumber => {
      const [block, safeNonce, delayTxNonce, delayQueueNonce, createdAt, queueHash, safeNativeBalance, safeUsdcBalance, funderUsdcBalance, nativeSpend, usdcSpend] = await Promise.all([
        client.getBlock({ blockNumber }), client.readContract({ address: FIXED.safe, abi: SAFE_ABI, functionName: "nonce", blockNumber }), client.readContract({ address: FIXED.delay, abi: DELAY_ABI, functionName: "txNonce", blockNumber }), client.readContract({ address: FIXED.delay, abi: DELAY_ABI, functionName: "queueNonce", blockNumber }), client.readContract({ address: FIXED.delay, abi: DELAY_ABI, functionName: "getTxCreatedAt", args: [2n], blockNumber }), client.readContract({ address: FIXED.delay, abi: DELAY_ABI, functionName: "getTxHash", args: [2n], blockNumber }), client.getBalance({ address: FIXED.safe, blockNumber }), client.readContract({ address: FIXED.usdc, abi: erc20Abi, functionName: "balanceOf", args: [FIXED.safe], blockNumber }), client.readContract({ address: FIXED.usdc, abi: erc20Abi, functionName: "balanceOf", args: [FIXED.funder], blockNumber }), client.readContract({ address: FIXED.guard, abi: GUARD_ABI, functionName: "spendState", args: ["0x0000000000000000000000000000000000000000"], blockNumber }), client.readContract({ address: FIXED.guard, abi: GUARD_ABI, functionName: "spendState", args: [FIXED.usdc], blockNumber }),
      ]);
      if ((queueHash as Hex).toLowerCase() !== FIXED.queueFingerprint.toLowerCase()) throw new Error("historical queue hash drift"); const native = nativeSpend as readonly bigint[], token = usdcSpend as readonly bigint[]; const effectiveGuardWindow = (block.timestamp / 86_400n) * 86_400n;
      return { chainId: 11_155_111, safe: FIXED.safe, delay: FIXED.delay, usdc: FIXED.usdc, safeNonce, delayQueueNonce, delayTxNonce, queue: { queueNonce: 2n, to: FIXED.funder, value: 1n, data: "0x", operation: 0, createdAt, expiresAt: createdAt + 720n }, safeNativeBalance, safeUsdcBalance, funderUsdcBalance, effectiveGuardWindow, nativeSpend: { window: native[0]!, baseSpent: native[1]!, instantSpent: native[2]! }, usdcSpend: { window: token[0]!, baseSpent: token[1]!, instantSpent: token[2]! } };
    },
  });
}

type HashlessContinuationProductionSeams = Readonly<{
  createStateReader?: typeof createOrdinaryScenarioStateReader;
  createHarness?: typeof createOrdinaryScenarioProductionHarness;
  createExecutionContext?: typeof createOrdinaryScenarioExecutionContext;
}>;
export function createHashlessContinuationProductionDependencies(repository: string, argv: readonly string[], seams: HashlessContinuationProductionSeams = {}): HashlessContinuationCliDependencies {
  const current = createPublicClient({ chain: sepolia, transport: http(PUBLIC_CURRENT_RPC) }); const archive = createPublicClient({ chain: sepolia, transport: http(PUBLIC_ARCHIVE_RPC) }); const harness = (seams.createHarness ?? createOrdinaryScenarioProductionHarness)(repository); const cli = parseHashlessContinuationCliArguments(argv);
  const observerReadiness = (inputs: HashlessContinuationPublicInputs, mode: "submit-one" | "resume-one") => async () => { if (mode === "submit-one") assertContinuationObserverFresh(inputs.continuation.observer, new Date()); return { ready: true, evidenceHash: inputs.continuation.observer.probeEvidenceHash }; };
  return {
    environment: process.env,
    providers: [createHashlessEvidenceProvider(current), createHashlessEvidenceProvider(archive)],
    publicPreflight: async (mode, inputs) => {
      const view = createExpiredHashlessContinuationExecutionView(inputs.original, inputs.continuation, inputs.approval); const reader = (seams.createStateReader ?? createOrdinaryScenarioStateReader)({ repository, proposal: view, journal: () => inputs.journal, currentClient: current, archiveClient: archive, observerReadiness: async () => { assertContinuationObserverFresh(inputs.continuation.observer, new Date()); return { ready: true, evidenceHash: inputs.continuation.observer.probeEvidenceHash }; } });
      const action = mode === "review" || inputs.journal.hashlessContinuation === undefined ? view.proposal.actions[18]! : inputs.approval ? selectExpiredHashlessContinuationSubmissionAction(inputs.original, inputs.continuation, inputs.approval, inputs.journal) : (() => { throw new Error("submission preflight requires exact continuation approval"); })();
      await reader(action, "pre-private");
    },
    createExecutionContext: async (mode, inputs, journal) => {
      const view = createExpiredHashlessContinuationExecutionView(inputs.original, inputs.continuation, inputs.approval); const readiness = observerReadiness(inputs, mode);
      const loadSigners = createOrdinaryScenarioClosedSignerLoader(repository, harness, inputs.original);
      const live = await harness.createLiveContext(mode, inputs.original.funder, async () => {});
      return (seams.createExecutionContext ?? createOrdinaryScenarioExecutionContext)({ repository, proposal: view, journal, currentClient: current, archiveClient: archive, observerReadiness: readiness, live, loadSigners, observerLedgerPath: cli.values.get("--observer-ledger"), receiverAcknowledgementPath: cli.values.get("--receiver-ack"), observerEndpointHash: inputs.continuation.observer.endpointHash, receiverReadyAt: new Date(Number(BigInt(inputs.continuation.observer.readyAt)) * 1000).toISOString(), receiverExpiresAt: new Date(Number(BigInt(inputs.continuation.observer.expiresAt)) * 1000).toISOString() });
    },
  };
}

export type HashlessContinuationMainOptions = Readonly<{ repository?: string; dependencies?: HashlessContinuationCliDependencies; writeStdout?(value: string): void }>;
export async function main(argv = process.argv.slice(2), options: HashlessContinuationMainOptions = {}): Promise<void> {
  const repository = options.repository ?? process.cwd().replace(/\/packages\/security-core$/, ""); const result = await runExpiredHashlessContinuationCli(argv, options.dependencies ?? createHashlessContinuationProductionDependencies(repository, argv)); (options.writeStdout ?? (value => { process.stdout.write(value); }))(publicJson(result));
}
if (require.main === module) void runHashlessContinuationEntryPoint(main());
