import { decodeEventLog, getAddress, parseAbi, type Address, type Hex } from "viem";
import { queueFingerprint } from "../queue/delay";
import type { ActivityAlert, DelayedQueuedAlert } from "./notifier";
import { MonitoringDecodeError, type MonitorLog } from "./guard-events";
export type { MonitorLog } from "./guard-events";

// Exact ABI evidenced by contracts/test/ZodiacDelayV1_1_1.sol. Unsupported lifecycle events are intentionally absent.
export const delayEventAbi=parseAbi(["event TransactionAdded(uint256 indexed queueNonce,bytes32 indexed txHash,address to,uint256 value,bytes data,uint8 operation)","event TxNonceSet(uint256 nonce)"]);
export type DelayMonitoringContext=Readonly<{chainId:number;safe:Address;delay:Address;confirmations:number;cooldownSeconds:bigint;expirationSeconds:bigint}>;
export type QueueItem=Readonly<{txHash:Hex;createdAt:bigint;to:Address;value:bigint;data:Hex;operation:number}>;
export type QueueBinding=Readonly<{readQueue:(queueNonce:bigint,blockNumber:bigint)=>Promise<QueueItem>;readNonce:(blockNumber:bigint)=>Promise<bigint>}>;
export type LifecycleReceipt=Readonly<{transactionHash:Hex;blockNumber:bigint;blockHash:Hex;status:"success"|"reverted";to:Address;input:Hex}>;
export type LifecycleCall=Readonly<{functionName:"executeNextTx"|"skipExpired"|"setTxNonce";args:readonly unknown[]}>;
export type LifecycleBinding=QueueBinding&Readonly<{readLifecycleReceipts:(fromBlock:bigint,toBlock:bigint)=>Promise<readonly LifecycleReceipt[]>;readCanonicalBlock:(blockNumber:bigint)=>Promise<Readonly<{blockNumber:bigint;blockHash:Hex;timestamp:bigint}>>;decodeLifecycleCall:(input:Hex)=>LifecycleCall}>;
export type { DelayedQueuedAlert } from "./notifier";
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
function check(log:MonitorLog,c:DelayMonitoringContext):void{if(!same(log.address,c.delay)||log.chainId!==c.chainId||log.removed)throw new MonitoringDecodeError("Delay event identity/reorg mismatch");if(!Number.isInteger(c.confirmations)||c.confirmations<1)throw new MonitoringDecodeError("invalid confirmation depth");}
export async function decodeDelayLog(log:MonitorLog,c:DelayMonitoringContext,latestBlock:bigint,observedAt:bigint,binding?:QueueBinding):Promise<ActivityAlert>{
 check(log,c);if(latestBlock-log.blockNumber+1n<BigInt(c.confirmations))throw new MonitoringDecodeError("unconfirmed Delay event");if(!binding||typeof binding.readQueue!=="function"||typeof binding.readNonce!=="function")throw new MonitoringDecodeError("verified Delay binding callback required");
 let d:{eventName:string;args:readonly unknown[]};try{d=decodeEventLog({abi:delayEventAbi,data:log.data,topics:[...log.topics] as [Hex,...Hex[]]}) as unknown as typeof d;}catch{throw new MonitoringDecodeError("malformed Delay event");}
 const v=Array.isArray(d.args)?d.args:Object.values(d.args);if(d.eventName==="TxNonceSet"){const nonce=v[0] as bigint;const current=await binding.readNonce(log.blockNumber);if(current<nonce)throw new MonitoringDecodeError("Delay nonce binding mismatch");return{kind:"delayed-cancelled",chainId:c.chainId,safe:c.safe,delay:c.delay,transactionHash:log.transactionHash,blockNumber:log.blockNumber,logIndex:log.logIndex,cancelledThrough:nonce};}
 if(d.eventName!=="TransactionAdded")throw new MonitoringDecodeError("unsupported Delay event");const [queueNonce,indexedHash,to,value,data,operation]=v as[bigint,Hex,Address,bigint,Hex,number];if(same(to,c.delay))throw new MonitoringDecodeError("Delay queue target binding mismatch");const recomputed=queueFingerprint({safe:c.safe,delay:c.delay,to:getAddress(to),value,data,operation:operation as 0|1,queueNonce});if(!same(indexedHash,recomputed))throw new MonitoringDecodeError("indexed Delay hash mismatch");
 return verifyDelayBinding({kind:"delayed-queued",chainId:c.chainId,safe:c.safe,delay:c.delay,transactionHash:log.transactionHash,blockNumber:log.blockNumber,logIndex:log.logIndex,queueNonce,queueFingerprint:recomputed,createdAt:observedAt,expiresAt:c.expirationSeconds===0n?undefined:observedAt+c.cooldownSeconds+c.expirationSeconds,to:getAddress(to),value,data,operation},binding,c);
}
export async function verifyDelayBinding(alert:ActivityAlert,binding:QueueBinding,c:DelayMonitoringContext):Promise<ActivityAlert>{if(alert.kind==="delayed-cancelled"){if(await binding.readNonce(alert.blockNumber)<alert.cancelledThrough)throw new MonitoringDecodeError("Delay nonce binding mismatch");return alert;}if(alert.kind==="step-up-executed")throw new MonitoringDecodeError("complete Delay binding required");const item=await binding.readQueue(alert.queueNonce,alert.blockNumber);const recomputed=queueFingerprint({safe:c.safe,delay:c.delay,to:item.to,value:item.value,data:item.data,operation:item.operation as 0|1,queueNonce:alert.queueNonce});if(!same(item.txHash,recomputed)||!same(item.txHash,alert.queueFingerprint)||item.createdAt!==alert.createdAt||same(item.to,c.delay)||!Number.isInteger(item.operation)||item.operation<0||item.operation>1)throw new MonitoringDecodeError("Delay queue binding mismatch");return alert;}

