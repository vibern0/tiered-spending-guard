import { hashTypedData, keccak256, stringToHex, type Address, type Hex } from "viem";
import {
  isVerifiedDeploymentInfrastructure,
  type VerifiedDeploymentInfrastructure,
} from "../config/deployments";
import { type AssetSpendState } from "../config/policy";
import { queueFingerprint } from "../queue/delay";
import { type QueueItem } from "../monitoring/delay-events";
import { SAFE_TX_TYPES } from "../signers/types";
import { type TopologyReport } from "../topology/verify";
import {
  canonicalSubmissionJson,
  snapshotSubmissionRequest,
  submissionRequestHash,
} from "./validate";
import {
  type DelayExecutionRequest,
  type SafeExecutionRequest,
  type SubmissionRequest,
  type SubmissionResult,
} from "./types";
export { encodeDelayExecutionCalldata, encodeSafeExecutionCalldata } from "./calldata";
import { encodeDelayExecutionCalldata, encodeSafeExecutionCalldata } from "./calldata";

export type CanonicalReceipt = Readonly<{
  transactionHash: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  status: "success" | "reverted";
}>;

export type RelayerContext = Readonly<{
  readers: Readonly<{
    chainId(): Promise<number>;
    deployments(): Promise<VerifiedDeploymentInfrastructure>;
    topology(safe: Address): Promise<TopologyReport>;
    safeNonce(safe: Address): Promise<bigint>;
    policyHash(guard: Address): Promise<Hex>;
    spendState(guard: Address, asset: Address): Promise<AssetSpendState>;
    delayItem(delay: Address, nonce: bigint): Promise<QueueItem>;
    delayNonce(delay: Address): Promise<bigint>;
    blockTimestamp(): Promise<bigint>;
    receipt(hash: Hex): Promise<CanonicalReceipt | undefined>;
  }>;
  broadcaster: Readonly<{
    executeSafe(target: Address, exactCalldata: Hex): Promise<Hex>;
    executeDelay(target: Address, exactCalldata: Hex): Promise<Hex>;
  }>;
}>;

function canonicalHash(value: unknown): Hex {
  return keccak256(stringToHex(canonicalSubmissionJson(value)));
}

export function deploymentInfrastructureHash(value: VerifiedDeploymentInfrastructure): Hex {
  return canonicalHash({
    chainId: value.chainId,
    deployer: value.deployer,
    observedDeployerNonce: value.observedDeployerNonce,
    safeSingleton: dependencyFingerprint(value.safeSingleton),
    safeProxyFactory: dependencyFingerprint(value.safeProxyFactory),
    passkeySignerFactory: dependencyFingerprint(value.passkeySignerFactory),
    passkeySignerVerifier: dependencyFingerprint(value.passkeySignerVerifier),
    multiSendCallOnly: dependencyFingerprint(value.multiSendCallOnly),
    passkeySigner: {
      name: value.passkeySigner.name,
      address: value.passkeySigner.address,
      runtimeCodeHash: value.passkeySigner.runtimeCodeHash,
      bindingHash: value.passkeySigner.bindingHash,
      source: value.passkeySigner.source,
    },
  });
}

function dependencyFingerprint(value: VerifiedDeploymentInfrastructure["safeSingleton"]): Readonly<Record<string, unknown>> {
  return {
    name: value.name,
    version: value.version,
    address: value.address,
    runtimeCodeHash: value.runtimeCodeHash,
    evidence: value.evidence,
    source: value.source,
  };
}

function result(requestHash: Hex, kind: "reverted" | "stale" | "unsupported-chain" | "rpc-inconsistent" | "transport-unavailable", reason: string): SubmissionResult {
  return Object.freeze({ kind, requestHash, reason });
}

function sameHex(left: Hex, right: Hex): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sameSpend(left: AssetSpendState, right: AssetSpendState): boolean {
  return left.window === right.window && left.baseSpent === right.baseSpent && left.instantSpent === right.instantSpent;
}

function requestHashFor(input: unknown): Hex {
  try {
    return submissionRequestHash(snapshotSubmissionRequest(input));
  } catch {
    return canonicalHash(input);
  }
}

async function validateCommon(request: SubmissionRequest, context: RelayerContext, requestHash: Hex): Promise<SubmissionResult | undefined> {
  const chainId = await context.readers.chainId();
  if (chainId !== request.chainId) return result(requestHash, "unsupported-chain", "wrong chain");

  const deployments = await context.readers.deployments();
  if (!isVerifiedDeploymentInfrastructure(deployments)) return result(requestHash, "rpc-inconsistent", "unverified deployment aggregate");
  if (!sameHex(deploymentInfrastructureHash(deployments), request.deploymentsHash)) return result(requestHash, "stale", "deployment aggregate drift");

  const topology = await context.readers.topology(request.safe);
  if (!topology.ok) return result(requestHash, "stale", `topology failure: ${topology.failures.join(", ")}`);

  const onchainPolicyHash = await context.readers.policyHash(request.guard);
  if (!sameHex(onchainPolicyHash, request.policyHash)) return result(requestHash, "stale", "policy hash drift");

  return undefined;
}

