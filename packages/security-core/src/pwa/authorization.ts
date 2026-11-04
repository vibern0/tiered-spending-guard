import { getAddress, isAddressEqual, keccak256, stringToHex, type Address, type Hex } from "viem";
import CommittedAutomationPolicy from "../../config/sepolia.pwa-provisioning-automation.json";
import { SEPOLIA_CHAIN_ID } from "./profile";
import { derivePwaProvisioningEnvelope, type PwaProvisioningEnvelopePolicy } from "./provisioning-envelope";
import type { PwaProvisioningQuote } from "./provisioning-quote";
import { provisioningPackageHash, pwaProvisioningTransactionHash, type PwaProvisioningPlan, type PwaProvisioningTransaction, type PwaProvisioningTransactionId } from "./provisioning";

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const MAX_TOTAL_OUTLAY_WEI = 50_000_000_000_000_000n;

export type PwaProvisioningAutomationPolicy = PwaProvisioningEnvelopePolicy & Readonly<{
  formatVersion: 1;
  scope: "sepolia-pwa-provisioning-automation";
  chainId: typeof SEPOLIA_CHAIN_ID;
  profileRevision: "sepolia-pwa-phase-one-v1";
  safeProxySaltNonce: 0n;
  maxHeadLagBlocks: 2n;
  maxTotalOutlayWei: typeof MAX_TOTAL_OUTLAY_WEI;
}>;

export type PwaProvisioningAuthorizationFacts = Readonly<{
  chainId: number;
  deployer: Address;
  deployerNonce: bigint;
  packageHash: Hex;
  planHash: Hex;
  confirmedActualCost: bigint;
  pendingReservation: bigint;
  relayBalance: bigint;
  authorizedAt: string;
}>;

export type PwaProvisioningTransactionAuthorization = Readonly<{
  formatVersion: 1;
  scope: "sepolia-pwa-provisioning-transaction";
  packageHash: Hex;
  planHash: Hex;
  transactionId: PwaProvisioningTransactionId;
  transactionHash: Hex;
  nonce: string;
  quoteBlockNumber: string;
  quoteBlockHash: Hex;
  providers: readonly [string, string];
  gasEstimateA: string;
  gasEstimateB: string;
  priorityFeeA: string;
  priorityFeeB: string;
  baseFeePerGas: string;
  blockGasLimit: string;
  gasMarginBps: string;
  feeMarginBps: string;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  priorOutlayWei: string;
  resultingOutlayWei: string;
  authorizedAt: string;
  authorizationHash: Hex;
}>;

