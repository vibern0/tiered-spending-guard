import type { BackendConfig } from "./config";
import type { BackendHandlers, VaultProvisioningResult } from "./server";
import {
  provisionFreshVault,
  type FreshVaultProvisioner,
  type ReviewedDeploymentEvidence,
  type SafeExecutionRequest,
} from "./vault";
import type { BackendPasskeyRole, StoredCredential } from "./webauthn";
import type { Address } from "viem";

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
  vaultRecord: () => BackendVaultRecord | undefined;
}>;

export function createBackendHandlers(options: BackendHandlerOptions): BackendHandlerSet {
  const credentials = new Map<BackendPasskeyRole, StoredCredential & Readonly<{ role: BackendPasskeyRole; credentialId: string }>>();
  let vault: BackendVaultRecord | undefined;

  const storeCredential = (credential: StoredCredential & Readonly<{ role: BackendPasskeyRole; credentialId: string }>): void => {
    const passkeyRole = role(credential.role);
    if (!credential.id || credential.id !== credential.credentialId) throw new Error("credential metadata is not self-consistent");
    const existing = credentials.get(passkeyRole);
    if (existing && existing.id !== credential.id) throw new Error(`${passkeyRole} credential is already registered`);
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

  return Object.freeze({ provisionVault, prepareTransfer, submit, submission, storeCredential, vaultRecord: () => vault });
}