async function validateSafe(request: SafeExecutionRequest, context: RelayerContext, requestHash: Hex): Promise<SubmissionResult | undefined> {
  const nonce = await context.readers.safeNonce(request.safe);
  if (nonce !== request.transaction.nonce) return result(requestHash, "stale", "Safe nonce drift");

  const computedSafeTxHash = hashTypedData({
    domain: { chainId: request.chainId, verifyingContract: request.safe },
    types: { SafeTx: SAFE_TX_TYPES },
    primaryType: "SafeTx",
    message: request.transaction,
  });
  if (!sameHex(computedSafeTxHash, request.safeTxHash)) return result(requestHash, "stale", "Safe transaction hash drift");

  const state = await context.readers.spendState(request.guard, request.asset);
  if (!sameSpend(state, request.expectedSpend)) {
    return result(requestHash, "stale", `spend counter drift: expected ${state.window}/${state.baseSpent}/${state.instantSpent}, request ${request.expectedSpend.window}/${request.expectedSpend.baseSpent}/${request.expectedSpend.instantSpent}`);
  }
  return undefined;
}

async function validateDelay(request: DelayExecutionRequest, context: RelayerContext, requestHash: Hex): Promise<SubmissionResult | undefined> {
  const liveNonce = await context.readers.delayNonce(request.delay);
  if (liveNonce !== request.queueNonce) return result(requestHash, "stale", "Delay queue nonce is not executable head");

  const item = await context.readers.delayItem(request.delay, request.queueNonce);
  if (
    item.createdAt === 0n ||
    !sameHex(item.txHash, request.queueFingerprint) ||
    !sameAddress(item.to, request.to) ||
    item.value !== request.value ||
    !sameHex(item.data, request.data) ||
    item.operation !== request.operation ||
    !sameHex(queueFingerprint(request), request.queueFingerprint) ||
    item.createdAt !== request.createdAt
  ) return result(requestHash, "stale", "Delay queue drift");
  const now = await context.readers.blockTimestamp();
  const readyAt = request.createdAt + request.cooldownSeconds;
  if (now < readyAt) return result(requestHash, "stale", "Delay cooldown not elapsed");
  if (request.expirationSeconds > 0n && now > readyAt + request.expirationSeconds) {
    return result(requestHash, "stale", "Delay queue item expired");
  }
  return undefined;
}

async function validateSafeNow(request: SafeExecutionRequest, context: RelayerContext, requestHash: Hex): Promise<SubmissionResult | undefined> {
  return await validateCommon(request, context, requestHash) ?? await validateSafe(request, context, requestHash);
}

async function validateDelayNow(request: DelayExecutionRequest, context: RelayerContext, requestHash: Hex): Promise<SubmissionResult | undefined> {
  return await validateCommon(request, context, requestHash) ?? await validateDelay(request, context, requestHash);
}

function knownHash(error: unknown): Hex | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  for (const key of ["transactionHash", "hash"]) {
    const value = record[key];
    if (typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)) return value as Hex;
  }
  return knownHash(record.cause);
}

async function reconcile(hash: Hex, requestHash: Hex, context: RelayerContext): Promise<SubmissionResult> {
  const receipt = await context.readers.receipt(hash);
  if (!receipt) return Object.freeze({ kind: "submitted", requestHash, transactionHash: hash });
  if (receipt.status === "reverted") return result(requestHash, "reverted", `transaction reverted: ${hash}`);
  return Object.freeze({
    kind: "confirmed",
    requestHash,
    transactionHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
  });
}

export async function validateAndBroadcast(input: SubmissionRequest, context: RelayerContext): Promise<SubmissionResult> {
  const requestHash = requestHashFor(input);
  let request: SubmissionRequest;
  try {
    request = snapshotSubmissionRequest(input);
  } catch (error) {
    return result(requestHash, "stale", error instanceof Error ? error.message : "invalid submission request");
  }

  try {
    const common = await validateCommon(request, context, requestHash);
    if (common) return common;

    if (request.kind === "safe-execution") {
      const stale = await validateSafe(request, context, requestHash);
      if (stale) return stale;
      const calldata = encodeSafeExecutionCalldata(request);
      const recheck = await validateSafeNow(request, context, requestHash);
      if (recheck) return recheck;
      try {
        return await reconcile(await context.broadcaster.executeSafe(request.safe, calldata), requestHash, context);
      } catch (error) {
        const hash = knownHash(error);
        return hash ? reconcile(hash, requestHash, context) : result(requestHash, "transport-unavailable", "broadcaster unavailable");
      }
    }

    const stale = await validateDelay(request, context, requestHash);
    if (stale) return stale;
    const calldata = encodeDelayExecutionCalldata(request);
    const recheck = await validateDelayNow(request, context, requestHash);
    if (recheck) return recheck;
    try {
      return await reconcile(await context.broadcaster.executeDelay(request.delay, calldata), requestHash, context);
    } catch (error) {
      const hash = knownHash(error);
      return hash ? reconcile(hash, requestHash, context) : result(requestHash, "transport-unavailable", "broadcaster unavailable");
    }
  } catch {
    return result(requestHash, "rpc-inconsistent", "relayer read failed");
  }
}