/** Derive lifecycle records only from canonical successful Delay calls and exact queue state transitions.
 * The pinned fixture has no execution/expiry events, so absence or ambiguity is deliberately undefined. */
export async function deriveDelayLifecycle(queued:DelayedQueuedAlert,c:DelayMonitoringContext,latestBlock:bigint,binding:LifecycleBinding):Promise<(ActivityAlert&Readonly<{kind:"delayed-executed"|"delayed-expired"}>)|undefined>{
  if (!Number.isInteger(c.confirmations)||c.confirmations<1||latestBlock < queued.blockNumber) return undefined;
  const receipts=await binding.readLifecycleReceipts(queued.blockNumber+1n,latestBlock);
  for (const receipt of receipts) {
    if (receipt.status!=="success"||!same(receipt.to,c.delay)||receipt.blockNumber<=queued.blockNumber||receipt.blockNumber>latestBlock) continue;
    if (latestBlock-receipt.blockNumber+1n<BigInt(c.confirmations)) continue;
    const block=await binding.readCanonicalBlock(receipt.blockNumber);
    if (block.blockNumber!==receipt.blockNumber||!same(block.blockHash,receipt.blockHash)) throw new MonitoringDecodeError("non-canonical Delay lifecycle receipt block");
    let call:LifecycleCall;try{call=binding.decodeLifecycleCall(receipt.input);}catch{continue;}
    const before=receipt.blockNumber===0n?0n:await binding.readNonce(receipt.blockNumber-1n);
    const after=await binding.readNonce(receipt.blockNumber);
    const item=await binding.readQueue(queued.queueNonce,receipt.blockNumber-1n);
    const exact=same(item.txHash,queued.queueFingerprint)&&item.createdAt===queued.createdAt&&(!queued.to||same(item.to,queued.to))&&(!queued.value||item.value===queued.value)&&(!queued.data||item.data.toLowerCase()===queued.data.toLowerCase())&&(queued.operation===undefined||item.operation===queued.operation)&&same(queueFingerprint({safe:c.safe,delay:c.delay,to:item.to,value:item.value,data:item.data,operation:item.operation as 0|1,queueNonce:queued.queueNonce}),queued.queueFingerprint);
    if (!exact) continue;
    if (call.functionName==="setTxNonce") { const nonce=call.args[0]; if(typeof nonce==="bigint"&&nonce>queued.queueNonce&&before<=queued.queueNonce&&after>=nonce)return undefined; continue; }
    if (call.functionName==="executeNextTx") {
      if (before!==queued.queueNonce||after!==queued.queueNonce+1n) continue;
      const [to,value,data,operation]=call.args as [Address,bigint,Hex,number];
      if (same(to,item.to)&&value===item.value&&data.toLowerCase()===item.data.toLowerCase()&&operation===item.operation) return {...queued,kind:"delayed-executed",transactionHash:receipt.transactionHash,blockNumber:receipt.blockNumber,logIndex:0};
    }
    const expiresAt=queued.expiresAt;
    if (call.functionName==="skipExpired"&&expiresAt!==undefined&&block.timestamp>expiresAt&&before<=queued.queueNonce&&after>queued.queueNonce) return {...queued,kind:"delayed-expired",expiresAt,transactionHash:receipt.transactionHash,blockNumber:receipt.blockNumber,logIndex:0};
  }
  return undefined;
}
