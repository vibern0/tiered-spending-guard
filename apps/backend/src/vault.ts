import {
  decodeFunctionData,
  encodeFunctionData,
  hashTypedData,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { SubmissionJournal, type JournalEntry, type Reconciliation } from "./journal";
import type { VaultProvisioningResult } from "./server";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
export const SEPOLIA_USDC_ADDRESS = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Address;
const USDC_ABI = parseAbi(["function transfer(address to,uint256 amount) returns (bool)"]);
const SAFE_TX_TYPES = [
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "data", type: "bytes" },
  { name: "operation", type: "uint8" },
  { name: "safeTxGas", type: "uint256" },
  { name: "baseGas", type: "uint256" },
  { name: "gasPrice", type: "uint256" },
  { name: "gasToken", type: "address" },
  { name: "refundReceiver", type: "address" },
  { name: "nonce", type: "uint256" },
] as const;

export type SafeExecutionRequest = Readonly<{
  version: 1;
  kind: "safe-execution";
  idempotencyKey: Hex;
  chainId: number;
  deploymentsHash: Hex;
  policyHash: Hex;
  safe: Address;
  guard: Address;
  asset: Address;
  transaction: Readonly<{
    to: Address;
    value: bigint;
    data: Hex;
    operation: 0;
    safeTxGas: 0n;
    baseGas: 0n;
    gasPrice: 0n;
    gasToken: Address;
    refundReceiver: Address;
    nonce: bigint;
  }>;
  safeTxHash: Hex;
  signatures?: Hex;
  expectedSpend: Readonly<{
    window: bigint;
    baseSpent: bigint;
    instantSpent: bigint;
  }>;
}>;

export type PreparedUsdcTransfer = Readonly<{
  chainId: number;
  safe: Address;
  guard: Address;
  usdc: Address;
  configuredUsdc: Address;
  recipient: Address;
  amount: bigint;
  nonce: bigint;
  deploymentHash: Hex;
  policyHash: Hex;
  idempotencyKey: Hex;
  signatures: Hex;
  expectedSpend: Readonly<{
    window: bigint;
    baseSpent: bigint;
    instantSpent: bigint;
  }>;
  allowedRecipients: readonly Address[];
}>;

export type ReviewedDeploymentEvidence = Readonly<{
  verified: true;
  chainId: 11155111;
  safeSingleton: Address;
  safeProxyFactory: Address;
  passkeySignerFactory: Address;
  delayArtifactHash: Hex;
}>;

export type FreshVaultProvisioner = Readonly<{
  deploy: (
    input: Readonly<{
      chainId: 11155111;
      usdc: Address;
      primaryCredentialId: string;
      secondaryCredentialId: string;
      artifacts: ReviewedDeploymentEvidence;
    }>,
  ) => Promise<VaultProvisioningResult>;
}>;

function assertHex(value: Hex, label: string): void {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) throw new Error(`${label} is invalid`);
}

