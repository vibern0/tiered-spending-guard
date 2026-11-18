import { decodeEventLog, getAddress, parseAbi, toEventSelector, toFunctionSelector, type Address, type Hex } from "viem";
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
const delayActivityTopics=new Set([toEventSelector("TransactionAdded(uint256,bytes32,address,uint256,bytes,uint8)"),toEventSelector("TxNonceSet(uint256)")].map(topic=>topic.toLowerCase()));
export function isDelayActivityLog(log:Pick<MonitorLog,"topics">):boolean{const topic=log.topics[0];if(!topic||!/^0x[0-9a-fA-F]{64}$/.test(topic))throw new MonitoringDecodeError("malformed Delay event topic");return delayActivityTopics.has(topic.toLowerCase());}
const lifecycleSelectorKinds=new Map<string,LifecycleCall["functionName"]>([[toFunctionSelector("executeNextTx(address,uint256,bytes,uint8)"),"executeNextTx"],[toFunctionSelector("skipExpired()"),"skipExpired"],[toFunctionSelector("setTxNonce(uint256)"),"setTxNonce"]]);
const lifecycleSelectorKind=(input:Hex):LifecycleCall["functionName"]|undefined=>input.length>=10?lifecycleSelectorKinds.get(input.slice(0,10).toLowerCase()):undefined;
const hasLifecycleSelector=(input:Hex):boolean=>lifecycleSelectorKind(input)!==undefined;
export function assertDelayLifecycleArchiveCoverage(queuedCount:number,receipts:readonly LifecycleReceipt[]):void{if(queuedCount===0&&receipts.some(receipt=>receipt.status==="success"&&(lifecycleSelectorKind(receipt.input)==="executeNextTx"||lifecycleSelectorKind(receipt.input)==="skipExpired")))throw new MonitoringDecodeError("missing archived Delay queue evidence for lifecycle call");}
function requireQueueItem(item:QueueItem,queueNonce:bigint,c:DelayMonitoringContext):void{
  let recomputed:Hex;try{if(!Number.isInteger(item.operation)||item.operation<0||item.operation>1||same(item.to,c.delay))throw new Error("invalid tuple");recomputed=queueFingerprint({safe:c.safe,delay:c.delay,to:item.to,value:item.value,data:item.data,operation:item.operation as 0|1,queueNonce});}catch{throw new MonitoringDecodeError("Delay lifecycle queue archive mismatch");}
  if(!same(item.txHash,recomputed))throw new MonitoringDecodeError("Delay lifecycle queue archive mismatch");
}
function requireTargetArchive(item:QueueItem,queued:DelayedQueuedAlert):void{
  if(!same(item.txHash,queued.queueFingerprint)||item.createdAt!==queued.createdAt||!same(item.to,queued.to)||item.value!==queued.value||item.data.toLowerCase()!==queued.data.toLowerCase()||item.operation!==queued.operation)throw new MonitoringDecodeError("Delay lifecycle target archive mismatch");
}
function exactExecuteArgs(call:LifecycleCall,item:QueueItem):boolean{
  if(call.args.length!==4||typeof call.args[0]!=="string"||typeof call.args[1]!=="bigint"||typeof call.args[2]!=="string"||typeof call.args[3]!=="number")return false;
  return same(call.args[0],item.to)&&call.args[1]===item.value&&call.args[2].toLowerCase()===item.data.toLowerCase()&&call.args[3]===item.operation;
}
function check(log:MonitorLog,c:DelayMonitoringContext):void{if(!same(log.address,c.delay)||log.chainId!==c.chainId||log.removed)throw new MonitoringDecodeError("Delay event identity/reorg mismatch");if(!Number.isInteger(c.confirmations)||c.confirmations<1)throw new MonitoringDecodeError("invalid confirmation depth");}
export async function decodeDelayLog(log:MonitorLog,c:DelayMonitoringContext,latestBlock:bigint,observedAt:bigint,binding?:QueueBinding):Promise<ActivityAlert|undefined>{
 check(log,c);if(latestBlock-log.blockNumber+1n<BigInt(c.confirmations))throw new MonitoringDecodeError("unconfirmed Delay event");if(!isDelayActivityLog(log))return undefined;if(!binding||typeof binding.readQueue!=="function"||typeof binding.readNonce!=="function")throw new MonitoringDecodeError("verified Delay binding callback required");
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
  const exactSelectorBlocks=new Map<bigint,number>();
  for(const receipt of receipts)if(receipt.status==="success"&&same(receipt.to,c.delay)&&receipt.blockNumber>queued.blockNumber&&receipt.blockNumber<=latestBlock&&latestBlock-receipt.blockNumber+1n>=BigInt(c.confirmations)&&hasLifecycleSelector(receipt.input))exactSelectorBlocks.set(receipt.blockNumber,(exactSelectorBlocks.get(receipt.blockNumber)??0)+1);
  if([...exactSelectorBlocks.values()].some(count=>count>1))throw new MonitoringDecodeError("ambiguous same-block Delay lifecycle calls");
  const lifecycleBlocks=new Set<bigint>();
  for (const receipt of receipts) {
    if (receipt.status!=="success"||!same(receipt.to,c.delay)||receipt.blockNumber<=queued.blockNumber||receipt.blockNumber>latestBlock) continue;
    if (latestBlock-receipt.blockNumber+1n<BigInt(c.confirmations)) continue;
    const block=await binding.readCanonicalBlock(receipt.blockNumber);
    if (block.blockNumber!==receipt.blockNumber||!same(block.blockHash,receipt.blockHash)) throw new MonitoringDecodeError("non-canonical Delay lifecycle receipt block");
    let call:LifecycleCall;try{call=binding.decodeLifecycleCall(receipt.input);}catch{if(hasLifecycleSelector(receipt.input))throw new MonitoringDecodeError("malformed expected Delay lifecycle call");continue;}
    if(!["executeNextTx","skipExpired","setTxNonce"].includes(call.functionName))throw new MonitoringDecodeError("unsupported decoded Delay lifecycle call");
    if(lifecycleBlocks.has(receipt.blockNumber))throw new MonitoringDecodeError("ambiguous same-block Delay lifecycle calls");
    lifecycleBlocks.add(receipt.blockNumber);
    const before=receipt.blockNumber===0n?0n:await binding.readNonce(receipt.blockNumber-1n);
    const after=await binding.readNonce(receipt.blockNumber);
    if (call.functionName==="setTxNonce") {
      const nonce=call.args.length===1?call.args[0]:undefined;
      if(typeof nonce!=="bigint"||nonce<=before||after!==nonce)throw new MonitoringDecodeError("Delay lifecycle nonce transition mismatch");
      if(before<=queued.queueNonce&&nonce>queued.queueNonce)return undefined;
      continue;
    }
    const item=await binding.readQueue(before,receipt.blockNumber-1n);
    requireQueueItem(item,before,c);
    if(before===queued.queueNonce)requireTargetArchive(item,queued);
    if (call.functionName==="executeNextTx") {
      if(after!==before+1n)throw new MonitoringDecodeError("Delay lifecycle nonce transition mismatch");
      if(!exactExecuteArgs(call,item))throw new MonitoringDecodeError("Delay lifecycle execution tuple mismatch");
      if(before===queued.queueNonce)return {...queued,kind:"delayed-executed",transactionHash:receipt.transactionHash,blockNumber:receipt.blockNumber,logIndex:0};
      continue;
    }
    if(call.args.length!==0||c.expirationSeconds===0n)throw new MonitoringDecodeError("Delay lifecycle expiry call mismatch");
    const expiresAt=item.createdAt+c.cooldownSeconds+c.expirationSeconds;
    if(block.timestamp<=expiresAt||after!==before+1n)throw new MonitoringDecodeError("Delay lifecycle expiry transition mismatch");
    if(before===queued.queueNonce){if(queued.expiresAt===undefined||queued.expiresAt!==expiresAt)throw new MonitoringDecodeError("Delay lifecycle target archive mismatch");return {...queued,kind:"delayed-expired",expiresAt,transactionHash:receipt.transactionHash,blockNumber:receipt.blockNumber,logIndex:0};}
  }
  return undefined;
}
