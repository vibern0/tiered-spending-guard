import type { BackendConfig } from "./config";
import type { BackendHandlers, VaultProvisioningResult } from "./server";
import { type BackendPreparedSubmission } from "./vault";
import type { PwaProvisioningSummary, ReviewedPwaProvisioner } from "./provisioner";
import { challengeForDigest, verifyPasskeyAssertion, type BackendPasskeyRole, type StoredCredential, type VerifiedPasskeyApproval } from "./webauthn";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import type { Address, Hex } from "viem";
import type { PwaProvisioningResult } from "@recent-tx-safe-guard/security-core/pwa";

export type BackendVaultRecord = Readonly<VaultProvisioningResult & {
  primaryCredentialId: string;
  secondaryCredentialId: string;
  verifiedProvisioning: PwaProvisioningResult;
}>;

export type BackendIntent =
  | Readonly<{ kind: "transfer"; recipient: unknown; amount: unknown; idempotencyKey: unknown }>
  | Readonly<{ kind: "add-recipient"; recipient: unknown; idempotencyKey: unknown }>
  | Readonly<{ kind: "cancel-queued" | "execute-ready" | "skip-expired"; queueNonce: unknown; queueFingerprint: unknown; idempotencyKey: unknown }>;
export type BackendPreparation = (input: Readonly<{ vault: BackendVaultRecord; request: BackendIntent }>) => Promise<BackendPreparedSubmission>;
export type BackendSubmission = (input: Readonly<{ vault: BackendVaultRecord; id: string; body: unknown }>) => Promise<unknown>;
export type BackendSubmissionReader = (input: Readonly<{ vault: BackendVaultRecord; id: string }>) => Promise<unknown>;

export type BackendHandlerOptions = Readonly<{
  config: BackendConfig;
  usdc: Address;
  provisioner: ReviewedPwaProvisioner;
  prepareTransfer?: BackendPreparation;
  submit?: BackendSubmission;
  submission?: BackendSubmissionReader;
  verifyAssertion?: typeof verifyPasskeyAssertion;
}>;

type ProvisioningInput = Readonly<{
  primaryCredentialId?: unknown;
  secondaryCredentialId?: unknown;
}>;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function role(value: unknown): BackendPasskeyRole {
  if (value !== "primary" && value !== "secondary") throw new Error("unsupported passkey role");
  return value;
}

export type BackendHandlerSet = Omit<BackendHandlers, "prepareTransfer" | "submit" | "submission"> & Readonly<{
  planVault: (body: unknown) => Promise<PwaProvisioningSummary>;
  prepareTransfer: (body: unknown) => Promise<BackendPreparedSubmission>;
  submit: (id: string, body: unknown) => Promise<unknown>;
  submission: (id: string) => Promise<unknown>;
  storeCredential: (credential: StoredCredential & Readonly<{ role: BackendPasskeyRole; credentialId: string }>) => void;
  verifyApproval: (safeTxHash: Hex, body: unknown) => Promise<VerifiedPasskeyApproval>;
  vaultRecord: () => BackendVaultRecord | undefined;
}>;

