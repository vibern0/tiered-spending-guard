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
import { REPAIR_BINDING_HASH, recoverCanonicalRepairCalldata, type RepairActionReview, type RepairCanonicalState, type RepairCreationProposal, type RepairGroupProposal, type TransientRepairGroup } from "./ordinary-scenario-repair";
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
const FROZEN_SELECTOR = keccak256(new TextEncoder().encode("Frozen()")).slice(0, 10).toLowerCase();
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

export type RepairProductionAdapter = Readonly<{
  readState(phase: "pre-rotation" | "post-rotation", observerEvidenceHash: Hex): Promise<RepairCanonicalState>;
  materializeRepairQueue(proposal: RepairGroupProposal, transient: TransientRepairGroup): Promise<Readonly<{ signedSafeCalldata: Hex; liveIntent: LiveIntent }>>;
  recoverCanonicalRepairQueue(proposal: RepairGroupProposal, transactionHash: Hex): Promise<Readonly<{ maintenanceCalldata: Hex }>>;
  recoverPendingIntent(action: RepairActionReview, transactionHash: Hex): Promise<LiveIntent>;
  validateReceiptEffect(proposal: RepairGroupProposal, action: RepairActionReview, logs: readonly Readonly<{ address: Address; data: Hex; topics: readonly Hex[] }>[], maintenanceCalldata?: Hex): true;
  materializeTailAction(proposal: RepairGroupProposal, action: RepairActionReview, maintenanceCalldata?: Hex): Promise<Readonly<{ signedSafeCalldata?: Hex; liveIntent?: LiveIntent; rejectionCalldata?: Hex }>>;
  proveFrozenRejections(proposal: RepairGroupProposal): Promise<true>;
}>;

