import type { BackendConfig } from "./config";
import type { BackendHandlers, VaultProvisioningResult } from "./server";
import {
  provisionFreshVault,
  type FreshVaultProvisioner,
  type ReviewedDeploymentEvidence,
  type SafeExecutionRequest,
} from "./vault";
import { challengeForDigest, verifyPasskeyAssertion, type BackendPasskeyRole, type StoredCredential, type VerifiedPasskeyApproval } from "./webauthn";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import type { Address, Hex } from "viem";

export type BackendVaultRecord = Readonly<VaultProvisioningResult & {
  primaryCredentialId: string;
  secondaryCredentialId: string;
}>;

export type BackendTransferIntent = Readonly<{ recipient: unknown; amount: unknown; idempotencyKey: unknown }>;
export type BackendPreparation = (input: Readonly<{ vault: BackendVaultRecord; request: BackendTransferIntent }>) => Promise<SafeExecutionRequest>;
export type BackendSubmission = (input: Readonly<{ vault: BackendVaultRecord; id: string; body: unknown }>) => Promise<unknown>;
export type BackendSubmissionReader = (input: Readonly<{ vault: BackendVaultRecord; id: string }>) => unknown;

export type BackendHandlerOptions = Readonly<{
  config: BackendConfig;
  artifacts: ReviewedDeploymentEvidence;
  usdc: Address;
  provisioner: FreshVaultProvisioner;
  prepareTransfer?: BackendPreparation;
  submit?: BackendSubmission;
  submission?: BackendSubmissionReader;
  verifyAssertion?: typeof verifyPasskeyAssertion;
}>;

type ProvisioningInput = Readonly<{
  chainId?: unknown;
  usdc?: unknown;
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
  prepareTransfer: (body: unknown) => Promise<SafeExecutionRequest>;
  submit: (id: string, body: unknown) => Promise<unknown>;
  submission: (id: string) => unknown;
  storeCredential: (credential: StoredCredential & Readonly<{ role: BackendPasskeyRole; credentialId: string }>) => void;
  verifyApproval: (safeTxHash: Hex, body: unknown) => Promise<VerifiedPasskeyApproval>;
  vaultRecord: () => BackendVaultRecord | undefined;
}>;

export function createBackendHandlers(options: BackendHandlerOptions): BackendHandlerSet {
  const credentials = new Map<BackendPasskeyRole, StoredCredential & Readonly<{ role: BackendPasskeyRole; credentialId: string }>>();
  let vault: BackendVaultRecord | undefined;

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

  const provisionVault = async (input: unknown): Promise<VaultProvisioningResult> => {
    const body = record(input, "vault request") as ProvisioningInput;
    if (body.chainId !== options.config.chainId) throw new Error("only Sepolia vault provisioning is supported");
    const primaryCredentialId = stringField(body.primaryCredentialId, "primary credential ID");
    const secondaryCredentialId = stringField(body.secondaryCredentialId, "secondary credential ID");
    if (credentials.get("primary")?.id !== primaryCredentialId || credentials.get("secondary")?.id !== secondaryCredentialId) throw new Error("verified primary and secondary credentials are required");
    const result = await provisionFreshVault({
      chainId: options.config.chainId,
      usdc: options.usdc,
      primaryCredentialId,
      secondaryCredentialId,
      relayPrivateKey: options.config.relayPrivateKey,
      artifacts: options.artifacts,
      provisioner: options.provisioner,
    });
    vault = Object.freeze({ ...result, primaryCredentialId, secondaryCredentialId });
    return result;
  };

  const requireVault = (): BackendVaultRecord => {
    if (!vault) throw new Error("vault is not provisioned");
    return vault;
  };

  const prepareTransfer = async (input: unknown): Promise<SafeExecutionRequest> => {
    if (!options.prepareTransfer) throw new Error("submission preparation unavailable");
    const request = record(input, "transfer request");
    const intent: BackendTransferIntent = { recipient: request.recipient, amount: request.amount, idempotencyKey: request.idempotencyKey };
    const prepared = await options.prepareTransfer({ vault: requireVault(), request: intent });
    if (prepared.chainId !== options.config.chainId || prepared.safe.toLowerCase() !== requireVault().safe.toLowerCase() || prepared.asset.toLowerCase() !== requireVault().usdc.toLowerCase()) throw new Error("prepared request does not match the server-held vault");
    return prepared;
  };

  const submit = async (id: string, body: unknown): Promise<unknown> => {
    if (!options.submit) throw new Error("submission unavailable");
    return options.submit({ vault: requireVault(), id, body });
  };

  const submission = (id: string): unknown => {
    if (!options.submission) throw new Error("submission unavailable");
    return options.submission({ vault: requireVault(), id });
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

  return Object.freeze({ provisionVault, prepareTransfer, submit, submission, storeCredential, verifyApproval, vaultRecord: () => vault });
}
