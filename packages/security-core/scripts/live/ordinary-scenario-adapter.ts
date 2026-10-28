import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { FileActivityStore } from "../../src/monitoring/ledger";
import { publicAlertPayloadHash } from "../../src/monitoring/notifier";
import { deriveDelayLifecycle } from "../../src/monitoring/delay-events";
import { assertSameSignerRequest, snapshotSafeSignerRequest, type Eip1193Provider, type SafeSignerRequest } from "../../src/signers/types";
import { decodeEventLog, decodeFunctionData, encodeAbiParameters, encodeFunctionData, hashTypedData, parseAbi, keccak256, serializeTransaction, type Address, type Hex } from "viem";
import type { LiveContext, LiveReceipt } from "./submission";
import { resolveOrdinaryScenarioExecutionProposal, type CanonicalOrdinaryScenarioState, type ConfirmationEffect, type OrdinaryScenarioActionRecord, type OrdinaryScenarioActionScope, type OrdinaryScenarioExecutionContext, type OrdinaryScenarioExecutionView, type OrdinaryScenarioJournal, type OrdinaryScenarioProposal, type PreparedOrdinaryAction, type SignedSimulationEvidence } from "./ordinary-scenario-executor";
import { reconstructReviewedPlan, verifyReconstructedPlanAtBlock } from "./ordinary-scenario-review-cli";
import { selectApprovedFees } from "./ordinary-review-profile";
import { SAFE_TX_TYPES, type VaultSigner } from "../../src/signers/types";
import { encodeGuardSafeSignatures } from "../../src/signers/guard-signatures";
import { encodeSafeExecutionCalldata } from "../../src/transport/calldata";
import { sha256 } from "../plan-deployment";