/** Fixed-Sepolia repair mechanics. Proposal/approval/order ownership stays in the repair modules. */
export function createRepairProductionAdapter(input: Readonly<{ repository: string; harness: OrdinaryScenarioProductionHarness; reconstructed: Reconstructed; creation: RepairCreationProposal }>): RepairProductionAdapter {
  const { harness, reconstructed, creation } = input;
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
  const readState = async (phase: "pre-rotation" | "post-rotation", observerEvidenceHash: Hex): Promise<RepairCanonicalState> => {
    const block = await harness.current.getBlock(); if (!block.hash) throw new Error("repair canonical block hash unavailable");
    const read = <T>(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) => harness.current.readContract({ address, abi, functionName, args, blockNumber: block.number }) as Promise<T>;
    const [safeNonce, queueNonce, txNonce, secondary, policyHash, frozen, spend, nativeBalance, usdcBalance, runtime, observer, topologyEvidenceHash] = await Promise.all([
      read<bigint>(creation.safe, SAFE_READ, "nonce"), read<bigint>(creation.delay, DELAY_READ, "queueNonce"), read<bigint>(creation.delay, DELAY_READ, "txNonce"), read<readonly [Address, number, boolean]>(creation.guard, GUARD_READ, "safeContractSecondary"), read<Hex>(creation.guard, GUARD_READ, "policyHash"), read<boolean>(creation.guard, GUARD_READ, "frozen"), read<readonly [bigint, bigint, bigint]>(creation.guard, GUARD_READ, "spendState", [ZERO]), harness.current.getBalance({ address: creation.safe, blockNumber: block.number }), read<bigint>(reconstructed.config.erc20, ERC20, "balanceOf", [creation.safe]), harness.current.getCode({ address: creation.candidate, blockNumber: block.number }), harness.observerReadiness(observerEvidenceHash), verifyCurrent(block.number, phase),
    ]);
    return Object.freeze({ chainId: sepolia.id, blockNumber: block.number, blockHash: block.hash, blockTimestamp: block.timestamp, safeNonce, delayQueueNonce: queueNonce, delayTxNonce: txNonce, safeContractSecondary: secondary[0], candidateRuntimeCodeHash: runtime && runtime !== "0x" ? keccak256(runtime) : `0x${"00".repeat(32)}` as Hex, candidateBindingHash: runtime && runtime !== "0x" ? REPAIR_BINDING_HASH : `0x${"00".repeat(32)}` as Hex, policyHash, frozen, nativeWindow: spend[0], nativeBaseSpent: spend[1], nativeInstantSpent: spend[2], nativeBalance, usdcBalance, topologyEvidenceHash, observerReady: observer.ready });
  };
  return {
    readState,
    materializeRepairQueue: async (proposal, transient) => {
      const block = await harness.current.getBlock(); if (!block.hash) throw new Error("repair materialization block is unavailable");
      const [primary, secondary] = await Promise.all([harness.loadClosedPasskey("primary", reconstructed.config.primaryPasskey), harness.loadClosedPasskey("original-secondary", proposal.oldSecondary)]);
      const action = proposal.actions[0]!; if (!action.safeTxHash) throw new Error("repair queue Safe hash is missing");
      const signedSafeCalldata = await materializeRepairPrimaryFirstSafeCall({ chainId: sepolia.id, safe: proposal.safe, to: proposal.delay, data: transient.safeTransactionData, nonce: 14n, safeTxHash: action.safeTxHash, primary, secondary });
      const nonce = Number(await harness.current.getTransactionCount({ address: creation.funder }));
      return Object.freeze({ signedSafeCalldata, liveIntent: { id: "repair-queue", to: proposal.safe, data: signedSafeCalldata, value: 0n, nonce, gas: 2_000_000n, maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1_000_000n } });
    },
    recoverCanonicalRepairQueue: async (proposal, transactionHash) => {
      const [transaction, receipt] = await Promise.all([harness.current.getTransaction({ hash: transactionHash }), harness.current.getTransactionReceipt({ hash: transactionHash })]);
      if (receipt.status !== "success" || transaction.to?.toLowerCase() !== proposal.safe.toLowerCase() || transaction.blockHash?.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new Error("repair queue canonical transaction mismatch");
      const decoded = (await import("viem")).decodeFunctionData({ abi: SAFE_ABI, data: transaction.input }); if (decoded.functionName !== "execTransaction") throw new Error("repair queue outer selector mismatch");
      const args = decoded.args as readonly [Address, bigint, Hex, number, bigint, bigint, bigint, Address, Address, Hex];
      const recovered = recoverCanonicalRepairCalldata(proposal, { safeTransactionData: args[2], transactionHash, canonical: true }); return Object.freeze({ maintenanceCalldata: recovered.maintenanceCalldata });
    },
    recoverPendingIntent: async (action, transactionHash) => {
      const transaction = await harness.current.getTransaction({ hash: transactionHash });
      if (!transaction.to || transaction.chainId !== sepolia.id || transaction.type !== "eip1559" || transaction.maxFeePerGas === undefined || transaction.maxPriorityFeePerGas === undefined || keccak256(transaction.input).toLowerCase() !== (action.kind === "factory-create" ? action.requestDataHash : keccak256(transaction.input)).toLowerCase()) throw new Error("repair pending outer envelope is unavailable or malformed");
      return Object.freeze({ id: action.id, to: transaction.to, data: transaction.input, value: transaction.value, nonce: transaction.nonce, gas: transaction.gas, maxFeePerGas: transaction.maxFeePerGas, maxPriorityFeePerGas: transaction.maxPriorityFeePerGas });
    },
    validateReceiptEffect: validateRepairReceiptEffect,
    materializeTailAction: async (proposal, action, maintenanceCalldata) => {
      const outerNonce = Number(await harness.current.getTransactionCount({ address: creation.funder }));
      if (action.id === "repair-ready-execute") {
        if (!maintenanceCalldata) throw new Error("repair execution requires canonical maintenance calldata");
        const data = encodeFunctionData({ abi: DELAY_ABI, functionName: "executeNextTx", args: [proposal.repair.maintenance, 0n, maintenanceCalldata, 1] });
        if (keccak256(data).toLowerCase() !== action.requestDataHash.toLowerCase()) throw new Error("repair execution canonical calldata hash mismatch");
        return Object.freeze({ liveIntent: { id: action.id, to: proposal.delay, data, value: 0n, nonce: outerNonce, gas: 300_000n, maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1_000_000n } });
      }
      let to: Address; let data: Hex; let safeNonce: bigint; let signerRole: "original-secondary" | "repair-secondary";
      if (action.id === "post-rotation-old-secondary-rejection" || action.id === "post-rotation-new-secondary-queue") { to = proposal.delay; data = encodeFunctionData({ abi: DELAY_ABI, functionName: "execTransactionFromModule", args: [proposal.recipient, 1n, "0x", 0] }); safeNonce = 15n; signerRole = action.id === "post-rotation-old-secondary-rejection" ? "original-secondary" : "repair-secondary"; }
      else if (action.id === "post-rotation-proof-cancel") { to = proposal.delay; data = encodeFunctionData({ abi: DELAY_ABI, functionName: "setTxNonce", args: [8n] }); safeNonce = 16n; signerRole = "repair-secondary"; }
      else if (action.id === "final-freeze") { to = proposal.guard; data = encodeFunctionData({ abi: GUARD_ABI, functionName: "freeze" }); safeNonce = 17n; signerRole = "repair-secondary"; }
      else throw new Error("repair tail action is not materializable");
      if (!action.safeTxHash || keccak256(data).toLowerCase() !== action.requestDataHash.toLowerCase()) throw new Error("repair tail reviewed request mismatch");
      const [primary, secondary] = await Promise.all([harness.loadClosedPasskey("primary", reconstructed.config.primaryPasskey), harness.loadClosedPasskey(signerRole, signerRole === "repair-secondary" ? proposal.candidate : proposal.oldSecondary)]);
      const signedSafeCalldata = await materializeRepairPrimaryFirstSafeCall({ chainId: sepolia.id, safe: proposal.safe, to, data, nonce: safeNonce, safeTxHash: action.safeTxHash, primary, secondary });
      if (action.id === "post-rotation-old-secondary-rejection") return Object.freeze({ signedSafeCalldata, rejectionCalldata: signedSafeCalldata });
      return Object.freeze({ signedSafeCalldata, liveIntent: { id: action.id, to: proposal.safe, data: signedSafeCalldata, value: 0n, nonce: outerNonce, gas: 2_000_000n, maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1_000_000n } });
    },
    proveFrozenRejections: async proposal => {
      const frozen = async (data: Hex) => { try { await harness.current.call({ account: proposal.safe, to: proposal.guard, data }); return false; } catch (error) { let current: unknown = error; for (let index = 0; index < 12 && current && typeof current === "object"; index++) { const value = current as { data?: unknown; cause?: unknown }; if (typeof value.data === "string" && value.data.toLowerCase().startsWith(FROZEN_SELECTOR)) return true; current = value.cause; } return false; } };
      const direct = encodeFunctionData({ abi: GUARD_CHECK_ABI, functionName: "checkTransaction", args: [proposal.recipient, 1n, "0x", 0, 0n, 0n, 0n, ZERO, ZERO, "0x", creation.funder] }); const queued = encodeFunctionData({ abi: GUARD_CHECK_ABI, functionName: "checkModuleTransaction", args: [proposal.recipient, 1n, "0x", 0, proposal.delay] });
      if (!await frozen(direct) || !await frozen(queued)) throw new Error("repair final freeze lacks exact Frozen rejection proofs"); return true;
    },
  };
}