function assertAddress(value: Address, label: string): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${label} is invalid`);
}

function assertExactInput(input: PreparedUsdcTransfer): void {
  const allowed = new Set([
    "chainId",
    "safe",
    "guard",
    "usdc",
    "configuredUsdc",
    "recipient",
    "amount",
    "nonce",
    "deploymentHash",
    "policyHash",
    "idempotencyKey",
    "signatures",
    "expectedSpend",
    "allowedRecipients",
  ]);
  for (const key of Object.keys(input))
    if (!allowed.has(key)) throw new Error(`unknown transfer field: ${key}`);
}

export async function prepareUsdcTransfer(
  input: PreparedUsdcTransfer,
): Promise<SafeExecutionRequest> {
  assertExactInput(input);
  if (input.chainId !== 11155111) throw new Error("only Sepolia is supported");
  assertAddress(input.safe, "safe");
  assertAddress(input.guard, "guard");
  assertAddress(input.usdc, "usdc");
  assertAddress(input.recipient, "recipient");
  if (input.usdc.toLowerCase() !== input.configuredUsdc.toLowerCase())
    throw new Error("USDC address is not the configured Circle USDC candidate");
  if (input.usdc === ZERO || input.recipient === ZERO || input.amount <= 0n || input.nonce < 0n)
    throw new Error("invalid USDC transfer bounds");
  if (
    !input.allowedRecipients.some(
      (address) => address.toLowerCase() === input.recipient.toLowerCase(),
    )
  )
    throw new Error("recipient is not allowlisted");
  assertHex(input.deploymentHash, "deploymentHash");
  assertHex(input.policyHash, "policyHash");
  assertHex(input.idempotencyKey, "idempotencyKey");
  if (input.signatures !== undefined) {
    assertHex(input.signatures, "signatures");
    if (input.signatures.length < 132) throw new Error("primary Safe signature is invalid");
  }
  const data = encodeFunctionData({
    abi: USDC_ABI,
    functionName: "transfer",
    args: [input.recipient, input.amount],
  });
  const transaction = {
    to: input.usdc,
    value: 0n,
    data,
    operation: 0 as const,
    safeTxGas: 0n as const,
    baseGas: 0n as const,
    gasPrice: 0n as const,
    gasToken: ZERO,
    refundReceiver: ZERO,
    nonce: input.nonce,
  };
  const safeTxHash = hashTypedData({
    domain: { chainId: input.chainId, verifyingContract: input.safe },
    types: { SafeTx: SAFE_TX_TYPES },
    primaryType: "SafeTx",
    message: transaction,
  });
  return Object.freeze({
    version: 1,
    kind: "safe-execution",
    idempotencyKey: input.idempotencyKey,
    chainId: input.chainId,
    deploymentsHash: input.deploymentHash,
    policyHash: input.policyHash,
    safe: input.safe,
    guard: input.guard,
    asset: input.usdc,
    transaction,
    safeTxHash,
    signatures: input.signatures ?? "0x",
    expectedSpend: input.expectedSpend,
  });
}

export type SubmissionStatus = Readonly<{
  id: Hex;
  state: "awaiting_secondary" | "queued" | "confirmed" | "reverted";
  requiredApprovals: "primary" | "secondary" | "delayed";
  safeTxHash: Hex;
  transactionHash?: Hex;
}>;

export type SafeSubmissionServiceOptions = Readonly<{
  journal: SubmissionJournal;
  limits: Readonly<{ baseDailyLimit: bigint; instantDailyLimit: bigint }>;
  verifySignature: (
    role: "primary" | "secondary",
    request: SafeExecutionRequest,
    signature: Hex,
  ) => Promise<boolean>;
  broadcast: (
    request: SafeExecutionRequest,
    signatures: Readonly<{ role: "primary" | "secondary"; signature: Hex }[]>,
  ) => Promise<Hex>;
  reconcile?: (request: SafeExecutionRequest) => Promise<Reconciliation | undefined>;
}>;

const exactRequest = (request: SafeExecutionRequest): SafeExecutionRequest =>
  Object.freeze({
    ...request,
    transaction: Object.freeze({ ...request.transaction }),
    expectedSpend: Object.freeze({ ...request.expectedSpend }),
  });

function assertCanonicalRequest(request: SafeExecutionRequest): void {
  if (
    request.chainId !== 11155111 ||
    request.transaction.operation !== 0 ||
    request.transaction.value !== 0n
  )
    throw new Error("only zero-value CALLs on Sepolia are supported");
  if (request.asset.toLowerCase() !== request.transaction.to.toLowerCase())
    throw new Error("Safe target must be the configured USDC asset");
  if (
    request.transaction.safeTxGas !== 0n ||
    request.transaction.baseGas !== 0n ||
    request.transaction.gasPrice !== 0n ||
    request.transaction.gasToken !== ZERO ||
    request.transaction.refundReceiver !== ZERO
  )
    throw new Error("Safe gas and refund fields must be zero");
  const digest = hashTypedData({
    domain: { chainId: request.chainId, verifyingContract: request.safe },
    types: { SafeTx: SAFE_TX_TYPES },
    primaryType: "SafeTx",
    message: request.transaction,
  });
  if (digest.toLowerCase() !== request.safeTxHash.toLowerCase())
    throw new Error("Safe transaction digest does not match the exact request");
  if (
    request.expectedSpend.window < 0n ||
    request.expectedSpend.baseSpent < 0n ||
    request.expectedSpend.instantSpent < 0n
  )
    throw new Error("spend state cannot be negative");
}

export class SafeSubmissionService {
  readonly broadcast: SafeSubmissionServiceOptions["broadcast"];
  private readonly options: SafeSubmissionServiceOptions;
  private readonly requests = new Map<string, SafeExecutionRequest>();
  private readonly approvals = new Map<string, { primary?: Hex; secondary?: Hex }>();

  constructor(options: SafeSubmissionServiceOptions) {
    this.options = options;
    this.broadcast = options.broadcast;
  }

  prepare(request: SafeExecutionRequest): SafeExecutionRequest {
    assertCanonicalRequest(request);
    const frozen = exactRequest(request);
    const existing = this.requests.get(request.idempotencyKey);
    if (existing && existing.safeTxHash !== frozen.safeTxHash)
      throw new Error("submission ID is already bound to another Safe digest");
    this.options.journal.prepare(request.idempotencyKey, request.safeTxHash);
    this.requests.set(request.idempotencyKey, existing ?? frozen);
    return existing ?? frozen;
  }

  async submitPrimary(id: Hex, signature: Hex): Promise<SubmissionStatus> {
    const request = this.require(id);
    const required = this.requiredApprovals(request);
    const approvals = this.approvals.get(id) ?? {};
    if (approvals.primary) {
      if (this.options.journal.get(id)?.state === "uncertain")
        return this.broadcastOnce(request, required, approvals);
      return this.statusFromJournal(request, required);
    }
    await this.verify("primary", request, signature);
    approvals.primary = signature;
    this.approvals.set(id, approvals);
    if (required !== "primary")
      return {
        id,
        state: "awaiting_secondary",
        requiredApprovals: required,
        safeTxHash: request.safeTxHash,
      };
    return this.broadcastOnce(request, required, approvals);
  }

  async submitSecondary(id: Hex, signature: Hex): Promise<SubmissionStatus> {
    const request = this.require(id);
    const required = this.requiredApprovals(request);
    const approvals = this.approvals.get(id);
    if (!approvals?.primary)
      throw new Error("primary approval is required before secondary approval");
    await this.verify("secondary", request, signature);
    approvals.secondary = signature;
    this.approvals.set(id, approvals);
    return this.broadcastOnce(request, required, approvals);
  }

  private async broadcastOnce(
    request: SafeExecutionRequest,
    required: SubmissionStatus["requiredApprovals"],
    approvals: { primary?: Hex; secondary?: Hex },
  ): Promise<SubmissionStatus> {
    const existing = this.options.journal.get(request.idempotencyKey);
    if (existing?.state === "uncertain") {
      if (!this.options.reconcile) throw new Error("reconcile uncertain broadcast before retry");
      const reconciled = await this.options.reconcile(request);
      if (!reconciled) throw new Error("broadcast remains uncertain");
      this.options.journal.reconcile(request.idempotencyKey, reconciled);
      return {
        id: request.idempotencyKey,
        state: reconciled.status,
        requiredApprovals: required,
        safeTxHash: request.safeTxHash,
        transactionHash: reconciled.transactionHash as Hex,
      };
    }
    if (existing?.state === "confirmed" || existing?.state === "reverted")
      return this.statusFromJournal(request, required);
    try {
      if (!approvals.primary || (required !== "primary" && !approvals.secondary))
        throw new Error("required approvals are incomplete");
      const transactionHash = await this.broadcast(request, [
        { role: "primary", signature: approvals.primary },
        ...(approvals.secondary
          ? [{ role: "secondary" as const, signature: approvals.secondary }]
          : []),
      ]);
      this.options.journal.markSubmitted(request.idempotencyKey, transactionHash);
      this.options.journal.reconcile(request.idempotencyKey, {
        status: "confirmed",
        transactionHash,
      });
      return {
        id: request.idempotencyKey,
        state: required === "delayed" ? "queued" : "confirmed",
        requiredApprovals: required,
        safeTxHash: request.safeTxHash,
        transactionHash,
      };
    } catch (error) {
      this.options.journal.markUncertain(request.idempotencyKey);
      throw error;
    }
  }

  private async verify(
    role: "primary" | "secondary",
    request: SafeExecutionRequest,
    signature: Hex,
  ): Promise<void> {
    if (
      !/^0x[0-9a-fA-F]+$/.test(signature) ||
      signature.length < 132 ||
      !(await this.options.verifySignature(role, request, signature))
    )
      throw new Error(`${role} signature does not authorize the exact Safe digest`);
  }

  private requiredApprovals(request: SafeExecutionRequest): SubmissionStatus["requiredApprovals"] {
    const decoded = decodeFunctionData({
      abi: USDC_ABI,
      data: request.transaction.data,
    });
    if (decoded.functionName !== "transfer")
      throw new Error("only USDC transfer calls are supported");
    const amount = decoded.args[1] as bigint;
    const base = request.expectedSpend.baseSpent + amount;
    const instant = request.expectedSpend.instantSpent + amount;
    if (base <= this.options.limits.baseDailyLimit) return "primary";
    if (instant <= this.options.limits.instantDailyLimit) return "secondary";
    return "delayed";
  }

  private statusFromJournal(
    request: SafeExecutionRequest,
    required: SubmissionStatus["requiredApprovals"],
  ): SubmissionStatus {
    const entry = this.options.journal.get(request.idempotencyKey);
    if (!entry) throw new Error("unknown submission");
    if (entry.state === "uncertain") throw new Error("reconcile uncertain broadcast before retry");
    if (entry.state !== "confirmed" && entry.state !== "reverted")
      return {
        id: request.idempotencyKey,
        state: "awaiting_secondary",
        requiredApprovals: required,
        safeTxHash: request.safeTxHash,
      };
    return {
      id: request.idempotencyKey,
      state: entry.state,
      requiredApprovals: required,
      safeTxHash: request.safeTxHash,
      transactionHash: entry.outerTransactionHash as Hex,
    };
  }

  private require(id: Hex): SafeExecutionRequest {
    const request = this.requests.get(id);
    if (!request) throw new Error("unknown submission");
    return request;
  }
}

export type BackendSubmissionKind =
  | "base-transfer"
  | "step-up-transfer"
  | "queue-transfer"
  | "add-recipient"
  | "cancel-queued"
  | "execute-ready"
  | "skip-expired";
export type BackendPreparedSubmission = Readonly<{
  id: string;
  requestHash: Hex;
  safeTxHash?: Hex;
  kind: BackendSubmissionKind;
  requiredApprovals: readonly ("primary" | "secondary")[];
  publicRequest: Readonly<Record<string, unknown>>;
}>;
export type BackendSubmissionBody =
  Readonly<{ role: "primary" | "secondary"; assertion: unknown }> | Readonly<{ role: "none" }>;
export type BackendApproval = Readonly<{
  role: "primary" | "secondary";
  payload: Hex;
}>;
export type BackendSubmissionReceipt = Readonly<{
  status: "confirmed" | "reverted";
  transactionHash: Hex;
  blockNumber: bigint;
  blockHash: Hex;
}>;
export type BackendSubmissionView = Readonly<{
  id: string;
  state: JournalEntry["state"];
  kind: BackendSubmissionKind | string;
  requestHash: string;
  requiredApprovals: readonly ("primary" | "secondary")[];
  approvals: JournalEntry["approvals"];
  transactionHash?: string;
  receipt?: JournalEntry["receipt"];
}>;

export type PwaSubmissionServiceOptions = Readonly<{
  journal: SubmissionJournal;
  verifyApproval: (
    role: "primary" | "secondary",
    prepared: BackendPreparedSubmission,
    assertion: unknown,
  ) => Promise<BackendApproval>;
  revalidate: (prepared: BackendPreparedSubmission) => Promise<void>;
  deriveOuterHash: (
    prepared: BackendPreparedSubmission,
    approvals: readonly BackendApproval[],
  ) => Promise<Hex>;
  broadcast: (
    prepared: BackendPreparedSubmission,
    approvals: readonly BackendApproval[],
    outerTransactionHash: Hex,
  ) => Promise<Hex>;
  reconcile: (outerTransactionHash: Hex) => Promise<BackendSubmissionReceipt | undefined>;
  discard?: (prepared: BackendPreparedSubmission) => void | Promise<void>;
}>;

const bytes32 = /^0x[0-9a-fA-F]{64}$/;

function assertPreparedSubmission(value: BackendPreparedSubmission): void {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value.id) || !bytes32.test(value.requestHash))
    throw new Error("prepared submission identity is invalid");
  if (
    ![
      "base-transfer",
      "step-up-transfer",
      "queue-transfer",
      "add-recipient",
      "cancel-queued",
      "execute-ready",
      "skip-expired",
    ].includes(value.kind)
  )
    throw new Error("prepared submission kind is invalid");
  const direct = value.kind === "execute-ready" || value.kind === "skip-expired";
  const expected =
    value.kind === "base-transfer" ? ["primary"] : direct ? [] : ["primary", "secondary"];
  if (
    value.requiredApprovals.length !== expected.length ||
    value.requiredApprovals.some((role, index) => role !== expected[index])
  )
    throw new Error("prepared submission approval roles are invalid");
  if (!direct && (!value.safeTxHash || !bytes32.test(value.safeTxHash)))
    throw new Error("signed submission requires an exact Safe transaction hash");
}

function assertSubmitBody(body: BackendSubmissionBody): void {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("submission body must be an object");
  const keys = Object.keys(body);
  if (body.role === "none") {
    if (keys.length !== 1)
      throw new Error("permissionless submission contains an unsupported field");
    return;
  }
  if (
    (body.role !== "primary" && body.role !== "secondary") ||
    keys.length !== 2 ||
    !keys.includes("assertion")
  )
    throw new Error("signed submission body is invalid");
}

function publicView(
  entry: JournalEntry,
  prepared?: BackendPreparedSubmission,
): BackendSubmissionView {
  return Object.freeze({
    id: entry.id,
    state: entry.state,
    kind: prepared?.kind ?? String(entry.publicRequest.kind ?? "unknown"),
    requestHash: entry.requestHash,
    requiredApprovals: prepared?.requiredApprovals ?? [],
    approvals: entry.approvals,
    ...(entry.outerTransactionHash ? { transactionHash: entry.outerTransactionHash } : {}),
    ...(entry.receipt ? { receipt: entry.receipt } : {}),
  });
}

/** Durable public state plus process-local, one-use WebAuthn approvals. */
export class PwaSubmissionService {
  readonly journal: SubmissionJournal;
  readonly broadcast: PwaSubmissionServiceOptions["broadcast"];
  private readonly options: PwaSubmissionServiceOptions;
  private readonly prepared = new Map<string, BackendPreparedSubmission>();
  private readonly approvals = new Map<string, Map<"primary" | "secondary", BackendApproval>>();
  private readonly flights = new Map<string, Promise<BackendSubmissionView>>();
  private readonly statusFlights = new Map<string, Promise<BackendSubmissionView>>();

  constructor(options: PwaSubmissionServiceOptions) {
    this.options = options;
    this.journal = options.journal;
    this.broadcast = options.broadcast;
  }

  prepare(prepared: BackendPreparedSubmission): BackendPreparedSubmission {
    assertPreparedSubmission(prepared);
    const existing = this.prepared.get(prepared.id);
    if (existing && existing.requestHash.toLowerCase() !== prepared.requestHash.toLowerCase())
      throw new Error("submission ID is already bound to another request");
    const entry = this.journal.prepare(prepared.id, prepared.requestHash, prepared.publicRequest);
    this.prepared.set(
      prepared.id,
      existing ??
        Object.freeze({
          ...prepared,
          requiredApprovals: Object.freeze([...prepared.requiredApprovals]),
          publicRequest: entry.publicRequest,
        }),
    );
    if (entry.state === "prepared" && prepared.requiredApprovals.length > 0)
      this.journal.transition(prepared.id, "awaiting-primary");
    return this.prepared.get(prepared.id)!;
  }

  forgetApprovalsFor(matches: (id: string) => boolean): void {
    for (const id of this.approvals.keys()) if (matches(id)) this.approvals.delete(id);
  }

  submit(id: string, body: BackendSubmissionBody): Promise<BackendSubmissionView> {
    const active = this.flights.get(id);
    if (active) return active;
    const flight = this.submitOnce(id, body).finally(() => this.flights.delete(id));
    this.flights.set(id, flight);
    return flight;
  }

  status(id: string): Promise<BackendSubmissionView> {
    const active = this.statusFlights.get(id);
    if (active) return active;
    const flight = this.statusOnce(id).finally(() => this.statusFlights.delete(id));
    this.statusFlights.set(id, flight);
    return flight;
  }

  private async statusOnce(id: string): Promise<BackendSubmissionView> {
    const entry = this.journal.get(id);
    if (!entry) throw new Error("unknown submission");
    if (entry.state === "submitting" || entry.state === "uncertain") {
      if (!entry.outerTransactionHash || !bytes32.test(entry.outerTransactionHash))
        throw new Error("durable outer transaction hash is missing");
      const receipt = await this.options.reconcile(entry.outerTransactionHash as Hex);
      if (receipt) {
        if (receipt.transactionHash.toLowerCase() !== entry.outerTransactionHash.toLowerCase())
          throw new Error("reconciliation returned another transaction hash");
        return this.reconcileTerminalView(id, receipt);
      }
    }
    return publicView(entry, this.prepared.get(id));
  }

  private async submitOnce(
    id: string,
    body: BackendSubmissionBody,
  ): Promise<BackendSubmissionView> {
    assertSubmitBody(body);
    const prepared = this.prepared.get(id);
    if (!prepared) return this.status(id);
    const existing = this.journal.get(id);
    if (!existing) throw new Error("unknown submission");
    if (["submitting", "uncertain", "confirmed", "reverted", "superseded"].includes(existing.state))
      return this.status(id);
    const direct = prepared.requiredApprovals.length === 0;
    if (body.role === "none") {
      if (!direct)
        throw new Error(
          "permissionless submission is allowed only for ready execution or expired skip",
        );
      return this.broadcastPrepared(prepared, []);
    }
    if (direct) throw new Error("permissionless lifecycle submission must use role none");
    if (!prepared.requiredApprovals.includes(body.role))
      throw new Error(`${body.role} approval is not required`);
    const current = this.approvals.get(id) ?? new Map<"primary" | "secondary", BackendApproval>();
    if (body.role === "secondary" && !current.has("primary"))
      throw new Error("primary approval is required before secondary approval");
    if (current.has(body.role)) throw new Error(`${body.role} approval is already present`);
    await this.revalidateOrSupersede(prepared);
    const approval = await this.options.verifyApproval(body.role, prepared, body.assertion);
    if (approval.role !== body.role || !/^0x(?:[0-9a-fA-F]{2})+$/.test(approval.payload))
      throw new Error("verified approval does not match the requested role");
    current.set(body.role, approval);
    this.approvals.set(id, current);
    this.journal.recordApproval(id, body.role, keccak256(approval.payload));
    if (prepared.requiredApprovals.some((role) => !current.has(role)))
      return publicView(this.journal.get(id)!, prepared);
    return this.broadcastPrepared(
      prepared,
      prepared.requiredApprovals.map((role) => current.get(role)!),
    );
  }

  private async broadcastPrepared(
    prepared: BackendPreparedSubmission,
    approvals: readonly BackendApproval[],
  ): Promise<BackendSubmissionView> {
    await this.revalidateOrSupersede(prepared);
    let outerTransactionHash: Hex;
    try {
      outerTransactionHash = await this.options.deriveOuterHash(prepared, approvals);
      if (!bytes32.test(outerTransactionHash))
        throw new Error("locally derived outer transaction hash is invalid");
    } catch (error) {
      await this.discardBeforeBroadcast(prepared);
      throw error;
    }
    try {
      this.journal.markSubmitting(prepared.id, outerTransactionHash);
    } catch (error) {
      await this.discardBeforeBroadcast(prepared);
      throw error;
    }
    try {
      const broadcastHash = await this.options.broadcast(prepared, approvals, outerTransactionHash);
      if (broadcastHash.toLowerCase() !== outerTransactionHash.toLowerCase())
        throw new Error("provider returned another transaction hash");
      const view = await this.status(prepared.id);
      if (view.state === "submitting") this.journal.markUncertain(prepared.id);
      return publicView(this.journal.get(prepared.id)!, prepared);
    } catch {
      // A read-only poll may have completed the receipt while broadcast was in
      // flight. Never downgrade that durable evidence after a provider failure.
      if (this.journal.get(prepared.id)?.state === "submitting")
        this.journal.markUncertain(prepared.id);
      throw new Error("submission became uncertain; reconcile the durable outer hash");
    } finally {
      this.approvals.delete(prepared.id);
    }
  }

  private reconcileTerminalView(
    id: string,
    receipt: BackendSubmissionReceipt,
  ): BackendSubmissionView {
    const retained = (): BackendSubmissionView | undefined => {
      const current = this.journal.get(id);
      if (!current || (current.state !== "confirmed" && current.state !== "reverted"))
        return undefined;
      if (
        current.state !== receipt.status ||
        current.outerTransactionHash?.toLowerCase() !== receipt.transactionHash.toLowerCase() ||
        current.receipt?.transactionHash.toLowerCase() !== receipt.transactionHash.toLowerCase() ||
        current.receipt?.blockNumber !== receipt.blockNumber ||
        current.receipt?.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase()
      )
        throw new Error("terminal receipt conflicts with retained evidence");
      return publicView(current, this.prepared.get(id));
    };
    const existing = retained();
    if (existing) return existing;
    try {
      return publicView(this.journal.reconcile(id, receipt), this.prepared.get(id));
    } catch (error) {
      // Another process can finish between the fresh read and the locked mutation.
      // Only a terminal-state race is reusable; persistence errors must still stop.
      if (
        error instanceof Error &&
        /^terminal submission cannot be reconciled from (confirmed|reverted)$/.test(error.message)
      ) {
        const raced = retained();
        if (raced) return raced;
      }
      throw error;
    }
  }

  private async revalidateOrSupersede(prepared: BackendPreparedSubmission): Promise<void> {
    try {
      await this.options.revalidate(prepared);
    } catch (error) {
      this.supersede(prepared.id);
      throw error;
    }
  }

  private async discardBeforeBroadcast(prepared: BackendPreparedSubmission): Promise<void> {
    this.approvals.delete(prepared.id);
    try {
      await this.options.discard?.(prepared);
    } catch {
      /* Preserve the signing/persistence failure; never broadcast. */
    }
    try {
      this.supersede(prepared.id);
    } catch {
      /* A failed journal remains non-authorizing. */
    }
  }

  private supersede(id: string): void {
    this.approvals.delete(id);
    const entry = this.journal.get(id);
    if (entry && !["confirmed", "reverted", "superseded"].includes(entry.state))
      this.journal.transition(id, "superseded");
  }
}

export async function provisionFreshVault(
  input: Readonly<{
    chainId: number;
    usdc: Address;
    primaryCredentialId: string;
    secondaryCredentialId: string;
    relayPrivateKey?: string;
    artifacts: ReviewedDeploymentEvidence;
    provisioner: FreshVaultProvisioner;
  }>,
): Promise<VaultProvisioningResult> {
  if (input.chainId !== 11155111) throw new Error("only Sepolia vault provisioning is supported");
  if (!input.relayPrivateKey || !/^0x[0-9a-fA-F]{64}$/.test(input.relayPrivateKey))
    throw new Error("local relay secret is required");
  if (input.usdc.toLowerCase() !== SEPOLIA_USDC_ADDRESS.toLowerCase())
    throw new Error("reviewed Sepolia USDC address is required");
  if (
    !input.primaryCredentialId ||
    !input.secondaryCredentialId ||
    input.primaryCredentialId === input.secondaryCredentialId
  )
    throw new Error("distinct primary and secondary credentials are required");
  if (input.artifacts.verified !== true || input.artifacts.chainId !== 11155111)
    throw new Error("reviewed deployment evidence is required");
  return input.provisioner.deploy({
    chainId: 11155111,
    usdc: input.usdc,
    primaryCredentialId: input.primaryCredentialId,
    secondaryCredentialId: input.secondaryCredentialId,
    artifacts: input.artifacts,
  });
}
