import { decodeFunctionData, encodeFunctionData, isAddress, parseAbi, toFunctionSelector, type Address, type Hex } from "viem";
import { assertValidVaultPolicy, type AssetPolicy, type AssetSpendState, type VaultPolicy } from "../config/policy";

export type Lane = "base" | "step-up" | "delayed" | "blocked";

export type ClassifiableAction = Readonly<{
  to: Address;
  value: bigint;
  data: Hex;
  operation: "call" | "delegatecall" | 0 | 1;
  signer: Address;
  secondaryApproved?: boolean;
}>;

const ZERO = "0x0000000000000000000000000000000000000000";
const TRANSFER_SELECTOR = "a9059cbb";
const DELAYED_SAFE_SELECTORS = new Set([
  "setGuard(address)",
  "setModuleGuard(address)",
  "enableModule(address)",
  "disableModule(address,address)",
  "addOwnerWithThreshold(address,uint256)",
  "removeOwner(address,address,address)",
  "swapOwner(address,address,address)",
  "changeThreshold(uint256)",
  "setFallbackHandler(address)",
  "setNonce(uint256)",
].map((signature) => toFunctionSelector(signature).slice(2)));
const DELAY_SELECTORS = new Set([
  "executeNextTx(address,uint256,bytes,uint8)",
  "skipExpired()",
  "invalidate(bytes32)",
  "setTxNonce(uint256)",
].map((signature) => toFunctionSelector(signature).slice(2)));
const SAFE_DELAYED_ABI = parseAbi([
  "function setGuard(address)",
  "function setModuleGuard(address)",
  "function enableModule(address)",
  "function disableModule(address,address)",
  "function addOwnerWithThreshold(address,uint256)",
  "function removeOwner(address,address,address)",
  "function swapOwner(address,address,address)",
  "function changeThreshold(uint256)",
  "function setFallbackHandler(address)",
  "function setNonce(uint256)",
]);
const DELAY_ABI = parseAbi([
  "function executeNextTx(address,uint256,bytes,uint8)",
  "function skipExpired()",
  "function invalidate(bytes32)",
  "function setTxNonce(uint256)",
]);

function same(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase(); }

function exactCall(abi: any, data: Hex, functionName: string, validate: (args: readonly unknown[]) => boolean = () => true): boolean {
  try {
    const decoded = decodeFunctionData({ abi, data }) as { functionName: string; args?: readonly unknown[] };
    if (decoded.functionName !== functionName) return false;
    const args = decoded.args ?? [];
    const canonical = encodeFunctionData({ abi, functionName: functionName as never, args: args as never });
    return canonical.toLowerCase() === data.toLowerCase() && validate(args);
  } catch {
    return false;
  }
}

function currentWindow(policy: VaultPolicy, now: bigint): bigint {
  if (now < policy.periodAnchor) throw new Error("timestamp precedes policy anchor");
  return policy.periodAnchor + ((now - policy.periodAnchor) / BigInt(policy.periodSeconds)) * BigInt(policy.periodSeconds);
}

function decodeTransfer(action: ClassifiableAction, asset: AssetPolicy): Readonly<{ recipient: Address; amount: bigint }> | undefined {
  const data = action.data.toLowerCase();
  if (same(asset.token, ZERO)) return data === "0x" && action.value > 0n && isAddress(action.to) && !same(action.to, ZERO) ? { recipient: action.to, amount: action.value } : undefined;
  if (!same(action.to, asset.token) || action.value !== 0n || !data.startsWith(`0x${TRANSFER_SELECTOR}`) || data.length !== 2 + 8 + 64 + 64) return undefined;
  const recipient = `0x${data.slice(10 + 24, 10 + 64)}`;
  if (!isAddress(recipient) || same(recipient, ZERO)) return undefined;
  return { recipient, amount: BigInt(`0x${data.slice(10 + 64, 10 + 128)}`) };
}

