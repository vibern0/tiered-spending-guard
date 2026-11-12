import type { BackendConfig } from "./config";
import type { BackendHandlers, VaultProvisioningResult } from "./server";
import { type BackendPreparedSubmission } from "./vault";
import type { AutomaticPwaProvisioner } from "./provisioner";
import {
  challengeForDigest,
  encodeP256CosePublicKey,
  verifyPasskeyAssertion,
  type BackendPasskeyRole,
  type StoredCredential,
  type VerifiedPasskeyApproval,
} from "./webauthn";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import type { Address, Hex } from "viem";
import type {
  PwaProvisioningPlan,
  PwaProvisioningResult,
} from "@tiered-spending-guard/security-core/pwa";

export type CredentialRebindStatus = Readonly<{
  required: boolean;
  primary: "required" | "ready";
  secondary: "required" | "ready";
}>;

export type BackendVaultRecord = Readonly<
  Omit<VaultProvisioningResult, "credentialRebind"> & {
    primaryCredentialId: string;
    secondaryCredentialId: string;
    verifiedProvisioning: PwaProvisioningResult;
    provisioningPlan?: PwaProvisioningPlan;
  }
>;

export type BackendIntent =
  | Readonly<{ kind: "transfer"; recipient: unknown; amount: unknown; idempotencyKey: unknown }>
  | Readonly<{ kind: "add-recipient"; recipient: unknown; idempotencyKey: unknown }>
  | Readonly<{
      kind: "cancel-queued" | "execute-ready" | "skip-expired";
      queueNonce: unknown;
      queueFingerprint: unknown;
      idempotencyKey: unknown;
    }>;
export type BackendPreparation = (
  input: Readonly<{ vault: BackendVaultRecord; request: BackendIntent }>,
) => Promise<BackendPreparedSubmission>;
export type BackendSubmission = (
  input: Readonly<{ vault: BackendVaultRecord; id: string; body: unknown }>,
) => Promise<unknown>;
export type BackendSubmissionReader = (
  input: Readonly<{ vault: BackendVaultRecord; id: string }>,
) => Promise<unknown>;

export type BackendHandlerOptions = Readonly<{
  config: BackendConfig;
  usdc: Address;
  provisioner: AutomaticPwaProvisioner;
  prepareTransfer?: BackendPreparation;
  submit?: BackendSubmission;
  submission?: BackendSubmissionReader;
  verifyAssertion?: typeof verifyPasskeyAssertion;
  actionSpecificApprovals?: true;
  credentialStore?: Readonly<{
    get(role: BackendPasskeyRole): StoredCredential | undefined;
    updateCounter(
      credential: StoredCredential,
      next: number,
      approval: VerifiedPasskeyApproval,
      safeTxHash: Hex,
    ): void;
    learn(credential: StoredCredential, approval: VerifiedPasskeyApproval, safeTxHash: Hex): void;
  }>;
}>;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function role(value: unknown): BackendPasskeyRole {
  if (value !== "primary" && value !== "secondary") throw new Error("unsupported passkey role");
  return value;
}

export type BackendHandlerSet = Omit<BackendHandlers, "prepareTransfer" | "submit" | "submission"> &
  Readonly<{
    prepareTransfer: (body: unknown) => Promise<BackendPreparedSubmission>;
    submit: (id: string, body: unknown) => Promise<unknown>;
    submission: (id: string) => Promise<unknown>;
    storeCredential: (
      credential: StoredCredential & Readonly<{ role: BackendPasskeyRole; credentialId: string }>,
    ) => void;
    verifyApproval: (safeTxHash: Hex, body: unknown) => Promise<VerifiedPasskeyApproval>;
    rebindCoordinates: (role: BackendPasskeyRole) => Readonly<{ x: bigint; y: bigint }>;
    storeReboundCredential: (
      credential: StoredCredential & Readonly<{ role: BackendPasskeyRole; credentialId: string }>,
    ) => CredentialRebindStatus;
    credentialRebindStatus: () => CredentialRebindStatus;
    vaultRecord: () => BackendVaultRecord | undefined;
  }>;

