import { createHash } from "node:crypto";
import { decodeEventLog, encodeFunctionData, hashTypedData, keccak256, parseAbi, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { encodeGuardSafeSignatures } from "../../src/signers/guard-signatures";
import { SAFE_TX_TYPES, type SafeSignerRequest, type VaultSigner } from "../../src/signers/types";
import { verifyPasskeySignerComponent } from "../../src/topology/evidence";
import { verifyTopology } from "../../src/topology/verify";
import { queueFingerprint } from "../../src/queue/delay";
import { createPinnedSafeReviewClient } from "./safe-creation-adapter";
import { verifyReconstructedPlanAtBlock, type reconstructReviewedPlan } from "./ordinary-scenario-review-cli";
import type { OrdinaryScenarioProductionHarness } from "./ordinary-scenario-executor-cli";
import { PRODUCTION_REPAIR_EXECUTION_DOMAIN, REPAIR_BINDING_HASH, recoverCanonicalRepairCalldata, type RepairActionReview, type RepairCanonicalState, type RepairCreationProposal, type RepairCreationQuote, type RepairGroupProposal, type RepairQueueTimingEvidence, type TransientRepairGroup } from "./ordinary-scenario-repair";
import type { OrdinaryScenarioJournal, OrdinaryScenarioProposal } from "./ordinary-scenario-executor";
import type { LiveIntent } from "./submission";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const SAFE_ABI = [{ type: "function", name: "execTransaction", stateMutability: "payable", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }, { name: "operation", type: "uint8" }, { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" }, { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" }, { name: "signatures", type: "bytes" }], outputs: [{ type: "bool" }] }] as const;
const SAFE_READ = parseAbi(["function nonce() view returns (uint256)"]);
const DELAY_READ = parseAbi(["function queueNonce() view returns (uint256)", "function txNonce() view returns (uint256)"]);
const GUARD_READ = parseAbi(["function safeContractSecondary() view returns (address,uint8,bool)", "function policyHash() view returns (bytes32)", "function frozen() view returns (bool)", "function spendState(address) view returns (uint256,uint256,uint256)"]);
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const DELAY_ABI = parseAbi(["function execTransactionFromModule(address,uint256,bytes,uint8) returns (bool)", "function executeNextTx(address,uint256,bytes,uint8)", "function setTxNonce(uint256)"]);
const GUARD_ABI = parseAbi(["function freeze()"]);
const GUARD_CHECK_ABI = parseAbi(["function checkTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes,address)", "function checkModuleTransaction(address,uint256,bytes,uint8,address) returns (bytes32)"]);
const SAFE_EVENTS = parseAbi(["event ExecutionSuccess(bytes32 indexed txHash,uint256 payment)", "event ExecutionFailure(bytes32 indexed txHash,uint256 payment)"]);
const DELAY_EVENTS = parseAbi(["event TransactionAdded(uint256 indexed queueNonce,bytes32 indexed txHash,address to,uint256 value,bytes data,uint8 operation)", "event TxNonceSet(uint256 nonce)"]);
const publicHash = (value: unknown): Hex => `0x${createHash("sha256").update(JSON.stringify(value, (_, child) => typeof child === "bigint" ? child.toString() : child)).digest("hex")}` as Hex;

export async function materializeRepairPrimaryFirstSafeCall(input: Readonly<{ chainId: number; safe: Address; to: Address; data: Hex; nonce: bigint; safeTxHash: Hex; primary: VaultSigner; secondary: VaultSigner }>): Promise<Hex> {
  const typedData = { domain: { chainId: input.chainId, verifyingContract: input.safe }, types: { SafeTx: SAFE_TX_TYPES }, primaryType: "SafeTx" as const, message: { to: input.to, value: 0n, data: input.data, operation: 0 as const, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO, nonce: input.nonce } };
  if (hashTypedData(typedData).toLowerCase() !== input.safeTxHash.toLowerCase()) throw new Error("repair materializer Safe hash mismatch");
  const request: SafeSignerRequest = { chainId: input.chainId, safe: input.safe, safeTxHash: input.safeTxHash, typedData }; const signatures = await encodeGuardSafeSignatures(request, input.primary, input.secondary);
  return encodeFunctionData({ abi: SAFE_ABI, functionName: "execTransaction", args: [input.to, 0n, input.data, 0, 0n, 0n, 0n, ZERO, ZERO, signatures] });
}