function recognizedDelayedAction(policy: VaultPolicy, action: ClassifiableAction): boolean {
  if (action.value !== 0n) return false;
  if (same(action.to, policy.delay)) {
    if (action.data.length < 10 || !DELAY_SELECTORS.has(action.data.slice(2, 10).toLowerCase())) return false;
    if (action.data.slice(2, 10).toLowerCase() === toFunctionSelector("executeNextTx(address,uint256,bytes,uint8)").slice(2)) {
      return exactCall(DELAY_ABI, action.data, "executeNextTx", (args) => isAddress(args[0] as string) && args[3] === 0);
    }
    if (action.data.slice(2, 10).toLowerCase() === toFunctionSelector("skipExpired()").slice(2)) return exactCall(DELAY_ABI, action.data, "skipExpired");
    if (action.data.slice(2, 10).toLowerCase() === toFunctionSelector("invalidate(bytes32)").slice(2)) return exactCall(DELAY_ABI, action.data, "invalidate");
    return exactCall(DELAY_ABI, action.data, "setTxNonce");
  }
  if (!same(action.to, policy.safe) || action.data.length < 10 || !DELAYED_SAFE_SELECTORS.has(action.data.slice(2, 10).toLowerCase())) return false;
  const functionName = ["setGuard", "setModuleGuard", "enableModule", "disableModule", "addOwnerWithThreshold", "removeOwner", "swapOwner", "changeThreshold", "setFallbackHandler", "setNonce"].find((name) => toFunctionSelector(`${name}(${name === "setGuard" || name === "setModuleGuard" || name === "enableModule" || name === "setFallbackHandler" ? "address" : name === "disableModule" ? "address,address" : name === "removeOwner" || name === "swapOwner" ? "address,address,address" : name === "addOwnerWithThreshold" ? "address,uint256" : "uint256"})`).slice(2) === action.data.slice(2, 10).toLowerCase());
  return functionName !== undefined && exactCall(SAFE_DELAYED_ABI, action.data, functionName);
}

export function classifyAction(policy: VaultPolicy, action: ClassifiableAction, state: AssetSpendState, now: bigint, secondaryApproved = action.secondaryApproved ?? false): Lane {
  assertValidVaultPolicy(policy);
  if ((action.operation !== "call" && action.operation !== 0) || !isAddress(action.to) || !isAddress(action.signer) || !same(action.signer, policy.passkey)) return "blocked";
  if (recognizedDelayedAction(policy, action)) return "delayed";
  const asset = policy.assets.find((candidate) => same(candidate.token, action.to) || (same(candidate.token, ZERO) && action.data === "0x"));
  if (!asset) return "blocked";
  const transfer = decodeTransfer(action, asset);
  if (transfer === undefined || transfer.amount <= 0n) return "blocked";
  const { amount, recipient } = transfer;
  const window = currentWindow(policy, now);
  if (state.window < policy.periodAnchor || state.window % BigInt(policy.periodSeconds) !== 0n || state.window > window) return "blocked";
  const baseSpent = state.window === window ? state.baseSpent : 0n;
  const instantSpent = state.window === window ? state.instantSpent : 0n;
  if (baseSpent < 0n || instantSpent < 0n || baseSpent > instantSpent || baseSpent > asset.baseDailyLimit || instantSpent > asset.instantDailyLimit) return "blocked";
  const recipientAllowlisted = asset.recipients.some((allowed) => same(allowed, recipient));
  if (!secondaryApproved && (asset.baseRecipientMode === "any-valid-address" || recipientAllowlisted) && amount <= asset.basePerTransaction && amount <= asset.baseDailyLimit - baseSpent && amount <= asset.instantDailyLimit - instantSpent) return "base";
  if (!recipientAllowlisted) return "blocked";
  if (amount > asset.instantDailyLimit) return "delayed";
  if (secondaryApproved && amount <= asset.stepUpPerTransaction && amount <= asset.instantDailyLimit - instantSpent) return "step-up";
  return "blocked";
}
