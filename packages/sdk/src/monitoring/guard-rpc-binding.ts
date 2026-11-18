import { decodeEventLog, decodeFunctionData, encodeEventTopics, getAddress, parseAbi, type Address, type Hex } from "viem";
import type { GuardBinding, MonitoringIdentity, SafeTransaction } from "./guard-events";

const safeAbi = parseAbi([
  "function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)",
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns (bytes32)",
]);
const guardAbi = parseAbi(["function spendState(address) view returns (uint256,uint256,uint256)"]);
const executionAbi = parseAbi(["event ExecutionSuccess(bytes32 indexed txHash,uint256 payment)", "event ExecutionFailure(bytes32 indexed txHash,uint256 payment)"]);
const executionTopics=new Set(executionAbi.map(item=>encodeEventTopics({abi:[item]})[0].toLowerCase()));

type RpcTransaction = Readonly<{ hash:Hex; to:Address|null; input:Hex; blockNumber:bigint|null; blockHash:Hex|null; transactionIndex:number|null }>;
type RpcLog = Readonly<{ address:Address; topics:readonly Hex[]; data:Hex; blockNumber?:bigint|null; blockHash?:Hex|null; transactionHash?:Hex|null }>;
type RpcReceipt = Readonly<{ transactionHash:Hex; blockNumber:bigint; blockHash:Hex; transactionIndex:number; status:"success"|"reverted"; logs:readonly RpcLog[] }>;
type RpcBlock = Readonly<{ number:bigint|null; hash:Hex|null; parentHash:Hex; transactions:readonly (Hex|RpcTransaction)[] }>;
export type RpcGuardClient = Readonly<{
  getTransaction(input:{hash:Hex}):Promise<RpcTransaction>;
  getTransactionReceipt(input:{hash:Hex}):Promise<RpcReceipt>;
  getBlock(input:{blockNumber:bigint;includeTransactions?:boolean}):Promise<RpcBlock>;
  readContract(input:{address:Address;abi:readonly unknown[];functionName:string;args?:readonly unknown[];blockNumber?:bigint}):Promise<unknown>;
}>;
export type GuardRpcClient = RpcGuardClient;

const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const fail=(message:string):never=>{throw new Error(message);};
type ExecutionEvent=Readonly<{kind:"success"|"failure";txHash:Hex}>;
function executionEvents(receipt:RpcReceipt,safe:Address):ExecutionEvent[]{const events:ExecutionEvent[]=[];for(const log of receipt.logs){if(!same(log.address,safe))continue;let decoded:ReturnType<typeof decodeEventLog>;try{decoded=decodeEventLog({abi:executionAbi,data:log.data,topics:[...log.topics] as [Hex,...Hex[]],strict:true});}catch{if(log.topics[0]&&executionTopics.has(log.topics[0].toLowerCase()))fail("malformed configured Safe execution event");continue;}if(log.blockNumber!=null&&log.blockNumber!==receipt.blockNumber)fail("execution event block number mismatch");if(log.blockHash!=null&&!same(log.blockHash,receipt.blockHash))fail("execution event block hash mismatch");if(log.transactionHash!=null&&!same(log.transactionHash,receipt.transactionHash))fail("execution event transaction mismatch");const values=Array.isArray(decoded.args)?decoded.args:Object.values(decoded.args as object);events.push({kind:decoded.eventName==="ExecutionSuccess"?"success":"failure",txHash:values[0] as Hex});}return events;}
const hashOf=(value:Hex|RpcTransaction):Hex=>typeof value==="string"?value:value.hash;