export function validateRepairReceiptEffect(proposal: RepairGroupProposal, action: RepairActionReview, logs: readonly Readonly<{ address: Address; data: Hex; topics: readonly Hex[] }>[], maintenanceCalldata?: Hex): true {
  if (action.safeTxHash) {
    const events = logs.filter(log => log.address.toLowerCase() === proposal.safe.toLowerCase()).flatMap(log => { try { if (log.topics.length === 0) return []; return [decodeEventLog({ abi: SAFE_EVENTS, data: log.data, topics: [...log.topics] as [Hex, ...Hex[]], strict: true })]; } catch { return []; } });
    const success = events.filter(event => event.eventName === "ExecutionSuccess" && event.args.txHash.toLowerCase() === action.safeTxHash!.toLowerCase());
    if (success.length !== 1 || events.some(event => event.eventName === "ExecutionFailure")) throw new Error("repair exact Safe execution receipt mismatch");
  }
  const delayEvents = logs.filter(log => log.address.toLowerCase() === proposal.delay.toLowerCase()).flatMap(log => { try { if (log.topics.length === 0) return []; return [decodeEventLog({ abi: DELAY_EVENTS, data: log.data, topics: [...log.topics] as [Hex, ...Hex[]], strict: true })]; } catch { return []; } });
  if (action.id === "repair-queue" || action.id === "post-rotation-new-secondary-queue") {
    const expected = action.id === "repair-queue" ? { queueNonce: 6n, to: proposal.repair.maintenance, value: 0n, data: maintenanceCalldata, operation: 1 as const } : { queueNonce: 7n, to: proposal.recipient, value: 1n, data: "0x" as Hex, operation: 0 as const };
    if (!expected.data) throw new Error("repair queue receipt validation requires canonical maintenance calldata");
    const additions = delayEvents.flatMap(event => event.eventName === "TransactionAdded" ? [event.args] : []);
    const added = additions[0];
    if (additions.length !== 1 || !added || added.queueNonce !== expected.queueNonce || added.to.toLowerCase() !== expected.to.toLowerCase() || added.value !== expected.value || added.data.toLowerCase() !== expected.data.toLowerCase() || added.operation !== expected.operation || !action.queueFingerprint || queueFingerprint({ safe: proposal.safe, delay: proposal.delay, queueNonce: expected.queueNonce, to: expected.to, value: expected.value, data: expected.data, operation: expected.operation }).toLowerCase() !== action.queueFingerprint.toLowerCase() || added.txHash.toLowerCase() !== action.queueFingerprint.toLowerCase()) throw new Error("repair exact TransactionAdded receipt mismatch");
  }
  if (action.id === "post-rotation-proof-cancel") {
    const nonces = delayEvents.flatMap(event => event.eventName === "TxNonceSet" ? [event.args.nonce] : []);
    if (nonces.length !== 1 || nonces[0] !== 8n) throw new Error("repair exact TxNonceSet receipt mismatch");
  }
  return true;
}

type Reconstructed = Awaited<ReturnType<typeof reconstructReviewedPlan>>;
export type RepairAdapterDescriptor = Pick<RepairCreationProposal, "safe" | "guard" | "delay" | "funder" | "candidate" | "factory" | "x" | "y" | "verifiers" | "preRotationBlockNumber" | "preRotationBlockHash">;

export function createRepairAdapterDescriptor(proposal: OrdinaryScenarioProposal, quote: RepairCreationQuote, anchor: Readonly<{ blockNumber: bigint; blockHash: Hex }>): RepairAdapterDescriptor {
  return Object.freeze({ safe: proposal.safe, guard: proposal.guard, delay: proposal.delay, funder: proposal.funder, candidate: quote.candidate, factory: quote.factory, x: quote.x.toString(), y: quote.y.toString(), verifiers: quote.verifiers.toString(), preRotationBlockNumber: anchor.blockNumber.toString(), preRotationBlockHash: anchor.blockHash });
}

export type RepairMechanicalStateDependencies = Readonly<{
  chainId: number;
  current: Pick<OrdinaryScenarioProductionHarness["current"], "getBlock" | "readContract" | "getBalance" | "getCode">;
  creation: Pick<RepairAdapterDescriptor, "safe" | "guard" | "delay" | "candidate">;
  usdc: Address;
  candidateBindingHash: Hex;
  observerReadiness(observerEvidenceHash: Hex): Promise<Readonly<{ ready: boolean }>>;
  verifyCanonicalProfile(blockNumber: bigint, phase: "pre-rotation" | "post-rotation"): Promise<Hex>;
}>;