export function createBackendHandlers(options: BackendHandlerOptions): BackendHandlerSet {
  const credentials = new Map<BackendPasskeyRole, StoredCredential & Readonly<{ role: BackendPasskeyRole; credentialId: string }>>();
  let vault: BackendVaultRecord | undefined;
  let pending: Readonly<{ packageHash: Hex; primaryCredentialId: string; secondaryCredentialId: string }> | undefined;

  const storeCredential = (credential: StoredCredential & Readonly<{ role: BackendPasskeyRole; credentialId: string }>): void => {
    const passkeyRole = role(credential.role);
    if (!credential.id || credential.id !== credential.credentialId) throw new Error("credential metadata is not self-consistent");
    const existing = credentials.get(passkeyRole);
    if (existing) throw new Error(`${passkeyRole} credential is already registered`);
    for (const [existingRole, current] of credentials) {
      if (existingRole !== passkeyRole && (current.id === credential.id || Buffer.from(current.publicKey).equals(Buffer.from(credential.publicKey)) || (current.x === credential.x && current.y === credential.y))) {
        throw new Error("primary and secondary credentials must be distinct");
      }
    }
    credentials.set(passkeyRole, Object.freeze({ ...credential, role: passkeyRole }));
  };

  const planVault = async (input: unknown): Promise<PwaProvisioningSummary> => {
    const body = record(input, "vault request") as ProvisioningInput;
    const keys = Object.keys(body);
    if (keys.length !== 2 || !keys.includes("primaryCredentialId") || !keys.includes("secondaryCredentialId")) throw new Error("vault planning body contains an unsupported field");
    const primaryCredentialId = stringField(body.primaryCredentialId, "primary credential ID");
    const secondaryCredentialId = stringField(body.secondaryCredentialId, "secondary credential ID");
    const primary = credentials.get("primary");
    const secondary = credentials.get("secondary");
    if (primary?.id !== primaryCredentialId || secondary?.id !== secondaryCredentialId) throw new Error("verified primary and secondary credentials are required");
    const result = await options.provisioner.plan({ primary, secondary });
    pending = Object.freeze({ packageHash: result.packageHash, primaryCredentialId, secondaryCredentialId });
    return result;
  };

  const provisionVault = async (input: unknown): Promise<VaultProvisioningResult> => {
    const body = record(input, "vault execution request");
    if (Object.keys(body).length !== 1 || !("packageHash" in body)) throw new Error("vault execution body contains an unsupported field");
    if (typeof body.packageHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.packageHash)) throw new Error("packageHash is required");
    if (!pending || pending.packageHash.toLowerCase() !== body.packageHash.toLowerCase()) throw new Error("packageHash does not match the pending review");
    const completed = await options.provisioner.execute({ packageHash: body.packageHash as Hex });
    vault = Object.freeze({ ...completed.response, primaryCredentialId: pending.primaryCredentialId, secondaryCredentialId: pending.secondaryCredentialId, verifiedProvisioning: completed.verified });
    pending = undefined;
    return completed.response;
  };

  const requireVault = (): BackendVaultRecord => {
    if (!vault) throw new Error("vault is not provisioned");
    return vault;
  };

  const prepareTransfer = async (input: unknown): Promise<BackendPreparedSubmission> => {
    if (!options.prepareTransfer) throw new Error("submission preparation unavailable");
    const request = record(input, "transfer request");
    const kind = request.kind;
    const expected = kind === "transfer" ? ["kind", "recipient", "amount", "idempotencyKey"] : kind === "add-recipient" ? ["kind", "recipient", "idempotencyKey"] : ["kind", "queueNonce", "queueFingerprint", "idempotencyKey"];
    if (!["transfer", "add-recipient", "cancel-queued", "execute-ready", "skip-expired"].includes(String(kind)) || Object.keys(request).length !== expected.length || Object.keys(request).some((key) => !expected.includes(key))) throw new Error("submission preparation body contains an unsupported field");
    const intent = (kind === "transfer"
      ? { kind, recipient: request.recipient, amount: request.amount, idempotencyKey: request.idempotencyKey }
      : kind === "add-recipient"
        ? { kind, recipient: request.recipient, idempotencyKey: request.idempotencyKey }
      : { kind, queueNonce: request.queueNonce, queueFingerprint: request.queueFingerprint, idempotencyKey: request.idempotencyKey }) as BackendIntent;
    const prepared = await options.prepareTransfer({ vault: requireVault(), request: intent });
    if (prepared.id !== request.idempotencyKey || prepared.publicRequest.kind !== kind || prepared.publicRequest.idempotencyKey !== request.idempotencyKey) throw new Error("prepared request does not match the server-held intent");
    return prepared;
  };

  const submit = async (id: string, body: unknown): Promise<unknown> => {
    if (!options.submit) throw new Error("submission unavailable");
    return options.submit({ vault: requireVault(), id, body });
  };

  const submission = async (id: string): Promise<unknown> => {
    if (!options.submission) throw new Error("submission unavailable");
    return await options.submission({ vault: requireVault(), id });
  };

  const verifyApproval = async (safeTxHash: Hex, input: unknown): Promise<VerifiedPasskeyApproval> => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(safeTxHash)) throw new Error("server-held Safe transaction hash is invalid");
    const body = record(input, "passkey approval");
    const passkeyRole = role(body.role);
    const assertion = record(body.assertion, "passkey assertion") as unknown as AuthenticationResponseJSON;
    const stored = credentials.get(passkeyRole);
    if (!stored) throw new Error(`${passkeyRole} credential is not registered`);
    const currentVault = requireVault();
    const approval = await (options.verifyAssertion ?? verifyPasskeyAssertion)({
      role: passkeyRole,
      safe: currentVault.safe,
      chainId: options.config.chainId,
      safeTxHash,
      challenge: challengeForDigest(safeTxHash),
      binding: { safe: currentVault.safe, chainId: options.config.chainId, safeTxHash },
      rpId: options.config.rpId,
      origin: options.config.origin,
      credentialId: stored.id,
      response: assertion,
      credential: stored,
    });
    if (approval.role !== passkeyRole || approval.credentialId !== stored.id || approval.counter < stored.counter) throw new Error("verified passkey approval does not match stored credential metadata");
    credentials.set(passkeyRole, Object.freeze({ ...stored, counter: approval.counter }));
    return approval;
  };

  return Object.freeze({ planVault, provisionVault, prepareTransfer, submit, submission, storeCredential, verifyApproval, vaultRecord: () => vault });
}