export type ProvisioningAuthorizer = Readonly<{
  authorizeTransaction(
    plan: PwaProvisioningPlan,
    transaction: PwaProvisioningTransaction,
    quote: PwaProvisioningQuote,
    facts: PwaProvisioningAuthorizationFacts,
  ): Promise<PwaProvisioningTransactionAuthorization>;
}>;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains unknown field ${key}`);
  for (const key of expected) if (!(key in value)) throw new Error(`${label} is missing field ${key}`);
}

function decimal(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !DECIMAL.test(value)) throw new Error(`${label} must be a canonical decimal string`);
  return BigInt(value);
}

function canonical(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function pwaProvisioningAuthorizationHash(value: Omit<PwaProvisioningTransactionAuthorization, "authorizationHash">): Hex {
  return keccak256(stringToHex(canonical(value)));
}

function authorizationPayload(value: PwaProvisioningTransactionAuthorization): Omit<PwaProvisioningTransactionAuthorization, "authorizationHash"> {
  const { authorizationHash: _authorizationHash, ...payload } = value;
  return payload;
}

export function loadPwaProvisioningAutomationPolicy(value: unknown): PwaProvisioningAutomationPolicy {
  const input = record(value, "provisioning automation policy");
  exactKeys(input, [
    "formatVersion", "scope", "chainId", "profileRevision", "safeProxySaltNonce",
    "gasMarginBps", "feeMarginBps", "maxEstimateDivergenceBps", "maxHeadLagBlocks", "maxTotalOutlayWei",
  ], "provisioning automation policy");
  if (input.formatVersion !== 1 || input.scope !== "sepolia-pwa-provisioning-automation") throw new Error("unsupported provisioning automation policy");
  if (input.chainId !== SEPOLIA_CHAIN_ID) throw new Error("provisioning automation supports only Ethereum Sepolia");
  if (input.profileRevision !== "sepolia-pwa-phase-one-v1") throw new Error("provisioning automation profile revision is not committed");
  const safeProxySaltNonce = decimal(input.safeProxySaltNonce, "safe proxy salt");
  if (safeProxySaltNonce !== 0n) throw new Error("provisioning automation requires Safe proxy salt 0");
  const gasMarginBps = decimal(input.gasMarginBps, "gas margin");
  if (gasMarginBps !== 3000n) throw new Error("provisioning automation gas margin must be 30 percent");
  const feeMarginBps = decimal(input.feeMarginBps, "fee margin");
  if (feeMarginBps !== 3000n) throw new Error("provisioning automation fee margin must be 30 percent");
  const maxEstimateDivergenceBps = decimal(input.maxEstimateDivergenceBps, "maximum estimate divergence");
  if (maxEstimateDivergenceBps !== 1000n) throw new Error("provisioning automation estimate divergence must be 10 percent");
  const maxHeadLagBlocks = decimal(input.maxHeadLagBlocks, "maximum head lag");
  if (maxHeadLagBlocks !== 2n) throw new Error("provisioning automation head lag must be two blocks");
  const maxTotalOutlayWei = decimal(input.maxTotalOutlayWei, "maximum total outlay");
  if (maxTotalOutlayWei !== MAX_TOTAL_OUTLAY_WEI) throw new Error("provisioning automation outlay ceiling must be 0.05 ETH");
  return Object.freeze({
    formatVersion: 1,
    scope: "sepolia-pwa-provisioning-automation",
    chainId: SEPOLIA_CHAIN_ID,
    profileRevision: "sepolia-pwa-phase-one-v1",
    safeProxySaltNonce: 0n,
    gasMarginBps,
    feeMarginBps,
    maxEstimateDivergenceBps,
    maxHeadLagBlocks: 2n,
    maxTotalOutlayWei: MAX_TOTAL_OUTLAY_WEI,
  });
}

export function loadCommittedPwaProvisioningAutomationPolicy(): PwaProvisioningAutomationPolicy {
  return loadPwaProvisioningAutomationPolicy(CommittedAutomationPolicy);
}

export function assertPwaProvisioningTransactionAuthorization(plan: PwaProvisioningPlan, value: unknown): PwaProvisioningTransactionAuthorization {
  const input = record(value, "provisioning transaction authorization");
  exactKeys(input, [
    "formatVersion", "scope", "packageHash", "planHash", "transactionId", "transactionHash", "nonce",
    "quoteBlockNumber", "quoteBlockHash", "providers", "gasEstimateA", "gasEstimateB", "priorityFeeA", "priorityFeeB",
    "baseFeePerGas", "blockGasLimit", "gasMarginBps", "feeMarginBps", "gasLimit", "maxFeePerGas",
    "maxPriorityFeePerGas", "priorOutlayWei", "resultingOutlayWei", "authorizedAt", "authorizationHash",
  ], "provisioning transaction authorization");
  if (input.formatVersion !== 1 || input.scope !== "sepolia-pwa-provisioning-transaction") throw new Error("unsupported provisioning transaction authorization");
  if (input.packageHash !== provisioningPackageHash(plan) || input.planHash !== plan.planHash) throw new Error("provisioning transaction authorization package or plan hash mismatch");
  const transaction = plan.transactions.find((candidate) => candidate.id === input.transactionId && candidate.nonce.toString() === input.nonce);
  if (!transaction || input.transactionHash !== pwaProvisioningTransactionHash(transaction)) throw new Error("provisioning transaction authorization transaction mismatch");
  for (const field of ["nonce", "quoteBlockNumber", "gasEstimateA", "gasEstimateB", "priorityFeeA", "priorityFeeB", "baseFeePerGas", "blockGasLimit", "gasMarginBps", "feeMarginBps", "gasLimit", "maxFeePerGas", "maxPriorityFeePerGas", "priorOutlayWei", "resultingOutlayWei"] as const) decimal(input[field], `authorization ${field}`);
  if (!Array.isArray(input.providers) || input.providers.length !== 2 || input.providers.some((item) => typeof item !== "string" || !item) || input.providers[0] === input.providers[1]) throw new Error("provisioning authorization providers are invalid");
  if (typeof input.authorizedAt !== "string" || Number.isNaN(Date.parse(input.authorizedAt))) throw new Error("provisioning authorization timestamp is invalid");
  if (typeof input.quoteBlockHash !== "string" || typeof input.authorizationHash !== "string") throw new Error("provisioning authorization hash is invalid");
  const authorization = Object.freeze({ ...input, providers: Object.freeze([...input.providers]) }) as unknown as PwaProvisioningTransactionAuthorization;
  if (authorization.authorizationHash !== pwaProvisioningAuthorizationHash(authorizationPayload(authorization))) throw new Error("provisioning authorization hash mismatch");
  return authorization;
}

export function createLocalPhaseOneProvisioningAuthorizer(policy = loadCommittedPwaProvisioningAutomationPolicy()): ProvisioningAuthorizer {
  return Object.freeze({
    async authorizeTransaction(plan, transaction, quote, facts) {
      if (plan.chainId !== policy.chainId || facts.chainId !== policy.chainId) throw new Error("fail closed: automatic provisioning is Sepolia-only");
      if (!isAddressEqual(plan.deployer, getAddress(facts.deployer))) throw new Error("fail closed: provisioning deployer identity changed before authorization");
      if (facts.packageHash !== provisioningPackageHash(plan) || facts.planHash !== plan.planHash) throw new Error("fail closed: provisioning package or plan facts changed");
      if (plan.vaultPlan.safeProxySaltNonce !== policy.safeProxySaltNonce) throw new Error("fail closed: provisioning plan does not use Safe proxy salt 0");
      const planned = plan.transactions.find((candidate) => candidate.id === transaction.id);
      if (!planned || pwaProvisioningTransactionHash(planned) !== pwaProvisioningTransactionHash(transaction) || transaction.nonce !== facts.deployerNonce) throw new Error("fail closed: provisioning transaction or nonce changed");
      const envelope = derivePwaProvisioningEnvelope({
        estimates: quote.estimates,
        blockGasLimit: quote.blockGasLimit,
        baseFeePerGas: quote.baseFeePerGas,
        priorityFeesPerGas: quote.priorityFeesPerGas,
        value: transaction.value,
        confirmedActualCost: facts.confirmedActualCost,
        pendingReservation: facts.pendingReservation,
        relayBalance: facts.relayBalance,
        policy,
      });
      const payload = Object.freeze({
        formatVersion: 1 as const,
        scope: "sepolia-pwa-provisioning-transaction" as const,
        packageHash: facts.packageHash,
        planHash: facts.planHash,
        transactionId: transaction.id,
        transactionHash: pwaProvisioningTransactionHash(transaction),
        nonce: transaction.nonce.toString(),
        quoteBlockNumber: quote.blockNumber.toString(),
        quoteBlockHash: quote.blockHash,
        providers: quote.providers,
        gasEstimateA: quote.estimates[0].toString(),
        gasEstimateB: quote.estimates[1].toString(),
        priorityFeeA: quote.priorityFeesPerGas[0].toString(),
        priorityFeeB: quote.priorityFeesPerGas[1].toString(),
        baseFeePerGas: quote.baseFeePerGas.toString(),
        blockGasLimit: quote.blockGasLimit.toString(),
        gasMarginBps: policy.gasMarginBps.toString(),
        feeMarginBps: policy.feeMarginBps.toString(),
        gasLimit: envelope.gasLimit.toString(),
        maxFeePerGas: envelope.maxFeePerGas.toString(),
        maxPriorityFeePerGas: envelope.maxPriorityFeePerGas.toString(),
        priorOutlayWei: (facts.confirmedActualCost + facts.pendingReservation).toString(),
        resultingOutlayWei: envelope.totalOutlay.toString(),
        authorizedAt: facts.authorizedAt,
      });
      return Object.freeze({ ...payload, authorizationHash: pwaProvisioningAuthorizationHash(payload) });
    },
  });
}
