import { encodeFunctionData, type Hex } from "viem";
import { type DelayExecutionRequest, type SafeExecutionRequest } from "./types";

const SAFE_ABI = [
  {
    type: "function",
    name: "execTransaction",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "signatures", type: "bytes" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const DELAY_ABI = [
  {
    type: "function",
    name: "executeNextTx",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
    ],
    outputs: [],
  },
] as const;

export function encodeSafeExecutionCalldata(request: SafeExecutionRequest): Hex {
  const tx = request.transaction;
  return encodeFunctionData({
    abi: SAFE_ABI,
    functionName: "execTransaction",
    args: [
      tx.to,
      tx.value,
      tx.data,
      tx.operation,
      tx.safeTxGas,
      tx.baseGas,
      tx.gasPrice,
      tx.gasToken,
      tx.refundReceiver,
      request.signatures,
    ],
  });
}

export function encodeDelayExecutionCalldata(request: DelayExecutionRequest): Hex {
  return encodeFunctionData({
    abi: DELAY_ABI,
    functionName: "executeNextTx",
    args: [request.to, request.value, request.data, request.operation],
  });
}
