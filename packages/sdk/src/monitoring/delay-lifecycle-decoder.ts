import { decodeFunctionData, encodeFunctionData, parseAbi, type Hex } from "viem";
import type { LifecycleCall } from "./delay-events";

export const delayLifecycleAbi = parseAbi([
  "function executeNextTx(address,uint256,bytes,uint8)",
  "function skipExpired()",
  "function setTxNonce(uint256)",
]);

export function decodeDelayLifecycleCall(input: Hex): LifecycleCall {
  const decoded = decodeFunctionData({ abi: delayLifecycleAbi, data: input });
  const args = decoded.args ?? [];
  const canonical = encodeFunctionData({ abi: delayLifecycleAbi, functionName: decoded.functionName, args } as never);
  if (canonical.toLowerCase() !== input.toLowerCase()) throw new Error("non-canonical Delay lifecycle calldata");
  return {
    functionName: decoded.functionName as LifecycleCall["functionName"],
    args,
  };
}