export function createBackendHandlers(options: BackendHandlerOptions): BackendHandlerSet {
  const credentials = new Map<
    BackendPasskeyRole,
    StoredCredential & Readonly<{ role: BackendPasskeyRole; credentialId: string }>
  >();
  const currentCredential = (role: BackendPasskeyRole) => {
    const c = options.credentialStore ? options.credentialStore.get(role) : credentials.get(role);
    return c && { ...c, credentialId: c.id };
  };
  let vault: BackendVaultRecord | undefined;
  let publicVaultBase: Omit<VaultProvisioningResult, "credentialRebind"> | undefined;
  let provisioning: Promise<VaultProvisioningResult> | undefined;
  const getRecoveryCredentials = () => options.provisioner.recoveryCredentials;
  const historicalVault = options.provisioner.historicalVault;
  const requireWritable = () => {
    if (historicalVault)
      throw new Error(
        "historical vault is read-only; transfers and credential changes are disabled",
      );
  };

  const credentialRebindStatus = (): CredentialRebindStatus => {
    const matches = (role: BackendPasskeyRole) => {
      const actual = currentCredential(role),
        expected = getRecoveryCredentials()?.[role];
      return (
        actual !== undefined && (!expected || (actual.x === expected.x && actual.y === expected.y))
      );
    };
    const primary = matches("primary") ? ("ready" as const) : ("required" as const);
    const secondary = matches("secondary") ? ("ready" as const) : ("required" as const);
    return Object.freeze({
      required:
        getRecoveryCredentials() !== undefined &&
        (primary === "required" || (!options.actionSpecificApprovals && secondary === "required")),
      primary,
      secondary,
    });
  };

  const getReadiness = () =>
    Object.freeze({
      provisioningReady: !historicalVault && options.config.id === "local",
      writesReady:
        !historicalVault &&
        Boolean(
          vault &&
          options.prepareTransfer &&
          options.submit &&
          options.submission &&
          credentialRebindStatus().primary === "ready" &&
          (options.actionSpecificApprovals || credentialRebindStatus().secondary === "ready"),
        ),
    });

  const publicResult = (): VaultProvisioningResult => {
    if (!publicVaultBase) throw new Error("vault is not provisioned");
    return Object.freeze({ ...publicVaultBase, credentialRebind: credentialRebindStatus() });
  };

  const storeCredential = (
    credential: StoredCredential & Readonly<{ role: BackendPasskeyRole; credentialId: string }>,
  ): void => {
    requireWritable();
    const passkeyRole = role(credential.role);
    if (!credential.id || credential.id !== credential.credentialId)
      throw new Error("credential metadata is not self-consistent");
    const recovered = getRecoveryCredentials()?.[passkeyRole];
    if (recovered && (credential.x !== recovered.x || credential.y !== recovered.y))
      throw new Error("credential does not match the recovered role key");
    const existing = credentials.get(passkeyRole);
    if (existing) throw new Error(`${passkeyRole} credential is already registered`);
    for (const [existingRole, current] of credentials) {
      if (
        existingRole !== passkeyRole &&
        (current.id === credential.id ||
          Buffer.from(current.publicKey).equals(Buffer.from(credential.publicKey)) ||
          (current.x === credential.x && current.y === credential.y))
      ) {
        throw new Error("primary and secondary credentials must be distinct");
      }
    }
    credentials.set(passkeyRole, Object.freeze({ ...credential, role: passkeyRole }));
  };

  const autoProvisionVault = (input: unknown): Promise<VaultProvisioningResult> => {
    if (historicalVault)
      return Promise.reject(
        new Error("historical vault is read-only; current-profile provisioning is disabled"),
      );
    const body = record(input, "automatic vault provisioning request");
    if (Object.keys(body).length !== 0)
      return Promise.reject(
        new Error("automatic vault provisioning body contains an unsupported field"),
      );
    if (options.config.id !== "local")
      return Promise.reject(
        new Error("automatic vault provisioning is available only in the local profile"),
      );
    if (publicVaultBase) return Promise.resolve(publicResult());
    if (provisioning) return provisioning;
    const primary = currentCredential("primary");
    const secondary = currentCredential("secondary");
    const recoveryCredentials = getRecoveryCredentials();
    if (recoveryCredentials) {
      if (
        primary &&
        (primary.x !== recoveryCredentials.primary.x || primary.y !== recoveryCredentials.primary.y)
      )
        return Promise.reject(
          new Error("registered primary credential does not match the recovered role key"),
        );
      if (
        secondary &&
        (secondary.x !== recoveryCredentials.secondary.x ||
          secondary.y !== recoveryCredentials.secondary.y)
      )
        return Promise.reject(
          new Error("registered secondary credential does not match the recovered role key"),
        );
    }
    const operation = options.provisioner
      .provision(primary && secondary ? { primary, secondary } : undefined)
      .then((completed) => {
        const recovered = getRecoveryCredentials();
        const currentPrimary = currentCredential("primary"),
          currentSecondary = currentCredential("secondary");
        if (
          recovered &&
          ((currentPrimary &&
            (currentPrimary.x !== recovered.primary.x ||
              currentPrimary.y !== recovered.primary.y)) ||
            (currentSecondary &&
              (currentSecondary.x !== recovered.secondary.x ||
                currentSecondary.y !== recovered.secondary.y)))
        )
          throw new Error("registered credentials do not match the recovered role keys");
        if (
          completed.response.chainId !== options.config.chainId ||
          completed.response.usdc.toLowerCase() !== options.usdc.toLowerCase()
        )
          throw new Error("verified provisioning result does not match backend identity");
        vault = Object.freeze({
          ...completed.response,
          primaryCredentialId: currentPrimary?.id ?? "",
          secondaryCredentialId: currentSecondary?.id ?? "",
          verifiedProvisioning: completed.verified,
          ...(completed.plan ? { provisioningPlan: completed.plan } : {}),
        });
        publicVaultBase = completed.response;
        return publicResult();
      });
    provisioning = operation;
    void operation
      .finally(() => {
        if (!vault) provisioning = undefined;
      })
      .catch(() => undefined);
    return operation;
  };

  const requireVault = (): BackendVaultRecord => {
    if (!vault) throw new Error("vault is not provisioned");
    return vault;
  };

  const requireReadyVault = (): BackendVaultRecord => {
    requireWritable();
    const current = requireVault();
    const status = credentialRebindStatus();
    if (
      status.primary !== "ready" ||
      (!options.actionSpecificApprovals && status.secondary !== "ready")
    )
      throw new Error("both recovered passkeys must be rebound before spending or reconciliation");
    return current;
  };

  const rebindCoordinates = (
    passkeyRole: BackendPasskeyRole,
  ): Readonly<{ x: bigint; y: bigint }> => {
    requireWritable();
    role(passkeyRole);
    const normalized = passkeyRole;
    requireVault();
    const recoveryCredentials = getRecoveryCredentials();
    if (options.config.id !== "local" || !recoveryCredentials)
      throw new Error("credential rebind is unavailable");
    if (credentials.has(normalized)) throw new Error(`${normalized} credential is already ready`);
    return recoveryCredentials[normalized];
  };

  const storeReboundCredential = (
    credential: StoredCredential & Readonly<{ role: BackendPasskeyRole; credentialId: string }>,
  ): CredentialRebindStatus => {
    const expected = rebindCoordinates(credential.role);
    if (credential.x !== expected.x || credential.y !== expected.y)
      throw new Error("rebound credential does not match the reviewed role key");
    storeCredential(credential);
    if (vault)
      vault = Object.freeze({
        ...vault,
        ...(credential.role === "primary"
          ? { primaryCredentialId: credential.id }
          : { secondaryCredentialId: credential.id }),
      });
    return credentialRebindStatus();
  };

  const prepareTransfer = async (input: unknown): Promise<BackendPreparedSubmission> => {
    requireWritable();
    if (!options.prepareTransfer) throw new Error("submission preparation unavailable");
    const request = record(input, "transfer request");
    const kind = request.kind;
    const expected =
      kind === "transfer"
        ? ["kind", "recipient", "amount", "idempotencyKey"]
        : kind === "add-recipient"
          ? ["kind", "recipient", "idempotencyKey"]
          : ["kind", "queueNonce", "queueFingerprint", "idempotencyKey"];
    if (
      !["transfer", "add-recipient", "cancel-queued", "execute-ready", "skip-expired"].includes(
        String(kind),
      ) ||
      Object.keys(request).length !== expected.length ||
      Object.keys(request).some((key) => !expected.includes(key))
    )
      throw new Error("submission preparation body contains an unsupported field");
    const intent = (
      kind === "transfer"
        ? {
            kind,
            recipient: request.recipient,
            amount: request.amount,
            idempotencyKey: request.idempotencyKey,
          }
        : kind === "add-recipient"
          ? { kind, recipient: request.recipient, idempotencyKey: request.idempotencyKey }
          : {
              kind,
              queueNonce: request.queueNonce,
              queueFingerprint: request.queueFingerprint,
              idempotencyKey: request.idempotencyKey,
            }
    ) as BackendIntent;
    const prepared = await options.prepareTransfer({ vault: requireReadyVault(), request: intent });
    if (
      prepared.id !== request.idempotencyKey ||
      prepared.publicRequest.kind !== kind ||
      prepared.publicRequest.idempotencyKey !== request.idempotencyKey
    )
      throw new Error("prepared request does not match the server-held intent");
    return prepared;
  };

  const submit = async (id: string, body: unknown): Promise<unknown> => {
    requireWritable();
    if (!options.submit) throw new Error("submission unavailable");
    return options.submit({ vault: requireReadyVault(), id, body });
  };

  const submission = async (id: string): Promise<unknown> => {
    requireWritable();
    if (!options.submission) throw new Error("submission unavailable");
    return await options.submission({ vault: requireReadyVault(), id });
  };

  const verifyApproval = async (
    safeTxHash: Hex,
    input: unknown,
  ): Promise<VerifiedPasskeyApproval> => {
    requireWritable();
    if (!/^0x[0-9a-fA-F]{64}$/.test(safeTxHash))
      throw new Error("server-held Safe transaction hash is invalid");
    const body = record(input, "passkey approval");
    const passkeyRole = role(body.role);
    const assertion = record(
      body.assertion,
      "passkey assertion",
    ) as unknown as AuthenticationResponseJSON;
    requireReadyVault();
    let stored = currentCredential(passkeyRole);
    const expected = getRecoveryCredentials()?.[passkeyRole];
    const learned = !stored && options.actionSpecificApprovals && expected;
    if (learned)
      stored = {
        role: passkeyRole,
        id: assertion.id,
        credentialId: assertion.id,
        publicKey: encodeP256CosePublicKey(expected!),
        counter: 0,
        ...expected!,
      };
    if (stored && expected && (stored.x !== expected.x || stored.y !== expected.y))
      throw new Error("credential does not match the reviewed role key");
    if (!stored) throw new Error(`${passkeyRole} credential is not registered`);
    const currentVault = requireReadyVault();
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
    if (
      approval.role !== passkeyRole ||
      approval.credentialId !== stored.id ||
      approval.counter < stored.counter
    )
      throw new Error("verified passkey approval does not match stored credential metadata");
    if (learned) options.credentialStore?.learn(stored, approval, safeTxHash);
    else options.credentialStore?.updateCounter(stored, approval.counter, approval, safeTxHash);
    credentials.set(passkeyRole, Object.freeze({ ...stored, counter: approval.counter }));
    if (vault && learned)
      vault = Object.freeze({
        ...vault,
        ...(passkeyRole === "primary"
          ? { primaryCredentialId: stored.id }
          : { secondaryCredentialId: stored.id }),
      });
    return approval;
  };

  return Object.freeze({
    autoProvisionVault,
    prepareTransfer,
    submit,
    submission,
    storeCredential,
    verifyApproval,
    rebindCoordinates,
    storeReboundCredential,
    credentialRebindStatus,
    vaultRecord: () => vault,
    getReadiness,
    ...(historicalVault ? { historicalVault } : {}),
    currentVault: () => historicalVault ?? (publicVaultBase ? publicResult() : undefined),
  });
}