const SAFE_READ_ABI = parseAbi(["function nonce() view returns (uint256)"]);
const DELAY_READ_ABI = parseAbi(["function txNonce() view returns (uint256)", "function queueNonce() view returns (uint256)", "function getTxHash(uint256) view returns (bytes32)", "function getTxCreatedAt(uint256) view returns (uint256)"]);
const GUARD_READ_ABI = parseAbi(["function spendState(address) view returns (uint256,uint256,uint256)"]);
const ERC20_READ_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const ERC1271_ABI = parseAbi(["function isValidSignature(bytes32,bytes) view returns (bytes4)"]);
const SAFE_EVENT_ABI = parseAbi(["event ExecutionSuccess(bytes32 indexed txHash,uint256 payment)", "event ExecutionFailure(bytes32 indexed txHash,uint256 payment)"]);
const ERC20_EVENT_ABI = parseAbi(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
const DELAY_EVENT_ABI = parseAbi(["event TransactionAdded(uint256 indexed queueNonce,bytes32 indexed txHash,address to,uint256 value,bytes data,uint8 operation)", "event TxNonceSet(uint256 nonce)"]);
const DELAY_CALL_ABI = parseAbi(["function executeNextTx(address,uint256,bytes,uint8)", "function skipExpired()", "function setTxNonce(uint256)"]);
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const normalizeJournalInput = <T extends { proposal: OrdinaryScenarioProposal | OrdinaryScenarioExecutionView; journal(): OrdinaryScenarioJournal }>(input: T): Omit<T, "proposal" | "journal"> & { proposal: OrdinaryScenarioProposal; journal(): OrdinaryScenarioJournal } => {
  const proposal = resolveOrdinaryScenarioExecutionProposal(input.proposal);
  if (!("kind" in input.proposal) || input.proposal.kind === "original-ordinary-v1") return { ...input, proposal };
  const sourceJournal = input.journal;
  return { ...input, proposal, journal: () => { const source = sourceJournal(); const records = source.hashlessContinuation?.actions.filter((entry): entry is OrdinaryScenarioActionRecord => entry.status !== "approved") ?? []; return { ...source, actions: [...source.actions.slice(0, 18), ...records] }; } };
};

export type FrozenLocalAccountCapability = Readonly<{
  account: Address;
  request: SafeSignerRequest;
  signTypedData(request: SafeSignerRequest): Promise<Hex>;
}>;

/** Testnet-only Node facade for the reviewed legacy ECDSA identity. */
export function createFrozenSafeSignerProvider(input: FrozenLocalAccountCapability): Eip1193Provider {
  const frozen = snapshotSafeSignerRequest(input.request);
  const encoded = JSON.stringify(frozen.typedData, (_, value: unknown) => typeof value === "bigint" ? value.toString() : value);
  return Object.freeze({
    request: async ({ method, params }) => {
      if (method === "eth_chainId") {
        if (params !== undefined && params.length !== 0) throw new Error("frozen signer request mismatch");
        return `0x${frozen.chainId.toString(16)}`;
      }
      if (method === "eth_accounts") {
        if (params !== undefined && params.length !== 0) throw new Error("frozen signer request mismatch");
        return [input.account];
      }
      if (method !== "eth_signTypedData_v4") throw new Error("unsupported EIP-1193 method");
      if (!params || params.length !== 2 || typeof params[0] !== "string" || params[0].toLowerCase() !== input.account.toLowerCase() || params[1] !== encoded) throw new Error("frozen signer request mismatch");
      assertSameSignerRequest(frozen, input.request);
      return input.signTypedData(frozen);
    },
  });
}

type ViemPublicClient = Parameters<typeof reconstructReviewedPlan>[1];
export type OrdinaryScenarioStateReaderInput = Readonly<{
  repository: string;
  proposal: OrdinaryScenarioProposal | OrdinaryScenarioExecutionView;
  journal(): OrdinaryScenarioJournal;
  currentClient: ViemPublicClient;
  archiveClient: ViemPublicClient;
  observerReadiness(): Promise<Readonly<{ ready: boolean; evidenceHash: Hex }>>;
}>;
export type ReceiptStateBinding = Readonly<{ actionId: string; transactionHash: Hex; blockNumber: bigint; blockHash: Hex; evidenceBasis?: CanonicalOrdinaryScenarioState["evidenceBasis"] }>;

export function createOrdinaryScenarioStateReader(input: OrdinaryScenarioStateReaderInput) {
  const normalized = normalizeJournalInput(input);
  let reconstruction: Awaited<ReturnType<typeof reconstructReviewedPlan>> | undefined;
  const reconstructed = async () => reconstruction ??= await reconstructReviewedPlan(input.repository, input.archiveClient);
  return createOrdinaryScenarioMechanicalStateReader({ ...normalized, expectedChainId: 11155111, verifyProfileAtBlock: async (client, blockNumber) => { await verifyReconstructedPlanAtBlock(await reconstructed(), client, blockNumber); } });
}

export type OrdinaryScenarioMechanicalStateReaderInput = Omit<OrdinaryScenarioStateReaderInput, "repository"> & Readonly<{
  expectedChainId: number;
  verifyProfileAtBlock(client: ViemPublicClient, blockNumber: bigint): Promise<void>;
}>;

/** Non-authorizing mechanical core; the production wrapper above fixes Sepolia and public descriptor verification. */
export function createOrdinaryScenarioMechanicalStateReader(rawInput: OrdinaryScenarioMechanicalStateReaderInput) {
  const input = normalizeJournalInput(rawInput);
  return async (action: OrdinaryScenarioActionScope, phase: "pre-private" | "pre-outer", receiptBinding?: ReceiptStateBinding): Promise<CanonicalOrdinaryScenarioState> => {
    const journal = input.journal();
    let frozenFees: Readonly<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> | undefined;
    if (phase === "pre-outer") {
      const records = journal.actions.filter(record => record.id === action.id && record.commitment.toLowerCase() === action.commitment.toLowerCase());
      const record = records.length === 1 ? records[0] : undefined;
      if (record?.status !== "signed-simulated" || typeof record.maxFeePerGas !== "string" || typeof record.maxPriorityFeePerGas !== "string" || !DECIMAL.test(record.maxFeePerGas) || !DECIMAL.test(record.maxPriorityFeePerGas)) throw new Error("ordinary scenario persisted pre-outer fee quote is missing or invalid");
      const maxFeePerGas = BigInt(record.maxFeePerGas);
      const maxPriorityFeePerGas = BigInt(record.maxPriorityFeePerGas);
      if (maxFeePerGas <= 0n || maxPriorityFeePerGas > maxFeePerGas || maxFeePerGas > action.maxFeePerGasCap || maxPriorityFeePerGas > action.maxPriorityFeePerGasCap) throw new Error("ordinary scenario persisted pre-outer fee quote is missing or invalid");
      frozenFees = { maxFeePerGas, maxPriorityFeePerGas };
    }
    let client = input.currentClient;
    let evidenceBasis: CanonicalOrdinaryScenarioState["evidenceBasis"] = { kind: "current-head" };
    let selected: Readonly<{ number: bigint; hash: Hex; timestamp: bigint; baseFeePerGas?: bigint | null }>;
    if (receiptBinding) {
      client = input.archiveClient;
      const block = await client.getBlock({ blockNumber: receiptBinding.blockNumber } as never);
      if (!block.hash || block.hash.toLowerCase() !== receiptBinding.blockHash.toLowerCase()) throw new Error("ordinary scenario receipt poststate block is non-canonical");
      selected = { number: block.number!, hash: block.hash, timestamp: block.timestamp, baseFeePerGas: block.baseFeePerGas };
      evidenceBasis = receiptBinding.evidenceBasis ?? { kind: "receipt-poststate", actionId: receiptBinding.actionId, transactionHash: receiptBinding.transactionHash, blockNumber: receiptBinding.blockNumber, blockHash: receiptBinding.blockHash };
    } else if (action.kind === "expected-early-rejection") {
      const reviewed = input.proposal.actions.find(candidate => candidate.kind === "queue-proposal" && candidate.queue?.queueNonce === action.queue?.queueNonce && candidate.queue && action.queue && candidate.queue.fingerprint.toLowerCase() === action.queue.fingerprint.toLowerCase());
      const record = reviewed && journal.actions.find(entry => entry.id === reviewed.id && entry.status === "confirmed");
      if (!reviewed || !record?.receipt || !record.transactionHash) throw new Error("ordinary scenario early rejection proposal receipt is unavailable");
      client = input.archiveClient;
      const block = await client.getBlock({ blockNumber: record.receipt.blockNumber } as never);
      if (!block.hash || block.hash.toLowerCase() !== record.receipt.blockHash.toLowerCase()) throw new Error("ordinary scenario queue receipt archive block is non-canonical");
      selected = { number: block.number!, hash: block.hash, timestamp: block.timestamp, baseFeePerGas: block.baseFeePerGas };
      evidenceBasis = { kind: "queue-receipt", proposalActionId: reviewed.id, transactionHash: record.transactionHash };
    } else {
      const block = await client.getBlock();
      if (block.number === null || !block.hash) throw new Error("ordinary scenario latest canonical block is unavailable");
      selected = { number: block.number, hash: block.hash, timestamp: block.timestamp, baseFeePerGas: block.baseFeePerGas };
    }
    if (await client.getChainId() !== input.expectedChainId) throw new Error("ordinary scenario adapter chain mismatch");
    await input.verifyProfileAtBlock(client, selected.number);
    const read = (address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) => client.readContract({ address, abi, functionName, args, blockNumber: selected.number } as never) as Promise<unknown>;
    const [outerNonce, funderNativeBalance, safeNativeBalance, funderUsdcBalance, safeUsdcBalance, safeNonce, delayQueueNonce, delayTxNonce, nativeSpendRaw, usdcSpendRaw, observer, suggestedFees] = await Promise.all([
      client.getTransactionCount({ address: input.proposal.funder, blockNumber: selected.number } as never),
      client.getBalance({ address: input.proposal.funder, blockNumber: selected.number } as never), client.getBalance({ address: input.proposal.safe, blockNumber: selected.number } as never),
      read(input.proposal.usdc, ERC20_READ_ABI, "balanceOf", [input.proposal.funder]), read(input.proposal.usdc, ERC20_READ_ABI, "balanceOf", [input.proposal.safe]), read(input.proposal.safe, SAFE_READ_ABI, "nonce"),
      read(input.proposal.delay, DELAY_READ_ABI, "queueNonce"), read(input.proposal.delay, DELAY_READ_ABI, "txNonce"), read(input.proposal.guard, GUARD_READ_ABI, "spendState", [ZERO]), read(input.proposal.guard, GUARD_READ_ABI, "spendState", [input.proposal.usdc]),
      input.observerReadiness(), frozenFees ?? client.estimateFeesPerGas({ type: "eip1559" } as never),
    ]);
    if (!observer.ready || observer.evidenceHash.toLowerCase() !== input.proposal.observerEvidenceHash.toLowerCase()) throw new Error("ordinary scenario independent observer is not ready");
    const spend = (value: unknown) => { const tuple = value as readonly bigint[]; if (tuple.length !== 3) throw new Error("ordinary scenario spendState tuple mismatch"); return { window: BigInt(tuple[0]!), baseSpent: BigInt(tuple[1]!), instantSpent: BigInt(tuple[2]!) }; };
    let queue: CanonicalOrdinaryScenarioState["queue"];
    const controlled = evidenceBasis.kind === "receipt-poststate" ? action.after : action.before;
    if (controlled.queueStatus !== "EMPTY") {
      const reviewedHeads = input.proposal.actions.filter(candidate => candidate.kind === "queue-proposal" && candidate.queue && candidate.queue.queueNonce.toString() === controlled.queueNonce && candidate.queue.fingerprint.toLowerCase() === controlled.queueFingerprint?.toLowerCase());
      if (reviewedHeads.length !== 1 || !reviewedHeads[0]!.queue) throw new Error("ordinary scenario reviewed controlled queue head is missing or ambiguous");
      const reviewed = reviewedHeads[0]!.queue;
      const [fingerprint, createdAt] = await Promise.all([read(input.proposal.delay, DELAY_READ_ABI, "getTxHash", [reviewed.queueNonce]), read(input.proposal.delay, DELAY_READ_ABI, "getTxCreatedAt", [reviewed.queueNonce])]);
      if (String(fingerprint).toLowerCase() !== reviewed.fingerprint.toLowerCase()) throw new Error("ordinary scenario queue archive fingerprint mismatch");
      const status = controlled.queueStatus === "QUEUED_CONDITIONAL" ? "queued" : controlled.queueStatus === "CANCELLED_CONDITIONAL" ? "cancelled" : controlled.queueStatus === "EXPIRED_CONDITIONAL" ? "expired" : "executed";
      queue = { queueNonce: reviewed.queueNonce, fingerprint: reviewed.fingerprint, createdAt: BigInt(createdAt as bigint), status, to: reviewed.to, value: reviewed.value, data: reviewed.data, operation: reviewed.operation };
    }
    const dependencies = [];
    for (const dependencyId of action.dependsOn) {
      const record = journal.actions.find(entry => entry.id === dependencyId && (entry.status === "confirmed" || entry.status === "rejection-proved"));
      if (!record?.evidenceHash) throw new Error(`ordinary scenario dependency ${dependencyId} is unavailable`);
      if (record.receipt && (await client.getBlock({ blockNumber: record.receipt.blockNumber } as never)).hash?.toLowerCase() !== record.receipt.blockHash.toLowerCase()) throw new Error(`ordinary scenario dependency ${dependencyId} receipt changed`);
      dependencies.push({ actionId: dependencyId, transactionHash: record.transactionHash, blockHash: record.receipt?.blockHash, evidenceHash: record.evidenceHash });
    }
    const fees = selectApprovedFees(suggestedFees as never, selected.baseFeePerGas ?? 0n, { maxFeePerGas: action.maxFeePerGasCap, maxPriorityFeePerGas: action.maxPriorityFeePerGasCap });
    const recheck = await client.getBlock({ blockNumber: selected.number } as never);
    if (!recheck.hash || recheck.hash.toLowerCase() !== selected.hash.toLowerCase()) throw new Error("ordinary scenario canonical block changed during state read");
    return Object.freeze({ chainId: input.expectedChainId, blockNumber: selected.number, blockHash: selected.hash, blockTimestamp: selected.timestamp, evidenceBasis, planHash: input.proposal.planHash, topologyEvidenceHash: input.proposal.topologyEvidenceHash, publicIdentitiesHash: input.proposal.publicIdentitiesHash, observerReady: true, observerEvidenceHash: observer.evidenceHash, outerNonce: Number(outerNonce), funderNativeBalance, safeNativeBalance, funderUsdcBalance: BigInt(funderUsdcBalance as bigint), safeUsdcBalance: BigInt(safeUsdcBalance as bigint), safeNonce: BigInt(safeNonce as bigint), delayQueueNonce: BigInt(delayQueueNonce as bigint), delayTxNonce: BigInt(delayTxNonce as bigint), nativeSpend: spend(nativeSpendRaw), usdcSpend: spend(usdcSpendRaw), queue, dependencies, fees });
  };
}

export type OrdinaryScenarioAdapterInput = OrdinaryScenarioStateReaderInput & Readonly<{
  live: Omit<LiveContext, "verify" | "persist">;
  loadSigners(action: OrdinaryScenarioActionScope): Promise<Readonly<{ primary: VaultSigner; secondary?: VaultSigner }>>;
  observerLedgerPath?: string;
  receiverAcknowledgementPath?: string;
  observerEndpointHash?: Hex;
  receiverExpiresAt?: string;
  now?(): Date;
}>;

const alertKind = (kind: string): boolean => ["step-up-transfer", "queue-proposal", "queue-cancellation", "queue-expiry", "ready-delay-execution"].includes(kind);

export function createOrdinaryScenarioExecutionContext(input: OrdinaryScenarioAdapterInput): OrdinaryScenarioExecutionContext {
  return createOrdinaryScenarioMechanicalExecutionContext({ ...input, expectedChainId: 11155111 }, createOrdinaryScenarioStateReader(input));
}

export type OrdinaryScenarioMechanicalAdapterInput = Omit<OrdinaryScenarioAdapterInput, "repository"> & Readonly<{ expectedChainId: number }>;

/** Non-authorizing callback core; production supplies the closed state reader and Sepolia chain above. */
export function createOrdinaryScenarioMechanicalExecutionContext(rawInput: OrdinaryScenarioMechanicalAdapterInput, stateReader: ReturnType<typeof createOrdinaryScenarioMechanicalStateReader>): OrdinaryScenarioExecutionContext {
  const input = normalizeJournalInput(rawInput);
  const current = input.currentClient;
  const archive = input.archiveClient;
  const materialize = async (action: OrdinaryScenarioActionScope, state: CanonicalOrdinaryScenarioState): Promise<PreparedOrdinaryAction> => {
    let to: Address; let value: bigint; let data: Hex; let requestHash = action.commitment; let signatureBundleHash: Hex | null = null;
    if (action.safeTransaction) {
      const tx = action.safeTransaction;
      const typedData = { domain: { chainId: input.expectedChainId, verifyingContract: input.proposal.safe }, types: { SafeTx: SAFE_TX_TYPES }, primaryType: "SafeTx" as const, message: { to: tx.to, value: tx.value, data: tx.data, operation: tx.operation as 0 | 1, safeTxGas: tx.safeTxGas, baseGas: tx.baseGas, gasPrice: tx.gasPrice, gasToken: tx.gasToken, refundReceiver: tx.refundReceiver, nonce: tx.safeNonce } };
      const request: SafeSignerRequest = { chainId: input.expectedChainId, safe: input.proposal.safe, safeTxHash: tx.safeTxHash, typedData };
      if (hashTypedData(typedData).toLowerCase() !== tx.safeTxHash.toLowerCase()) throw new Error("ordinary scenario reviewed Safe digest mismatch");
      const signers = await input.loadSigners(action);
      const signatures = await encodeGuardSafeSignatures(request, signers.primary, signers.secondary);
      data = encodeSafeExecutionCalldata({ version: 1, kind: "safe-execution", idempotencyKey: action.commitment, chainId: input.expectedChainId, deploymentsHash: input.proposal.topologyEvidenceHash, policyHash: input.proposal.planHash, safe: input.proposal.safe, guard: input.proposal.guard, asset: action.asset === "native" ? ZERO : input.proposal.usdc, transaction: typedData.message, safeTxHash: tx.safeTxHash, signatures, expectedSpend: action.asset === "native" ? state.nativeSpend : state.usdcSpend });
      to = input.proposal.safe; value = 0n; requestHash = tx.safeTxHash; signatureBundleHash = keccak256(signatures);
    } else {
      const transaction = action.publicTransaction;
      if (!transaction) throw new Error("ordinary scenario public transaction is missing");
      ({ to, value, data } = transaction);
    }
    const liveIntent = { id: action.id, to, value, data, nonce: state.outerNonce, gas: action.gasLimitCap, maxFeePerGas: state.fees.maxFeePerGas, maxPriorityFeePerGas: state.fees.maxPriorityFeePerGas };
    return Object.freeze({ liveIntent, requestHash, signerRolesHash: sha256(action.signerRoles) as Hex, signedCalldataHash: keccak256(data), signatureBundleHash, transientSignedCalldata: data });
  };
  const recoverIntent = async (action: OrdinaryScenarioActionScope, record: { transactionHash?: Hex }) => {
    if (!record.transactionHash) throw new Error("ordinary scenario recovery transaction hash is missing");
    const transaction = await archive.getTransaction({ hash: record.transactionHash } as never);
    if (!transaction.to || transaction.type !== "eip1559" || transaction.chainId !== input.expectedChainId) throw new Error("ordinary scenario canonical recovery transaction is unavailable");
    return { id: action.id, to: transaction.to, value: transaction.value, data: transaction.input, nonce: transaction.nonce, gas: transaction.gas, maxFeePerGas: transaction.maxFeePerGas!, maxPriorityFeePerGas: transaction.maxPriorityFeePerGas! };
  };
  return Object.freeze({
    readState: stateReader,
    materialize,
    simulate: (action, prepared, state) => simulatePreparedOrdinaryAction({ blockHash: async number => { const block = await current.getBlock({ blockNumber: number } as never); if (!block.hash) throw new Error("simulation block hash unavailable"); return block.hash; }, call: async value => (await current.call({ account: value.from, to: value.to, value: value.value, data: value.data, blockNumber: value.blockNumber } as never)).data ?? "0x", estimateGas: value => current.estimateGas({ account: value.from, to: value.to, value: value.value, data: value.data, blockNumber: value.blockNumber } as never) }, input.proposal.funder, prepared, state.blockNumber, state.blockHash, action.gasLimitCap, ordinarySimulationResultContract(action, input.proposal.usdc)),
    proveRejection: async (action, state, prepared) => {
      const client = state.evidenceBasis.kind === "queue-receipt" ? archive : current;
      const transaction = prepared?.liveIntent ?? (action.publicTransaction ? { to: action.publicTransaction.to, value: action.publicTransaction.value, data: action.publicTransaction.data } : undefined);
      if (!transaction?.to) throw new Error("ordinary scenario rejection transaction is unavailable");
      let revertData: Hex | undefined;
      try { await client.call({ account: input.proposal.funder, to: transaction.to, value: transaction.value, data: transaction.data, blockNumber: state.blockNumber } as never); } catch (error) {
        let candidate: unknown = error;
        for (let depth = 0; depth < 8 && candidate && typeof candidate === "object"; depth++) { const object = candidate as Record<string, unknown>; if (typeof object.data === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(object.data)) { revertData = object.data as Hex; break; } candidate = object.cause; }
      }
      if (revertData === undefined) throw new Error("ordinary scenario expected rejection call did not return exact revert data");
      const block = await client.getBlock({ blockNumber: state.blockNumber } as never); if (!block.hash || block.hash.toLowerCase() !== state.blockHash.toLowerCase()) throw new Error("ordinary scenario rejection block changed");
      const postState = await stateReader(action, "pre-private", { actionId: action.id, transactionHash: keccak256(new TextEncoder().encode(action.id)), blockNumber: state.blockNumber, blockHash: state.blockHash, evidenceBasis: state.evidenceBasis });
      return { blockNumber: state.blockNumber, blockHash: state.blockHash, success: false as const, revertDataHash: keccak256(revertData), postState };
    },
    recoverPending: recoverIntent,
    recoverReplay: async (action, source) => {
      const transaction = await archive.getTransaction({ hash: source.transactionHash! } as never);
      if (!transaction.to || transaction.type !== "eip1559" || transaction.chainId !== input.expectedChainId || !transaction.r || !transaction.s || transaction.yParity === undefined) throw new Error("ordinary scenario replay source transaction is incomplete");
      const raw = reconstructCanonicalType2Transaction({ chainId: transaction.chainId, nonce: transaction.nonce, gas: transaction.gas, maxFeePerGas: transaction.maxFeePerGas!, maxPriorityFeePerGas: transaction.maxPriorityFeePerGas!, to: transaction.to, value: transaction.value, data: transaction.input, accessList: [], r: transaction.r, s: transaction.s, yParity: transaction.yParity as 0 | 1, hash: source.transactionHash! });
      const sourceAction = input.proposal.actions.find(candidate => candidate.id === source.id);
      if (!sourceAction?.safeTransaction || !action.safeTransaction) throw new Error("ordinary scenario replay source action is not a Safe action");
      const liveIntent = await recoverIntent(action, source);
      return { liveIntent, requestHash: action.safeTxHash!, signerRolesHash: sha256(action.signerRoles) as Hex, signedCalldataHash: keccak256(liveIntent.data), signatureBundleHash: source.signatureBundleHash ?? null, transientSignedCalldata: liveIntent.data, replaySource: { actionId: source.id, safeTxHash: action.safeTxHash!, safeNonce: action.safeTransaction.safeNonce }, transientSignedOuterTransaction: raw };
    },
    verifyContractSignature: async (signer, safeTxHash, signature, blockNumber) => String(await archive.readContract({ address: signer, abi: ERC1271_ABI, functionName: "isValidSignature", args: [safeTxHash, signature], blockNumber } as never)) as Hex,
    confirm: async (action, entry, record) => {
      if (!entry.receipt) throw new Error("ordinary scenario confirmation receipt is missing");
      const [canonicalReceipt, canonicalTransaction] = await Promise.all([archive.getTransactionReceipt({ hash: entry.receipt.transactionHash } as never), archive.getTransaction({ hash: entry.receipt.transactionHash } as never)]);
      if (canonicalReceipt.status !== "success" || canonicalReceipt.blockNumber !== entry.receipt.blockNumber || canonicalReceipt.blockHash.toLowerCase() !== entry.receipt.blockHash.toLowerCase()) throw new Error("ordinary scenario canonical confirmation receipt mismatch");
      if (!record.outerTo || record.outerValue === undefined || !record.outerDataHash || !canonicalTransaction.to || canonicalTransaction.to.toLowerCase() !== record.outerTo.toLowerCase() || canonicalTransaction.value.toString() !== record.outerValue || keccak256(canonicalTransaction.input).toLowerCase() !== record.outerDataHash.toLowerCase() || canonicalTransaction.nonce !== record.outerNonce || canonicalTransaction.gas.toString() !== record.gas || canonicalTransaction.maxFeePerGas?.toString() !== record.maxFeePerGas || canonicalTransaction.maxPriorityFeePerGas?.toString() !== record.maxPriorityFeePerGas) throw new Error("ordinary scenario canonical confirmation transaction mismatch");
      const postState = await stateReader(action, "pre-private", { actionId: action.id, transactionHash: entry.receipt.transactionHash, blockNumber: entry.receipt.blockNumber, blockHash: entry.receipt.blockHash });
      let effect: ConfirmationEffect;
      if (action.id === "native-funding") effect = { kind: "native-funding", to: input.proposal.safe, amount: action.publicTransaction!.value };
      else if (action.kind === "funding" || action.kind === "controlled-recipient-recycled-funding") {
        const transfers = canonicalReceipt.logs.filter(log => log.address.toLowerCase() === input.proposal.usdc.toLowerCase()).flatMap(log => { try { const decoded = decodeEventLog({ abi: ERC20_EVENT_ABI, data: log.data, topics: log.topics }); return decoded.eventName === "Transfer" ? [decoded.args] : []; } catch { return []; } });
        const amount = postState.safeUsdcBalance - BigInt(action.before.safeUsdcBalance);
        if (transfers.length !== 1 || transfers[0]!.from.toLowerCase() !== input.proposal.funder.toLowerCase() || transfers[0]!.to.toLowerCase() !== input.proposal.safe.toLowerCase() || transfers[0]!.value !== amount) throw new Error("ordinary scenario ERC-20 funding Transfer mismatch");
        effect = { kind: "erc20-funding", token: input.proposal.usdc, from: input.proposal.funder, to: input.proposal.safe, amount };
      } else if (action.safeTxHash) {
        const safeEvents = canonicalReceipt.logs.filter(log => log.address.toLowerCase() === input.proposal.safe.toLowerCase()).flatMap(log => { try { const decoded = decodeEventLog({ abi: SAFE_EVENT_ABI, data: log.data, topics: log.topics }); return [decoded]; } catch { return []; } });
        const success = safeEvents.filter(event => event.eventName === "ExecutionSuccess" && event.args.txHash.toLowerCase() === action.safeTxHash!.toLowerCase());
        if (success.length !== 1 || safeEvents.some(event => event.eventName === "ExecutionFailure")) throw new Error("ordinary scenario exact Safe execution receipt mismatch");
        if (action.kind === "queue-proposal") {
          const additions = canonicalReceipt.logs.filter(log => log.address.toLowerCase() === input.proposal.delay.toLowerCase()).flatMap(log => { try { const decoded = decodeEventLog({ abi: DELAY_EVENT_ABI, data: log.data, topics: log.topics }); return decoded.eventName === "TransactionAdded" ? [decoded.args] : []; } catch { return []; } });
          const queue = action.queue; if (!queue || additions.length !== 1 || additions[0]!.queueNonce !== queue.queueNonce || additions[0]!.txHash.toLowerCase() !== queue.fingerprint.toLowerCase() || additions[0]!.to.toLowerCase() !== queue.to.toLowerCase() || additions[0]!.value !== queue.value || additions[0]!.data.toLowerCase() !== queue.data.toLowerCase() || additions[0]!.operation !== queue.operation || postState.queue?.createdAt !== postState.blockTimestamp) throw new Error("ordinary scenario exact TransactionAdded receipt mismatch");
        }
        if (action.kind === "queue-cancellation") {
          const nonceEvents = canonicalReceipt.logs.filter(log => log.address.toLowerCase() === input.proposal.delay.toLowerCase()).flatMap(log => { try { const decoded = decodeEventLog({ abi: DELAY_EVENT_ABI, data: log.data, topics: log.topics }); return decoded.eventName === "TxNonceSet" ? [decoded.args.nonce] : []; } catch { return []; } });
          if (nonceEvents.length !== 1 || nonceEvents[0] !== postState.delayTxNonce) throw new Error("ordinary scenario exact TxNonceSet receipt mismatch");
        }
        effect = { kind: "safe-execution", safeTxHash: action.safeTxHash, queueCreatedAt: action.kind === "queue-proposal" ? postState.blockTimestamp : undefined, queueFingerprint: action.kind === "queue-proposal" ? action.queue?.fingerprint : undefined };
      } else if (action.queue) {
        if (!canonicalTransaction.to || canonicalTransaction.to.toLowerCase() !== input.proposal.delay.toLowerCase() || !action.publicTransaction || canonicalTransaction.input.toLowerCase() !== action.publicTransaction.data.toLowerCase() || canonicalTransaction.value !== action.publicTransaction.value) throw new Error("ordinary scenario Delay confirmation input mismatch");
        const proposalAction = input.proposal.actions.find(candidate => candidate.kind === "queue-proposal" && candidate.queue?.queueNonce === action.queue!.queueNonce && candidate.queue.fingerprint.toLowerCase() === action.queue!.fingerprint.toLowerCase());
        const proposalRecord = proposalAction && input.journal().actions.find(candidate => candidate.id === proposalAction.id && candidate.status === "confirmed");
        if (!proposalRecord?.receipt || !proposalRecord.queueCreatedAt) throw new Error("ordinary scenario Delay proposal archive is unavailable");
        const cooldownSeconds = BigInt(input.proposal.cooldownSeconds); const expirationSeconds = BigInt(input.proposal.expirationSeconds); const createdAt = BigInt(proposalRecord.queueCreatedAt);
        const queued = { kind: "delayed-queued" as const, chainId: input.expectedChainId, safe: input.proposal.safe, delay: input.proposal.delay, transactionHash: proposalRecord.receipt.transactionHash, blockNumber: proposalRecord.receipt.blockNumber, logIndex: 0, queueNonce: action.queue.queueNonce, queueFingerprint: action.queue.fingerprint, createdAt, expiresAt: createdAt + cooldownSeconds + expirationSeconds, to: action.queue.to, value: action.queue.value, data: action.queue.data, operation: action.queue.operation };
        const lifecycle = await deriveDelayLifecycle(queued, { chainId: input.expectedChainId, safe: input.proposal.safe, delay: input.proposal.delay, confirmations: 1, cooldownSeconds, expirationSeconds }, canonicalReceipt.blockNumber, {
          readLifecycleReceipts: async () => [{ transactionHash: canonicalTransaction.hash, blockNumber: canonicalReceipt.blockNumber, blockHash: canonicalReceipt.blockHash, status: canonicalReceipt.status, to: canonicalTransaction.to!, input: canonicalTransaction.input }],
          readCanonicalBlock: async blockNumber => { const block = await archive.getBlock({ blockNumber } as never); if (!block.hash) throw new Error("ordinary scenario Delay lifecycle block unavailable"); return { blockNumber, blockHash: block.hash, timestamp: block.timestamp }; },
          decodeLifecycleCall: data => { const decoded = decodeFunctionData({ abi: DELAY_CALL_ABI, data }); return { functionName: decoded.functionName, args: decoded.args ?? [] }; },
          readNonce: async blockNumber => BigInt(await archive.readContract({ address: input.proposal.delay, abi: DELAY_READ_ABI, functionName: "txNonce", blockNumber } as never) as bigint),
          readQueue: async (queueNonce, blockNumber) => { const [txHash, createdAt] = await Promise.all([archive.readContract({ address: input.proposal.delay, abi: DELAY_READ_ABI, functionName: "getTxHash", args: [queueNonce], blockNumber } as never), archive.readContract({ address: input.proposal.delay, abi: DELAY_READ_ABI, functionName: "getTxCreatedAt", args: [queueNonce], blockNumber } as never)]); return { txHash: txHash as Hex, createdAt: BigInt(createdAt as bigint), to: action.queue!.to, value: action.queue!.value, data: action.queue!.data, operation: action.queue!.operation }; },
        });
        const expectedLifecycle = action.kind === "queue-expiry" ? "delayed-expired" : "delayed-executed";
        if (!lifecycle || lifecycle.kind !== expectedLifecycle || lifecycle.transactionHash.toLowerCase() !== entry.receipt.transactionHash.toLowerCase()) throw new Error("ordinary scenario Delay lifecycle derivation mismatch");
        effect = { kind: "delay-lifecycle", lifecycle: action.kind === "queue-expiry" ? "expired" : "executed", fingerprint: action.queue.fingerprint, createdAt: postState.queue?.createdAt ?? 0n };
      }
      else throw new Error("ordinary scenario confirmation effect is unsupported");
      let observerEvidenceHash: Hex | null = null;
      if (alertKind(action.kind)) {
        if (!input.observerLedgerPath || !input.receiverAcknowledgementPath || !input.observerEndpointHash) throw new Error("ordinary scenario activity evidence is not yet available");
        observerEvidenceHash = loadObserverConfirmationEvidence({ ledgerPath: input.observerLedgerPath, acknowledgementPath: input.receiverAcknowledgementPath, endpointHash: input.observerEndpointHash, ...(input.receiverExpiresAt ? { receiverExpiresAt: input.receiverExpiresAt } : {}), transactionHash: entry.receipt.transactionHash, now: input.now?.() ?? new Date() });
      }
      return { postState, effect, observerEvidenceHash };
    },
    live: input.live,
  });
}

function ordinarySimulationResultContract(action: OrdinaryScenarioActionScope, usdc: Address): "bool-true" | "empty" {
  if (action.safeTransaction) return "bool-true";
  const transaction = action.publicTransaction;
  if (!transaction) throw new Error("ordinary scenario simulation transaction is missing");
  if (transaction.to.toLowerCase() !== usdc.toLowerCase()) return "empty";
  if (transaction.data.slice(0, 10).toLowerCase() !== "0xa9059cbb") throw new Error("ordinary scenario public token simulation is not transfer");
  return "bool-true";
}

export type CanonicalBlockReader = Readonly<{
  blockNumber(): Promise<bigint>;
  blockHash(number: bigint): Promise<Hex>;
}>;

export function requireSixConfirmationReceipts(base: Omit<LiveContext, "receipt" | "verify" | "persist"> & Readonly<{ receipt(hash: Hex): Promise<LiveReceipt | undefined> }>, chain: CanonicalBlockReader): Omit<LiveContext, "verify" | "persist"> {
  return Object.freeze({ ...base, receipt: async (hash: Hex) => {
    const receipt = await base.receipt(hash);
    if (!receipt) return undefined;
    const first = await chain.blockHash(receipt.blockNumber);
    if (first.toLowerCase() !== receipt.blockHash.toLowerCase() || await chain.blockNumber() < receipt.blockNumber + 5n) return undefined;
    const second = await chain.blockHash(receipt.blockNumber);
    if (second.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new Error("ordinary scenario receipt block changed during confirmation check");
    return receipt;
  } });
}

export type ExactSimulationClient = Readonly<{
  call(input: Readonly<{ from: Address; to: Address; value: bigint; data: Hex; blockNumber: bigint }>): Promise<Hex>;
  estimateGas(input: Readonly<{ from: Address; to: Address; value: bigint; data: Hex; blockNumber: bigint }>): Promise<bigint>;
  blockHash(number: bigint): Promise<Hex>;
}>;

export async function simulatePreparedOrdinaryAction(client: ExactSimulationClient, funder: Address, prepared: PreparedOrdinaryAction, blockNumber: bigint, blockHash: Hex, actionCap: bigint, expectedResult: "bool-true" | "empty"): Promise<SignedSimulationEvidence> {
  if (!prepared.liveIntent.to) throw new Error("ordinary scenario simulation target is missing");
  if ((await client.blockHash(blockNumber)).toLowerCase() !== blockHash.toLowerCase()) throw new Error("ordinary scenario simulation block changed");
  const input = { from: funder, to: prepared.liveIntent.to, value: prepared.liveIntent.value, data: prepared.liveIntent.data, blockNumber };
  const [result, gasEstimate] = await Promise.all([client.call(input), client.estimateGas(input)]);
  const canonicalResult = expectedResult === "bool-true" ? encodeAbiParameters([{ type: "bool" }], [true]) : "0x";
  if (result.toLowerCase() !== canonicalResult.toLowerCase()) throw new Error("ordinary scenario signed simulation result mismatch");
  if (gasEstimate <= 0n || gasEstimate > prepared.liveIntent.gas || gasEstimate > actionCap) throw new Error("ordinary scenario signed estimate exceeds approved cap");
  if ((await client.blockHash(blockNumber)).toLowerCase() !== blockHash.toLowerCase()) throw new Error("ordinary scenario simulation block changed");
  return Object.freeze({ blockNumber, blockHash, success: true, gasEstimate, resultHash: keccak256(result) });
}

export type PublicReceiverAcknowledgement = Readonly<{ schemaVersion: 1; endpointHash: Hex; transactionHash: Hex; payloadSha256: Hex; receiverRequestId: string; receiverRecordedAt: string; retrievedAt: string; retrievalProvenance: "official-receiver-api"; expiresAt: string }>;

export function validatePublicReceiverAcknowledgement(value: PublicReceiverAcknowledgement, expected: Readonly<{ endpointHash: Hex; transactionHash: Hex; payloadSha256: Hex; now: Date; expiresAt?: string }>): Hex {
  if (value.schemaVersion !== 1 || value.retrievalProvenance !== "official-receiver-api" || value.endpointHash.toLowerCase() !== expected.endpointHash.toLowerCase() || value.transactionHash.toLowerCase() !== expected.transactionHash.toLowerCase() || value.payloadSha256.toLowerCase() !== expected.payloadSha256.toLowerCase() || !/^[A-Za-z0-9-]{1,200}$/.test(value.receiverRequestId)) throw new Error("receiver acknowledgement binding mismatch");
  for (const [label, timestamp] of [["receiver time", value.receiverRecordedAt], ["retrieval time", value.retrievedAt], ["expiry", value.expiresAt]] as const) if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`invalid ${label}`);
  const expiry = Date.parse(value.expiresAt); const recorded = Date.parse(value.receiverRecordedAt); const retrieved = Date.parse(value.retrievedAt);
  if (expiry !== Date.parse(expected.expiresAt ?? "2026-10-28T18:51:57Z") || recorded > retrieved || recorded > expiry || retrieved > expiry) throw new Error("receiver acknowledgement was not captured timely before expiry");
  return keccak256(new TextEncoder().encode(JSON.stringify(value)));
}

export function loadObserverConfirmationEvidence(input: Readonly<{ ledgerPath: string; acknowledgementPath: string; endpointHash: Hex; receiverExpiresAt?: string; transactionHash: Hex; expected?: Readonly<{ kind: "delayed-queued" | "delayed-executed" | "delayed-cancelled"; safe: Address; delay: Address; blockNumber: bigint; queueNonce?: bigint; queueFingerprint?: Hex; cancelledThrough?: bigint }>; now: Date }>): Hex {
  const store = new FileActivityStore(input.ledgerPath);
  try {
    const state = store.load();
    const matches = Object.entries(state.records).filter(([, alert]) => alert.transactionHash.toLowerCase() === input.transactionHash.toLowerCase());
    if (matches.length !== 1) throw new Error("observer ledger must contain exactly one action transaction record");
    const [recordId, alert] = matches[0]!;
    const expected = input.expected;
    if (expected && (alert.kind !== expected.kind || alert.safe.toLowerCase() !== expected.safe.toLowerCase() || alert.blockNumber !== expected.blockNumber || !("delay" in alert) || alert.delay.toLowerCase() !== expected.delay.toLowerCase() || (expected.queueNonce !== undefined && (!("queueNonce" in alert) || alert.queueNonce !== expected.queueNonce)) || (expected.queueFingerprint !== undefined && (!("queueFingerprint" in alert) || alert.queueFingerprint.toLowerCase() !== expected.queueFingerprint.toLowerCase())) || (expected.cancelledThrough !== undefined && (!("cancelledThrough" in alert) || alert.cancelledThrough !== expected.cancelledThrough)))) throw new Error("observer repair action evidence does not match the expected canonical effect");
    if (state.outbox[recordId]) throw new Error("observer delivery remains pending");
    const delivery = state.deliveries[recordId]; const payloadSha256 = publicAlertPayloadHash(alert);
    if (!delivery || delivery.payloadHash.toLowerCase() !== payloadSha256.toLowerCase()) throw new Error("observer sender delivery evidence is missing or mismatched");
    let acknowledgement: PublicReceiverAcknowledgement;
    try { acknowledgement = JSON.parse(readFileSync(input.acknowledgementPath, "utf8")) as PublicReceiverAcknowledgement; } catch { throw new Error("receiver acknowledgement is unavailable or malformed"); }
    const acknowledgementHash = validatePublicReceiverAcknowledgement(acknowledgement, { endpointHash: input.endpointHash, transactionHash: input.transactionHash, payloadSha256, now: input.now, ...(input.receiverExpiresAt ? { expiresAt: input.receiverExpiresAt } : {}) });
    return `0x${createHash("sha256").update(JSON.stringify({ transactionHash: input.transactionHash.toLowerCase(), payloadSha256: payloadSha256.toLowerCase(), delivery, acknowledgementHash })).digest("hex")}` as Hex;
  } finally { store.close(); }
}

export type CanonicalType2Transaction = Readonly<{ chainId: number; nonce: number; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; to: Address; value: bigint; data: Hex; accessList: readonly []; r: Hex; s: Hex; yParity: 0 | 1; hash: Hex }>;

export function reconstructCanonicalType2Transaction(source: CanonicalType2Transaction): Hex {
  const serialized = serializeTransaction({ type: "eip1559", chainId: source.chainId, nonce: source.nonce, gas: source.gas, maxFeePerGas: source.maxFeePerGas, maxPriorityFeePerGas: source.maxPriorityFeePerGas, to: source.to, value: source.value, data: source.data, accessList: source.accessList }, { r: source.r, s: source.s, yParity: source.yParity });
  if (keccak256(serialized).toLowerCase() !== source.hash.toLowerCase()) throw new Error("canonical replay transaction hash mismatch");
  return serialized;
}