/** Chain-explicit RPC mechanics. Production supplies only the fixed Sepolia verifier; local tests supply a real 31337 topology verifier. */
export function createRepairMechanicalStateReader(input: RepairMechanicalStateDependencies) {
  return async (phase: "pre-rotation" | "post-rotation", observerEvidenceHash: Hex, requestedBlock?: bigint, expectedBlockHash?: Hex): Promise<RepairCanonicalState> => {
    const block = requestedBlock === undefined ? await input.current.getBlock() : await input.current.getBlock({ blockNumber: requestedBlock });
    if (!block.hash) throw new Error("repair canonical block hash unavailable");
    if (expectedBlockHash && block.hash.toLowerCase() !== expectedBlockHash.toLowerCase()) throw new Error("repair canonical block changed");
    const read = <T>(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) => input.current.readContract({ address, abi, functionName, args, blockNumber: block.number }) as Promise<T>;
    const [safeNonce, queueNonce, txNonce, secondary, policyHash, frozen, spend, usdcSpend, nativeBalance, usdcBalance, runtime, observer, topologyEvidenceHash] = await Promise.all([
      read<bigint>(input.creation.safe, SAFE_READ, "nonce"), read<bigint>(input.creation.delay, DELAY_READ, "queueNonce"), read<bigint>(input.creation.delay, DELAY_READ, "txNonce"), read<readonly [Address, number, boolean]>(input.creation.guard, GUARD_READ, "safeContractSecondary"), read<Hex>(input.creation.guard, GUARD_READ, "policyHash"), read<boolean>(input.creation.guard, GUARD_READ, "frozen"), read<readonly [bigint, bigint, bigint]>(input.creation.guard, GUARD_READ, "spendState", [ZERO]), read<readonly [bigint, bigint, bigint]>(input.creation.guard, GUARD_READ, "spendState", [input.usdc]), input.current.getBalance({ address: input.creation.safe, blockNumber: block.number }), read<bigint>(input.usdc, ERC20, "balanceOf", [input.creation.safe]), input.current.getCode({ address: input.creation.candidate, blockNumber: block.number }), input.observerReadiness(observerEvidenceHash), input.verifyCanonicalProfile(block.number, phase),
    ]);
    return Object.freeze({ chainId: input.chainId, blockNumber: block.number, blockHash: block.hash, blockTimestamp: block.timestamp, safeNonce, delayQueueNonce: queueNonce, delayTxNonce: txNonce, safeContractSecondary: secondary[0], candidateRuntimeCodeHash: runtime && runtime !== "0x" ? keccak256(runtime) : `0x${"00".repeat(32)}` as Hex, candidateBindingHash: runtime && runtime !== "0x" ? input.candidateBindingHash : `0x${"00".repeat(32)}` as Hex, policyHash, frozen, nativeWindow: spend[0], nativeBaseSpent: spend[1], nativeInstantSpent: spend[2], usdcWindow: usdcSpend[0], usdcBaseSpent: usdcSpend[1], usdcInstantSpent: usdcSpend[2], nativeBalance, usdcBalance, topologyEvidenceHash, observerReady: observer.ready });
  };
}

