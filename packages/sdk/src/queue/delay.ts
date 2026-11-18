import {
  encodeAbiParameters,
  encodePacked,
  encodeFunctionData,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";

const DELAY_ABI = parseAbi([
  "function execTransactionFromModule(address,uint256,bytes,uint8)",
  "function executeNextTx(address,uint256,bytes,uint8)",
  "function setTxNonce(uint256)",
  "function getTxHash(uint256) view returns (bytes32)",
  "function getTxCreatedAt(uint256) view returns (uint256)",
]);

export type DelayQueueItem = Readonly<{
  safe: Address;
  delay: Address;
  to: Address;
  value: bigint;
  data: Hex;
  operation: 0 | 1;
  queueNonce: bigint;
}>;

export type QueueTransaction = Readonly<{ to: Address; value: bigint; data: Hex; operation: 0 | 1 }>;

export function queueFingerprint(item: DelayQueueItem): Hex {
  return keccak256(encodePacked(
    ["address", "uint256", "bytes", "uint8"],
    [item.to, item.value, item.data, item.operation],
  ));
}

/** Monitoring identity; this is deliberately distinct from Zodiac's execution hash. */
export function queueMonitoringFingerprint(item: DelayQueueItem): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }],
    [1n, item.safe, item.delay, item.queueNonce, queueFingerprint(item)],
  ));
}

export function buildQueueTransaction(item: DelayQueueItem): QueueTransaction {
  return { to: item.delay, value: 0n, operation: 0, data: encodeFunctionData({ abi: DELAY_ABI, functionName: "execTransactionFromModule", args: [item.to, item.value, item.data, item.operation] }) };
}

export function buildCancellationTransaction(delay: Address, nextQueueNonce: bigint): QueueTransaction {
  return { to: delay, value: 0n, operation: 0, data: encodeFunctionData({ abi: DELAY_ABI, functionName: "setTxNonce", args: [nextQueueNonce] }) };
}

export function buildExecutionTransaction(item: DelayQueueItem): QueueTransaction {
  return { to: item.delay, value: 0n, operation: 0, data: encodeFunctionData({ abi: DELAY_ABI, functionName: "executeNextTx", args: [item.to, item.value, item.data, item.operation] }) };
}

export function readQueueItem(delay: Address, queueNonce: bigint): QueueTransaction {
  return { to: delay, value: 0n, operation: 0, data: encodeFunctionData({ abi: DELAY_ABI, functionName: "getTxHash", args: [queueNonce] }) };
}

export function buildQueueItemReads(delay: Address, queueNonce: bigint): readonly [QueueTransaction, QueueTransaction] {
  return [
    readQueueItem(delay, queueNonce),
    { to: delay, value: 0n, operation: 0, data: encodeFunctionData({ abi: DELAY_ABI, functionName: "getTxCreatedAt", args: [queueNonce] }) },
  ];
}
