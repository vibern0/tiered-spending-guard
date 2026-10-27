import { lookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { BlockList, isIP } from "node:net";
import { createHash } from "node:crypto";
import { isAddress, type Address, type Hex } from "viem";
export type ActivityKind="step-up-executed"|"delayed-queued"|"delayed-cancelled"|"delayed-executed"|"delayed-expired";
type CommonAlert=Readonly<{chainId:number;safe:Address;transactionHash:Hex;blockNumber:bigint;logIndex:number}>;
type StepUpAlert=CommonAlert&Readonly<{kind:"step-up-executed";guard:Address;token:Address;recipient:Address;amount:bigint;baseSpent:bigint;instantSpent:bigint;window:bigint}>;
type DelayedQueueFields=Readonly<{delay:Address;queueNonce:bigint;queueFingerprint:Hex;createdAt:bigint;expiresAt?:bigint;to:Address;value:bigint;data:Hex;operation:number}>;
export type DelayedQueuedAlert=CommonAlert&DelayedQueueFields&Readonly<{kind:"delayed-queued"}>;
type DelayedCancelledAlert=CommonAlert&Readonly<{kind:"delayed-cancelled";delay:Address;cancelledThrough:bigint}>;
type DelayedExecutedAlert=CommonAlert&DelayedQueueFields&Readonly<{kind:"delayed-executed"}>;
type DelayedExpiredAlert=CommonAlert&DelayedQueueFields&Readonly<{kind:"delayed-expired";expiresAt:bigint}>;
export type ActivityAlert=StepUpAlert|DelayedQueuedAlert|DelayedCancelledAlert|DelayedExecutedAlert|DelayedExpiredAlert;
export type WebhookDeliveryEvidence=Readonly<{channel:"webhook";httpStatus:number;payloadHash:Hex;deliveredAt:string}>;
export interface Notifier{notify(alert:ActivityAlert):Promise<void|WebhookDeliveryEvidence>}
export interface ReadyNotifier extends Notifier{ready():Promise<void>}
const fields:Record<ActivityKind,readonly string[]>={"step-up-executed":["kind","chainId","safe","transactionHash","blockNumber","logIndex","guard","token","recipient","amount","baseSpent","instantSpent","window"],"delayed-queued":["kind","chainId","safe","transactionHash","blockNumber","logIndex","delay","queueNonce","queueFingerprint","createdAt","expiresAt","to","value","data","operation"],"delayed-cancelled":["kind","chainId","safe","transactionHash","blockNumber","logIndex","delay","cancelledThrough"],"delayed-executed":["kind","chainId","safe","transactionHash","blockNumber","logIndex","delay","queueNonce","queueFingerprint","createdAt","expiresAt","to","value","data","operation"],"delayed-expired":["kind","chainId","safe","transactionHash","blockNumber","logIndex","delay","queueNonce","queueFingerprint","createdAt","expiresAt","to","value","data","operation"]};
const required:Record<ActivityKind,readonly string[]>={"step-up-executed":["chainId","safe","transactionHash","blockNumber","logIndex","guard","token","recipient","amount","baseSpent","instantSpent","window"],"delayed-queued":["chainId","safe","transactionHash","blockNumber","logIndex","delay","queueNonce","queueFingerprint","createdAt","to","value","data","operation"],"delayed-cancelled":["chainId","safe","transactionHash","blockNumber","logIndex","delay","cancelledThrough"],"delayed-executed":["chainId","safe","transactionHash","blockNumber","logIndex","delay","queueNonce","queueFingerprint","createdAt","to","value","data","operation"],"delayed-expired":["chainId","safe","transactionHash","blockNumber","logIndex","delay","queueNonce","queueFingerprint","createdAt","expiresAt","to","value","data","operation"]};
const addressFields=new Set(["safe","guard","delay","token","recipient","to"]);const hexFields=new Set(["transactionHash","queueFingerprint","data"]);const bigintFields=new Set(["blockNumber","amount","baseSpent","instantSpent","window","queueNonce","createdAt","expiresAt","value","cancelledThrough"]);const integerFields=new Set(["chainId","logIndex","operation"]);
const validInteger=(value:unknown,key:string):boolean=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=0&&(key!=="operation"||value<=1);
export function publicAlert(alert:ActivityAlert):Record<string,unknown>{if(!alert||typeof alert!=="object")throw new Error("malformed alert");const allowed=fields[alert.kind];if(!allowed)throw new Error("unknown alert kind");for(const key of Object.keys(alert as object))if(!allowed.includes(key))throw new Error(`unknown or sensitive alert field: ${key}`);for(const key of required[alert.kind])if(!(key in alert)||alert[key as keyof ActivityAlert]===undefined)throw new Error(`required alert field missing: ${key}`);for(const key of allowed){if(!(key in alert)||alert[key as keyof ActivityAlert]===undefined)continue;const value=(alert as Record<string,unknown>)[key];if(addressFields.has(key)&&(typeof value!=="string"||!isAddress(value)))throw new Error(`invalid alert field type: ${key}`);if(hexFields.has(key)&&(typeof value!=="string"||!/^0x[0-9a-fA-F]*$/.test(value)||value.length%2!==0))throw new Error(`invalid alert field type: ${key}`);if(bigintFields.has(key)&&(typeof value!=="bigint"||value<0n))throw new Error(`invalid alert field type: ${key}`);if(integerFields.has(key)&&!validInteger(value,key))throw new Error(`invalid alert field type: ${key}`);}const out:Record<string,unknown>={};for(const key of allowed)if(key in alert)out[key]=(alert as Record<string,unknown>)[key];return out;}
export const serializePublicAlert=(a:ActivityAlert):string=>JSON.stringify(publicAlert(a),(_,v)=>typeof v==="bigint"?v.toString():v);
export const publicAlertPayloadHash=(a:ActivityAlert):Hex=>`0x${createHash("sha256").update(serializePublicAlert(a)).digest("hex")}` as Hex;
export function hydrateActivityAlert(value:unknown):ActivityAlert{if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("malformed persisted alert");const hydrated={...(value as Record<string,unknown>)};for(const key of bigintFields){if(!(key in hydrated)||hydrated[key]===undefined)continue;const raw=hydrated[key];if(typeof raw!=="string"||!/^\d+$/.test(raw))throw new Error(`invalid persisted alert bigint: ${key}`);hydrated[key]=BigInt(raw);}publicAlert(hydrated as ActivityAlert);return hydrated as ActivityAlert;}
export function createStdoutNotifier(write:(line:string)=>void=console.log):Notifier{return{notify:async a=>{write(serializePublicAlert(a));}};}
type WebhookRequest=(url:URL,init?:{method?:string;headers?:Record<string,string>;body?:string;redirect?:"error"})=>Promise<{ok:boolean;status:number}>;
export type WebhookFetch=WebhookRequest&Readonly<{ready:(url:URL)=>Promise<void>}>;
const blockedIpv4=new BlockList();
for(const [address,prefix] of [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.88.99.0",24],["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]] as const)blockedIpv4.addSubnet(address,prefix,"ipv4");
const blockedIpv6=new BlockList();
for(const [address,prefix] of [["::",128],["::1",128],["::ffff:0:0",96],["64:ff9b::",96],["64:ff9b:1::",48],["100::",64],["2001::",23],["2001:db8::",32],["2002::",16],["fc00::",7],["fe80::",10],["ff00::",8]] as const)blockedIpv6.addSubnet(address,prefix,"ipv6");
function privateIpv4(hostname:string):boolean{return isIP(hostname)===4&&blockedIpv4.check(hostname,"ipv4");}
function privateHost(hostname:string):boolean{
  const host=hostname.toLowerCase().replace(/^\[|\]$/g,"");
  return host==="localhost"||host.endsWith(".localhost")||host.endsWith(".local")||host.endsWith(".internal")||privateIpv4(host)||isIP(host)===6&&blockedIpv6.check(host,"ipv6");
}
function webhookEndpoint(value:string):URL{let endpoint:URL;try{endpoint=new URL(value);}catch{throw new Error("webhook URL must be valid HTTPS");}if(endpoint.protocol!=="https:"||endpoint.username||endpoint.password||privateHost(endpoint.hostname))throw new Error("webhook URL must be HTTPS, public, and without credentials");return endpoint;}
type ResolvedAddress=Readonly<{address:string;family:number}>;
type WebhookResponse=Readonly<{ok:boolean;status:number}>;
type WebhookResolver=(hostname:string)=>Promise<readonly ResolvedAddress[]>;
type WebhookSender=(url:URL,options:Readonly<{lookupAddress:string;family:number;servername:string;method:string;headers:Record<string,string>;body:string}>)=>Promise<WebhookResponse>;
const resolveWebhookHost:WebhookResolver=hostname=>lookup(hostname,{all:true,verbatim:true});
const sendWebhookRequest:WebhookSender=(url,options)=>new Promise((resolve,reject)=>{
  const requestOptions:RequestOptions={protocol:"https:",hostname:url.hostname,port:url.port||443,path:`${url.pathname}${url.search}`,method:options.method,headers:options.headers,servername:options.servername,lookup:(_hostname,_lookupOptions,callback)=>callback(null,options.lookupAddress,options.family)};
  const request=httpsRequest(requestOptions,response=>{response.resume();const status=response.statusCode??0;resolve({ok:status>=200&&status<300,status});});
  request.setTimeout(10_000,()=>request.destroy(new Error("webhook request timed out")));
  request.once("error",reject);
  request.end(options.body);
});
async function resolvePublicAddresses(target:URL,resolve:WebhookResolver):Promise<readonly ResolvedAddress[]>{const addresses=await resolve(target.hostname);if(addresses.length===0||addresses.some(({address,family})=>!((family===4||family===6)&&isIP(address)===family)||privateHost(address)))throw new Error("webhook URL must resolve only to public addresses");return addresses;}
export function createPinnedWebhookFetch(resolve:WebhookResolver=resolveWebhookHost,send:WebhookSender=sendWebhookRequest):WebhookFetch{
  const request:WebhookRequest=async(target,init)=>{const [{address,family}]=await resolvePublicAddresses(target,resolve);return send(target,{lookupAddress:address,family,servername:target.hostname,method:init?.method??"GET",headers:init?.headers??{},body:init?.body??""});};
  return Object.assign(request,{ready:async(target:URL)=>{await resolvePublicAddresses(target,resolve);}});
}
const defaultWebhookFetch=createPinnedWebhookFetch();
export function createWebhookNotifier(url:string,fetcher:WebhookRequest&Partial<Pick<WebhookFetch,"ready">>=defaultWebhookFetch):ReadyNotifier{const endpoint=webhookEndpoint(url);return{ready:async()=>{if(!fetcher.ready)throw new Error("webhook DNS readiness unavailable");await fetcher.ready(endpoint);},notify:async a=>{const body=serializePublicAlert(a);let r:{ok:boolean;status:number};try{r=await fetcher(endpoint,{method:"POST",headers:{"content-type":"application/json"},body,redirect:"error"});}catch{throw new Error("notification webhook request failed");}if(!r.ok)throw new Error(`notification webhook returned HTTP ${r.status}`);return{channel:"webhook",httpStatus:r.status,payloadHash:`0x${createHash("sha256").update(body).digest("hex")}` as Hex,deliveredAt:new Date().toISOString()};}};}