export async function recoverRepairPendingIntent(input: Readonly<{ chainId: number; current: Pick<OrdinaryScenarioProductionHarness["current"], "getTransaction">; creation: Pick<RepairAdapterDescriptor, "factory">; proposal?: RepairGroupProposal; action: RepairActionReview; transactionHash: Hex }>): Promise<LiveIntent> {
  const transaction = await input.current.getTransaction({ hash: input.transactionHash });
  if (!transaction.to || transaction.chainId !== input.chainId || transaction.type !== "eip1559" || transaction.maxFeePerGas === undefined || transaction.maxPriorityFeePerGas === undefined) throw new Error("repair pending outer envelope is unavailable or malformed");
  if (input.action.kind === "factory-create") { if (transaction.to.toLowerCase() !== input.creation.factory.toLowerCase() || transaction.value !== 0n || keccak256(transaction.input).toLowerCase() !== input.action.requestDataHash.toLowerCase()) throw new Error("repair pending factory envelope mismatch"); }
  else if (input.action.kind === "delay-execute") { if (!input.proposal || transaction.to.toLowerCase() !== input.proposal.delay.toLowerCase() || transaction.value !== 0n || keccak256(transaction.input).toLowerCase() !== input.action.requestDataHash.toLowerCase()) throw new Error("repair pending Delay envelope mismatch"); }
  else {
    if (!input.proposal || transaction.to.toLowerCase() !== input.proposal.safe.toLowerCase() || transaction.value !== 0n) throw new Error("repair pending Safe envelope mismatch");
    let decoded: { functionName: string; args?: readonly unknown[] }; try { decoded = (await import("viem")).decodeFunctionData({ abi: SAFE_ABI, data: transaction.input }); } catch { throw new Error("repair pending Safe calldata is malformed"); }
    if (decoded.functionName !== "execTransaction") throw new Error("repair pending Safe selector mismatch"); const args = decoded.args as readonly [Address, bigint, Hex, number, bigint, bigint, bigint, Address, Address, Hex];
    const reviewedHash = hashTypedData({ domain: { chainId: input.chainId, verifyingContract: input.proposal.safe }, types: { SafeTx: SAFE_TX_TYPES }, primaryType: "SafeTx", message: { to: args[0], value: args[1], data: args[2], operation: args[3], safeTxGas: args[4], baseGas: args[5], gasPrice: args[6], gasToken: args[7], refundReceiver: args[8], nonce: BigInt(input.action.safeNonceBefore) } });
    if (!input.action.safeTxHash || reviewedHash.toLowerCase() !== input.action.safeTxHash.toLowerCase() || args[1] !== 0n || args[3] !== 0 || args[4] !== 0n || args[5] !== 0n || args[6] !== 0n || args[7].toLowerCase() !== ZERO || args[8].toLowerCase() !== ZERO || args[9] === "0x" || keccak256(args[2]).toLowerCase() !== input.action.requestDataHash.toLowerCase()) throw new Error("repair pending reviewed Safe request mismatch");
  }
  return Object.freeze({ id: input.action.id, to: transaction.to, data: transaction.input, value: transaction.value, nonce: transaction.nonce, gas: transaction.gas, maxFeePerGas: transaction.maxFeePerGas, maxPriorityFeePerGas: transaction.maxPriorityFeePerGas });
}

export type RepairProductionAdapter = Readonly<{
  readState(phase: "pre-rotation" | "post-rotation", observerEvidenceHash: Hex): Promise<RepairCanonicalState>;
  readStateAt(phase: "pre-rotation" | "post-rotation", observerEvidenceHash: Hex, blockNumber: bigint, expectedBlockHash: Hex): Promise<RepairCanonicalState>;
  validateTerminalPrefix(journal: OrdinaryScenarioJournal): Promise<readonly { actionId: string; evidenceHash: Hex; transactionHash?: Hex }[]>;
  materializeRepairQueue(proposal: RepairGroupProposal, transient: TransientRepairGroup): Promise<Readonly<{ signedSafeCalldata: Hex; liveIntent: LiveIntent }>>;
  recoverCanonicalRepairQueue(proposal: RepairGroupProposal, transactionHash: Hex): Promise<RepairQueueTimingEvidence>;
  recoverPendingIntent(proposal: RepairGroupProposal | undefined, action: RepairActionReview, transactionHash: Hex): Promise<LiveIntent>;
  validateReceiptEffect(proposal: RepairGroupProposal, action: RepairActionReview, logs: readonly Readonly<{ address: Address; data: Hex; topics: readonly Hex[] }>[], maintenanceCalldata?: Hex): true;
  materializeTailAction(proposal: RepairGroupProposal, action: RepairActionReview, maintenanceCalldata?: Hex): Promise<Readonly<{ signedSafeCalldata?: Hex; liveIntent?: LiveIntent; rejectionCalldata?: Hex }>>;
  proveFrozenRejections(proposal: RepairGroupProposal): Promise<true>;
}>;

export type RepairMechanicalAdapterInput = Readonly<{
  domain: import("./ordinary-scenario-repair").RepairExecutionDomain;
  creation: RepairAdapterDescriptor;
  primary: Address;
  current: OrdinaryScenarioProductionHarness["current"];
  archive: OrdinaryScenarioProductionHarness["archive"];
  readStateAtBlock(phase: "pre-rotation" | "post-rotation", observerEvidenceHash: Hex, requestedBlock?: bigint, expectedBlockHash?: Hex): Promise<RepairCanonicalState>;
  loadPasskey(role: "primary" | "original-secondary" | "repair-secondary", expected: Address): Promise<VaultSigner>;
}>;