export function createRpcGuardBinding(client:RpcGuardClient,identity:MonitoringIdentity):GuardBinding{
  async function readSafeTransaction(hash:Hex,eventBlockNumber:bigint,eventBlockHash?:Hex):Promise<SafeTransaction>{
    if(eventBlockNumber<=0n)fail("historical parent block unavailable");
    const [transaction,receipt,block,parent]=await Promise.all([client.getTransaction({hash}),client.getTransactionReceipt({hash}),client.getBlock({blockNumber:eventBlockNumber,includeTransactions:true}),client.getBlock({blockNumber:eventBlockNumber-1n})]);
    if(!same(transaction.hash,hash)||!same(receipt.transactionHash,hash))fail("outer transaction hash mismatch");
    if(receipt.status!=="success")fail("outer transaction reverted");
    if(!eventBlockHash||!same(receipt.blockHash,eventBlockHash))fail("guard event block hash mismatch");
    if(transaction.blockNumber!==eventBlockNumber||receipt.blockNumber!==eventBlockNumber||block.number!==eventBlockNumber)fail("target block number mismatch");
    if(!block.hash||!same(transaction.blockHash??"",block.hash)||!same(receipt.blockHash,block.hash))throw new Error("canonical target block hash mismatch");
    const canonicalBlockHash=block.hash;
    if(!parent.hash||parent.number!==eventBlockNumber-1n||!same(block.parentHash,parent.hash))throw new Error("canonical parent block identity mismatch");
    const canonicalParentHash=parent.hash;
    if(!transaction.to||!same(transaction.to,identity.safe))fail("outer transaction recipient is not configured Safe");
    const position=transaction.transactionIndex;if(!Number.isSafeInteger(position)||position!<0||position!==receipt.transactionIndex)fail("outer transaction position mismatch");
    if(position!>=block.transactions.length||!same(hashOf(block.transactions[position!]),hash))fail("target missing from canonical full block position");
    let decoded:ReturnType<typeof decodeFunctionData>;try{decoded=decodeFunctionData({abi:safeAbi,data:transaction.input});}catch{return fail("outer calldata is not canonical Safe execTransaction");}
    if(decoded.functionName!=="execTransaction")fail("outer selector is not Safe execTransaction");
    const args=decoded.args as readonly [Address,bigint,Hex,number,bigint,bigint,bigint,Address,Address,Hex];
    const target=executionEvents(receipt,identity.safe);const successes=target.filter(event=>event.kind==="success");const failures=target.filter(event=>event.kind==="failure");
    if(successes.length!==1)fail("target receipt must contain exactly one configured Safe ExecutionSuccess");if(failures.length)fail("target receipt contains configured Safe ExecutionFailure");
    const historical=await client.readContract({address:identity.safe,abi:safeAbi,functionName:"nonce",blockNumber:eventBlockNumber-1n});if(typeof historical!=="bigint"||historical<0n)throw new Error("historical pre-block nonce unavailable");let nonce:bigint=historical;
    for(let index=0;index<position!;index++){const earlierHash=hashOf(block.transactions[index]);const earlier=await client.getTransactionReceipt({hash:earlierHash});if(!same(earlier.transactionHash,earlierHash)||earlier.blockNumber!==eventBlockNumber||!same(earlier.blockHash,canonicalBlockHash)||earlier.transactionIndex!==index)fail("earlier receipt is not canonical at block position");const events=executionEvents(earlier,identity.safe);if(earlier.status==="reverted"){if(events.length)fail("reverted outer receipt contains persisted Safe execution event");continue;}if(events.length>1)fail("ambiguous nested configured Safe execution in earlier receipt");if(events.length===1)nonce+=1n;}
    const computed=await client.readContract({address:identity.safe,abi:safeAbi,functionName:"getTransactionHash",args:[args[0],args[1],args[2],args[3],args[4],args[5],args[6],args[7],args[8],nonce],blockNumber:eventBlockNumber});if(typeof computed!=="string"||!same(computed,successes[0].txHash))fail("recomputed Safe transaction hash mismatch");
    const [parentAgain,blockAgain]=await Promise.all([client.getBlock({blockNumber:eventBlockNumber-1n}),client.getBlock({blockNumber:eventBlockNumber})]);if(!same(parentAgain.hash??"",canonicalParentHash)||!same(blockAgain.hash??"",canonicalBlockHash)||!same(blockAgain.parentHash,canonicalParentHash))fail("canonical block changed during verification");
    return{safe:getAddress(identity.safe),to:getAddress(args[0]),value:args[1],data:args[2],operation:Number(args[3]),nonce};
  }
  return{readSafeTransaction,readSpendState:async(token,blockNumber)=>{const raw=await client.readContract({address:identity.guard,abi:guardAbi,functionName:"spendState",args:[token],blockNumber});if(!Array.isArray(raw)||raw.length!==3||raw.some(value=>typeof value!=="bigint"||value<0n))throw new Error("malformed historical spendState tuple");const state=raw as [bigint,bigint,bigint];return{window:state[0],baseSpent:state[1],instantSpent:state[2]};}};
}