/** Chain-explicit repair mechanics shared by fixed production and validated local integration. */
export function createRepairMechanicalAdapter(input: RepairMechanicalAdapterInput): RepairProductionAdapter {
  return {
    readState: (phase, observerEvidenceHash) => input.readStateAtBlock(phase, observerEvidenceHash),
    readStateAt: (phase, observerEvidenceHash, blockNumber, expectedBlockHash) => input.readStateAtBlock(phase, observerEvidenceHash, blockNumber, expectedBlockHash),
    validateTerminalPrefix: async journal => {
      const evidence: Array<{ actionId: string; evidenceHash: Hex; transactionHash?: Hex }> = [];
      for (const record of journal.actions) {
        if (!record.evidenceHash || (record.status !== "confirmed" && record.status !== "rejection-proved")) throw new Error("repair terminal prefix evidence is incomplete");
        if (record.status === "confirmed") {
          if (!record.transactionHash || !record.receipt) throw new Error("repair confirmed prefix receipt is missing");
          const receipt = await input.archive.getTransactionReceipt({ hash: record.transactionHash });
          if (receipt.status !== "success" || receipt.blockNumber !== record.receipt.blockNumber || receipt.blockHash.toLowerCase() !== record.receipt.blockHash.toLowerCase()) throw new Error("repair terminal prefix canonical receipt changed");
        }
        evidence.push(Object.freeze({ actionId: record.id, evidenceHash: record.evidenceHash, transactionHash: record.transactionHash }));
      }
      return Object.freeze(evidence);
    },
    materializeRepairQueue: async (proposal, transient) => {
      const block = await input.current.getBlock(); if (!block.hash) throw new Error("repair materialization block is unavailable");
      const [primary, secondary] = await Promise.all([input.loadPasskey("primary", input.primary), input.loadPasskey("original-secondary", proposal.oldSecondary)]);
      const action = proposal.actions[0]!; if (!action.safeTxHash) throw new Error("repair queue Safe hash is missing");
      const signedSafeCalldata = await materializeRepairPrimaryFirstSafeCall({ chainId: input.domain.chainId, safe: proposal.safe, to: proposal.delay, data: transient.safeTransactionData, nonce: 14n, safeTxHash: action.safeTxHash, primary, secondary });
      const nonce = Number(await input.current.getTransactionCount({ address: input.creation.funder }));
      return Object.freeze({ signedSafeCalldata, liveIntent: { id: "repair-queue", to: proposal.safe, data: signedSafeCalldata, value: 0n, nonce, gas: 2_000_000n, maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1_000_000n } });
    },
    recoverCanonicalRepairQueue: async (proposal, transactionHash) => {
      const [transaction, receipt] = await Promise.all([input.current.getTransaction({ hash: transactionHash }), input.current.getTransactionReceipt({ hash: transactionHash })]);
      if (receipt.status !== "success" || transaction.to?.toLowerCase() !== proposal.safe.toLowerCase() || transaction.blockHash?.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new Error("repair queue canonical transaction mismatch");
      const decoded = (await import("viem")).decodeFunctionData({ abi: SAFE_ABI, data: transaction.input }); if (decoded.functionName !== "execTransaction") throw new Error("repair queue outer selector mismatch");
      const args = decoded.args as readonly [Address, bigint, Hex, number, bigint, bigint, bigint, Address, Address, Hex];
      const recovered = recoverCanonicalRepairCalldata(proposal, { safeTransactionData: args[2], transactionHash, canonical: true });
      validateRepairReceiptEffect(proposal, proposal.actions[0]!, receipt.logs, recovered.maintenanceCalldata);
      const block = await input.current.getBlock({ blockNumber: receipt.blockNumber }); if (!block.hash || block.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new Error("repair queue receipt block changed");
      const createdAt = block.timestamp; return Object.freeze({ transactionHash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, queueFingerprint: proposal.repairQueueTiming.queueFingerprint, createdAt, readyAt: createdAt + 120n, expiresAt: createdAt + 720n, maintenanceCalldata: recovered.maintenanceCalldata });
    },
    recoverPendingIntent: (proposal, action, transactionHash) => recoverRepairPendingIntent({ chainId: input.domain.chainId, current: input.current, creation: input.creation, proposal, action, transactionHash }),
    validateReceiptEffect: validateRepairReceiptEffect,
    materializeTailAction: async (proposal, action, maintenanceCalldata) => {
      const outerNonce = Number(await input.current.getTransactionCount({ address: input.creation.funder }));
      if (action.id === "repair-ready-execute") {
        if (!maintenanceCalldata) throw new Error("repair execution requires canonical maintenance calldata");
        const data = encodeFunctionData({ abi: DELAY_ABI, functionName: "executeNextTx", args: [proposal.repair.maintenance, 0n, maintenanceCalldata, 1] });
        if (keccak256(data).toLowerCase() !== action.requestDataHash.toLowerCase()) throw new Error("repair execution canonical calldata hash mismatch");
        return Object.freeze({ liveIntent: { id: action.id, to: proposal.delay, data, value: 0n, nonce: outerNonce, gas: 1_000_000n, maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1_000_000n } });
      }
      let to: Address; let data: Hex; let safeNonce: bigint; let signerRole: "original-secondary" | "repair-secondary";
      if (action.id === "post-rotation-old-secondary-rejection" || action.id === "post-rotation-new-secondary-queue") { to = proposal.delay; data = encodeFunctionData({ abi: DELAY_ABI, functionName: "execTransactionFromModule", args: [proposal.recipient, 1n, "0x", 0] }); safeNonce = 15n; signerRole = action.id === "post-rotation-old-secondary-rejection" ? "original-secondary" : "repair-secondary"; }
      else if (action.id === "post-rotation-proof-cancel") { to = proposal.delay; data = encodeFunctionData({ abi: DELAY_ABI, functionName: "setTxNonce", args: [8n] }); safeNonce = 16n; signerRole = "repair-secondary"; }
      else if (action.id === "final-freeze") { to = proposal.guard; data = encodeFunctionData({ abi: GUARD_ABI, functionName: "freeze" }); safeNonce = 17n; signerRole = "repair-secondary"; }
      else throw new Error("repair tail action is not materializable");
      if (!action.safeTxHash || keccak256(data).toLowerCase() !== action.requestDataHash.toLowerCase()) throw new Error("repair tail reviewed request mismatch");
      const [primary, secondary] = await Promise.all([input.loadPasskey("primary", input.primary), input.loadPasskey(signerRole, signerRole === "repair-secondary" ? proposal.candidate : proposal.oldSecondary)]);
      const signedSafeCalldata = await materializeRepairPrimaryFirstSafeCall({ chainId: input.domain.chainId, safe: proposal.safe, to, data, nonce: safeNonce, safeTxHash: action.safeTxHash, primary, secondary });
      if (action.id === "post-rotation-old-secondary-rejection") return Object.freeze({ signedSafeCalldata, rejectionCalldata: signedSafeCalldata });
      return Object.freeze({ signedSafeCalldata, liveIntent: { id: action.id, to: proposal.safe, data: signedSafeCalldata, value: 0n, nonce: outerNonce, gas: 2_000_000n, maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1_000_000n } });
    },
    proveFrozenRejections: async proposal => {
      const rejects = async (request: Readonly<{ account: Address; to: Address; data: Hex }>, selector?: string) => { try { await input.current.call(request); return false; } catch (error) { if (!selector) return true; const seen = new Set<object>(); const pending: unknown[] = [error]; for (let index = 0; index < 128 && pending.length; index++) { const value = pending.shift(); if (typeof value === "string" && value.toLowerCase().includes(selector)) return true; if (!value || typeof value !== "object" || seen.has(value)) continue; seen.add(value); pending.push(...Object.values(value)); } return false; } };
      const [primary, secondary] = await Promise.all([input.loadPasskey("primary", input.primary), input.loadPasskey("repair-secondary", proposal.candidate)]);
      const typedData = { domain: { chainId: input.domain.chainId, verifyingContract: proposal.safe }, types: { SafeTx: SAFE_TX_TYPES }, primaryType: "SafeTx" as const, message: { to: proposal.recipient, value: 1n, data: "0x" as Hex, operation: 0 as const, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO, nonce: 18n } }; const request: SafeSignerRequest = { chainId: input.domain.chainId, safe: proposal.safe, safeTxHash: hashTypedData(typedData), typedData }; const signatures = await encodeGuardSafeSignatures(request, primary, secondary); const direct = encodeFunctionData({ abi: SAFE_ABI, functionName: "execTransaction", args: [proposal.recipient, 1n, "0x", 0, 0n, 0n, 0n, ZERO, ZERO, signatures] });
      const delayed = encodeFunctionData({ abi: GUARD_CHECK_ABI, functionName: "checkModuleTransaction", args: [proposal.recipient, 1n, "0x", 0, proposal.delay] });
      if (!await rejects({ account: input.creation.funder, to: proposal.safe, data: direct }) || !await rejects({ account: proposal.safe, to: proposal.guard, data: delayed })) throw new Error("repair final freeze lacks direct/module rejection proofs"); return true;
    },
  };
}

/** Fixed-Sepolia repair mechanics. Proposal/approval/order ownership stays in the repair modules. */
export function createRepairProductionAdapter(input: Readonly<{ repository: string; harness: OrdinaryScenarioProductionHarness; reconstructed: Reconstructed; creation: RepairAdapterDescriptor; domain?: import("./ordinary-scenario-repair").RepairExecutionDomain }>): RepairProductionAdapter {
  const { harness, reconstructed, creation } = input;
  const domain = input.domain ?? PRODUCTION_REPAIR_EXECUTION_DOMAIN;
  if (domain !== PRODUCTION_REPAIR_EXECUTION_DOMAIN) throw new Error("repair production adapter requires the fixed Sepolia domain");
  const immutablePreRotationBlock = BigInt(creation.preRotationBlockNumber);
  let immutable: Awaited<ReturnType<typeof verifyReconstructedPlanAtBlock>> | undefined;
  const immutableEvidence = async () => {
    const block = await harness.archive.getBlock({ blockNumber: immutablePreRotationBlock }); if (!block.hash || block.hash.toLowerCase() !== creation.preRotationBlockHash.toLowerCase()) throw new Error("repair immutable pre-rotation block changed");
    return immutable ??= await verifyReconstructedPlanAtBlock(reconstructed, harness.archive, immutablePreRotationBlock);
  };
  const verifyCurrent = async (blockNumber: bigint, phase: "pre-rotation" | "post-rotation") => {
    const base = await immutableEvidence(); const pinned = createPinnedSafeReviewClient(harness.current as never, blockNumber);
    const client = Object.freeze({ ...pinned, getStorageAt: ({ address, slot }: { address: Address; slot: Hex }) => harness.current.getStorageAt({ address, slot, blockNumber }) });
    const policy = phase === "pre-rotation" ? reconstructed.policy : { ...reconstructed.policy, safeContractSecondary: creation.candidate, secondaries: reconstructed.policy.secondaries?.map(signer => signer.kind === "safe-contract" ? { ...signer, address: creation.candidate } : signer) };
    const runtime = await pinned.getBytecode({ address: creation.candidate });
    if (runtime && runtime !== "0x") {
      await verifyPasskeySignerComponent(pinned, { address: creation.candidate, runtimeCodeHash: keccak256(runtime), bindingHash: REPAIR_BINDING_HASH, factory: creation.factory, source: "approved fixed repair descriptor", binding: { x: BigInt(creation.x), y: BigInt(creation.y), verifiers: BigInt(creation.verifiers) } });
    } else if (phase === "post-rotation") throw new Error("repair candidate runtime is unavailable");
    const report = await verifyTopology({ chainId: sepolia.id, policy, safe: creation.safe, guard: creation.guard, delay: creation.delay, deployments: base.deployments, prerequisites: base.prerequisites, client });
    if (!report.ok) throw new Error(`repair current topology failed: ${report.failures.join(", ")}`);
    return publicHash({ immutableBlock: immutablePreRotationBlock, immutableTopology: base.topology, currentBlock: blockNumber, phase, checked: report.checked });
  };
  const readStateAtBlock = createRepairMechanicalStateReader({ chainId: sepolia.id, current: harness.current, creation, usdc: reconstructed.config.erc20, candidateBindingHash: REPAIR_BINDING_HASH, observerReadiness: harness.observerReadiness, verifyCanonicalProfile: verifyCurrent });
  return createRepairMechanicalAdapter({ domain, creation, primary: reconstructed.config.primaryPasskey, current: harness.current, archive: harness.archive, readStateAtBlock, loadPasskey: (role, expected) => harness.loadClosedPasskey(role, expected) });
}
