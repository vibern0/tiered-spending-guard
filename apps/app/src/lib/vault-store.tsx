import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { AuthenticationResponseJSON } from "@simplewebauthn/browser";
import {
  createPublicClient,
  decodeFunctionData,
  http,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { sepolia } from "viem/chains";
import { usdc } from "./usdc";
import { effectiveStatus, fingerprintOf, type ActivityItem, type Lane } from "./activity-model";
import {
  readVaultSnapshot,
  type HealthFailure,
  type VaultConfig,
  type VaultSnapshot,
} from "./vault-chain";
import {
  challengeForSafeDigest,
  createVaultPasskey,
  rebindPasskey as performPasskeyRebind,
  signSafeDigest,
  type PasskeyRegistration,
} from "./webauthn-passkey";
import { loadWalletEnvironmentProfile, type WalletEnvironmentProfile } from "./environment-profile";
import { runWalletCriticalFlow } from "./pwa";
import { BackendRequestError } from "./provisioning-errors";

export type Recipient = { name: string; address: string };
export type Policy = {
  basePerTxCap: bigint;
  firstSignerDaily: bigint;
  instantDaily: bigint;
  perTxCap: bigint;
  delayHours: number;
  delaySeconds: bigint;
};
export type Onboarding = {
  firstSigner: boolean;
  secondSigner: boolean;
  limits: boolean;
  rehearsed: boolean;
};

export type VaultState = {
  chainId: number;
  network: string;
  safe: string;
  guard: string;
  delay: string;
  usdc: string;
  balance: bigint;
  nativeBalance: bigint;
  safeNonce: bigint | null;
  policy: Policy;
  spentFirstSigner: bigint;
  spentInstant: bigint;
  resetsAt: number;
  secondSignerName: string;
  frozen: boolean;
  writable: boolean;
  health: readonly HealthFailure[];
  onboarding: Onboarding;
  recipients: Recipient[];
  activity: ActivityItem[];
  notifications: { email: boolean; push: boolean };
  deploymentHash: Hex;
  policyHash: Hex;
};

export type VaultProvisioningResult = Readonly<{
  chainId: 11155111;
  safe: Address;
  guard: Address;
  delay: Address;
  primaryPasskey: Address;
  secondaryPasskey: Address;
  usdc: Address;
  evidence: Readonly<{
    setupTransactionHash: `0x${string}`;
    verificationReportHash: `0x${string}`;
  }>;
  credentialRebind?: CredentialRebindStatus;
}>;

export type CredentialRebindStatus = Readonly<{
  required: boolean;
  primary: "required" | "ready";
  secondary: "required" | "ready";
}>;

export type BackendRegistrationOptions = Readonly<{
  sessionId: string;
  challenge: string;
  rpId: string;
  origin: string;
  role: "primary" | "secondary";
  userVerification: "required";
  authenticatorAttachment: "platform" | "cross-platform";
}>;

export type BackendRebindOptions = Readonly<{
  sessionId: string;
  challenge: string;
  rpId: string;
  origin: string;
  role: "primary" | "secondary";
  userVerification: "required";
}>;

export type PreparedSubmission = Readonly<{
  id: string;
  requestHash: Hex;
  safeTxHash?: Hex;
  kind:
    | "base-transfer"
    | "step-up-transfer"
    | "queue-transfer"
    | "cancel-queued"
    | "execute-ready"
    | "skip-expired";
  requiredApprovals: readonly ("primary" | "secondary")[];
  publicRequest: Readonly<Record<string, unknown>>;
}>;
export type SubmissionStatus = Readonly<{
  id: string;
  state:
    | "prepared"
    | "awaiting-primary"
    | "awaiting-secondary"
    | "submitting"
    | "uncertain"
    | "confirmed"
    | "reverted"
    | "superseded";
  kind?: string;
  requestHash?: Hex;
  requiredApprovals?: readonly ("primary" | "secondary")[];
  approvals?: Readonly<{ primary: boolean; secondary: boolean }>;
  transactionHash?: Hex;
  receipt?: Readonly<{ transactionHash: Hex; blockNumber: bigint; blockHash: Hex }>;
}>;
export type SubmissionIntent =
  | Readonly<{ kind: "transfer"; recipient: Address; amount: bigint; idempotencyKey: string }>
  | Readonly<{
      kind: "cancel-queued" | "execute-ready" | "skip-expired";
      queueNonce: bigint;
      queueFingerprint: Hex;
      idempotencyKey: string;
    }>;

export type VaultBackend = Readonly<{
  health?: () => Promise<void>;
  registerPasskey: (role: "primary" | "secondary") => Promise<PasskeyRegistration>;
  autoProvisionVault: () => Promise<VaultProvisioningResult>;
  rebindPasskey?: (role: "primary" | "secondary", credentialId: string) => Promise<CredentialRebindStatus>;
  prepareIntent: (input: SubmissionIntent) => Promise<PreparedSubmission>;
  submit: (
    id: string,
    body:
      | Readonly<{ role: "primary" | "secondary"; assertion: AuthenticationResponseJSON }>
      | Readonly<{ role: "none" }>,
  ) => Promise<SubmissionStatus>;
  submission: (id: string) => Promise<SubmissionStatus>;
}>;

export type PreparedTransferInput = Readonly<{
  chainId: 11155111;
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
  expectedSpend: Readonly<{ window: bigint; baseSpent: bigint; instantSpent: bigint }>;
  allowedRecipients: readonly Address[];
}>;
export type SafeExecutionRequest = Readonly<{
  idempotencyKey: Hex;
  safeTxHash: Hex;
  safe: Address;
  chainId: 11155111;
  transaction: Readonly<{ to: Address; value: bigint; data: Hex; operation: 0; nonce: bigint }>;
  requiredApprovals?: "primary" | "secondary" | "delayed";
}>;
export type VaultProviderProps = {
  children: ReactNode;
  client?: PublicClient;
  config?: VaultConfig;
  backend?: VaultBackend;
};

type StorageProfile = Pick<WalletEnvironmentProfile, "id" | "rpId">;
export const walletStorageKey = (kind: "config" | "ui", profile: StorageProfile) =>
  `usdc-vault-${kind}-v2:${profile.id}:${profile.rpId}`;
const DEFAULT_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Address;
const ERC20_TRANSFER_ABI = parseAbi(["function transfer(address,uint256) returns (bool)"]);
const nextReset = () => {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
};
const randAddr = () =>
  "0x" +
  Array.from({ length: 40 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
const unprovisionedHealth: readonly HealthFailure[] = [
  {
    code: "unprovisioned",
    message: "Provision a fresh guarded Safe before using this wallet",
    blocking: true,
  },
];

export function emptyState(): VaultState {
  return {
    chainId: 11155111,
    network: "Ethereum Sepolia (testnet)",
    safe: "",
    guard: "",
    delay: "",
    usdc: "",
    balance: 0n,
    nativeBalance: 0n,
    safeNonce: null,
    policy: {
      basePerTxCap: usdc(1),
      firstSignerDaily: usdc(1),
      instantDaily: usdc(3),
      perTxCap: usdc(3),
      delayHours: 1,
      delaySeconds: 120n,
    },
    spentFirstSigner: 0n,
    spentInstant: 0n,
    resetsAt: nextReset(),
    secondSignerName: "Second signer",
    frozen: false,
    writable: false,
    health: unprovisionedHealth,
    onboarding: { firstSigner: false, secondSigner: false, limits: false, rehearsed: false },
    recipients: [],
    activity: [],
    notifications: { email: true, push: false },
    deploymentHash: "0x",
    policyHash: "0x",
  };
}

/** Compatibility fixture retained for unit tests; production screens never load simulated balances. */
export function demoState(): VaultState {
  const s = emptyState();
  const now = Date.now();
  const address = randAddr();
  const item: ActivityItem = {
    id: crypto.randomUUID(),
    direction: "in",
    amount: usdc(100),
    counterparty: "Test USDC",
    address,
    lane: "base",
    status: "executed",
    createdAt: now,
    approvers: [],
    fingerprint: fingerprintOf([address, now]),
  };
  return { ...s, balance: usdc(100), activity: [item] };
}

export type WalletSetupState = Readonly<{
  primaryCredentialId?: string | undefined;
  secondaryCredentialId?: string | undefined;
  secondaryAuthenticator?: "platform" | "cross-platform" | undefined;
  distinctSecondary: boolean;
  provisioning: "registering" | "provisioning" | "failed" | "provisioned";
  credentialRebind: CredentialRebindStatus;
  receiptHash?: Hex | undefined;
  submissionIds: readonly string[];
}>;
type UiState = {
  notifications: VaultState["notifications"];
  rehearsed: boolean;
  primaryCredentialId?: string | undefined;
  secondaryCredentialId?: string | undefined;
  secondaryAuthenticator?: "platform" | "cross-platform" | undefined;
  provisioning: WalletSetupState["provisioning"];
  credentialRebind: CredentialRebindStatus;
  receiptHash?: Hex | undefined;
  submissionIds: string[];
  deploymentHash?: Hex | undefined;
  policyHash?: Hex | undefined;
};

const readyCredentialRebind = (): CredentialRebindStatus => ({ required: false, primary: "ready", secondary: "ready" });

function storedCredentialRebind(value: unknown): CredentialRebindStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return readyCredentialRebind();
  const input = value as Record<string, unknown>;
  if (typeof input["required"] !== "boolean" || !["required", "ready"].includes(String(input["primary"])) || !["required", "ready"].includes(String(input["secondary"]))) return readyCredentialRebind();
  return { required: input["required"], primary: input["primary"] as "required" | "ready", secondary: input["secondary"] as "required" | "ready" };
}

function readUiState(profile: StorageProfile): UiState {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(walletStorageKey("ui", profile)) ?? "null",
    ) as Partial<UiState> | null;
    return {
      notifications: parsed?.notifications ?? { email: true, push: false },
      rehearsed: parsed?.rehearsed === true,
      primaryCredentialId: parsed?.primaryCredentialId,
      secondaryCredentialId: parsed?.secondaryCredentialId,
      secondaryAuthenticator: parsed?.secondaryAuthenticator,
      credentialRebind: storedCredentialRebind(parsed?.credentialRebind),
      provisioning: parsed?.provisioning === "provisioning"
        ? "failed"
        : ["registering", "failed", "provisioned"].includes(String(parsed?.provisioning))
          ? parsed!.provisioning as WalletSetupState["provisioning"]
          : parsed?.primaryCredentialId && parsed?.secondaryCredentialId ? "failed" : "registering",
      receiptHash: parsed?.receiptHash,
      submissionIds: Array.isArray(parsed?.submissionIds)
        ? parsed.submissionIds.filter((id): id is string => typeof id === "string")
        : [],
      deploymentHash: parsed?.deploymentHash,
      policyHash: parsed?.policyHash,
    };
  } catch {
    return {
      notifications: { email: true, push: false },
      rehearsed: false,
      provisioning: "registering",
      credentialRebind: readyCredentialRebind(),
      submissionIds: [],
    };
  }
}

function readConfig(profile: StorageProfile): VaultConfig | undefined {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(walletStorageKey("config", profile)) ?? "null",
    ) as Partial<Record<keyof VaultConfig, string>> | null;
    if (!parsed || !parsed.safe || !parsed.guard || !parsed.delay || !parsed.usdc) return undefined;
    if (
      ![parsed.safe, parsed.guard, parsed.delay, parsed.usdc].every(
        (value) => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value),
      )
    )
      return undefined;
    return {
      chainId: 11155111,
      safe: parsed.safe as Address,
      guard: parsed.guard as Address,
      delay: parsed.delay as Address,
      usdc: parsed.usdc as Address,
      usdcCandidates: [DEFAULT_USDC],
    };
  } catch {
    return undefined;
  }
}

function saveConfig(profile: StorageProfile, config: VaultConfig): void {
  localStorage.setItem(
    walletStorageKey("config", profile),
    JSON.stringify({
      chainId: config.chainId,
      safe: config.safe,
      guard: config.guard,
      delay: config.delay,
      usdc: config.usdc,
      usdcCandidates: config.usdcCandidates,
    }),
  );
}

function saveUiState(profile: StorageProfile, state: UiState): void {
  localStorage.setItem(walletStorageKey("ui", profile), JSON.stringify(state));
}

function defaultClient(): PublicClient | undefined {
  const rpcUrl = (import.meta.env["VITE_SEPOLIA_RPC_URL"] as string | undefined)?.trim();
  return rpcUrl ? createPublicClient({ chain: sepolia, batch: { multicall: { wait: 10 } }, transport: http(rpcUrl) }) : undefined;
}

export async function checkBackendHealth(
  profile: WalletEnvironmentProfile,
  requester: typeof fetch = fetch,
): Promise<void> {
  const response = await requester(`${profile.backendOrigin}/health`, {
    headers: { accept: "application/json" },
    credentials: profile.credentials,
  });
  let payload: {
    ok?: unknown;
    error?: unknown;
    chainId?: unknown;
    profileId?: unknown;
    origin?: unknown;
    rpId?: unknown;
  } = {};
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    /* bounded error below */
  }
  if (!response.ok || payload.ok !== true)
    throw new Error(
      `Backend health check failed: ${typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`}`,
    );
  if (
    payload.chainId !== profile.chainId ||
    payload.profileId !== profile.id ||
    payload.origin !== profile.appOrigin ||
    payload.rpId !== profile.rpId
  )
    throw new Error("Backend health profile does not match the active wallet environment");
}

function activeEnvironmentProfile(): WalletEnvironmentProfile {
  const configuredOrigin =
    (import.meta.env["VITE_APP_ORIGIN"] as string | undefined)?.trim() || "http://localhost:5173";
  const observedOrigin =
    typeof window === "undefined" || window.location.origin === "null"
      ? configuredOrigin
      : window.location.origin;
  return loadWalletEnvironmentProfile(import.meta.env, observedOrigin);
}

function activeStorageProfile(): StorageProfile {
  const profile = activeEnvironmentProfile();
  return { id: profile.id, rpId: profile.rpId };
}

function defaultBackend(): VaultBackend {
  const json = async <T,>(url: string, init?: RequestInit): Promise<T> => {
    const profile = activeEnvironmentProfile();
    const response = await fetch(`${profile.backendOrigin}${url}`, {
      ...init,
      credentials: profile.credentials,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    const payload = JSON.parse(await response.text(), (key, value) =>
      [
        "amount",
        "nonce",
        "window",
        "baseSpent",
        "instantSpent",
        "safeTxGas",
        "baseGas",
        "gasPrice",
        "queueNonce",
        "blockNumber",
      ].includes(key) &&
      typeof value === "string" &&
      /^\d+n$/.test(value)
        ? BigInt(value.slice(0, -1))
        : value,
    ) as unknown;
    const error =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : undefined;
    if (!response.ok) {
      const details = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
      const backendError = new BackendRequestError({
        status: response.status,
        message: error ?? `Backend request failed (${response.status})`,
        ...(typeof details["code"] === "string" ? { code: details["code"] } : {}),
        ...(typeof details["stage"] === "string" ? { stage: details["stage"] } : {}),
        ...(typeof details["requestId"] === "string" ? { requestId: details["requestId"] } : response.headers.get("x-request-id") ? { requestId: response.headers.get("x-request-id")! } : {}),
      });
      console.error("Vault backend request failed", {
        status: backendError.status,
        code: backendError.code,
        stage: backendError.stage,
        requestId: backendError.requestId,
        path: url,
        message: backendError.message,
      });
      throw backendError;
    }
    return payload as T;
  };
  return {
    async health() {
      await checkBackendHealth(activeEnvironmentProfile());
    },
    async registerPasskey(role) {
      const profile = activeEnvironmentProfile();
      const options = (await json(`/v1/registrations/${role}/options`, {
        method: "POST",
        body: "{}",
      })) as BackendRegistrationOptions;
      if (
        options.role !== role ||
        options.origin !== profile.appOrigin ||
        options.rpId !== profile.rpId
      )
        throw new Error(
          "Backend registration profile does not match the active wallet environment",
        );
      const registrationOptions = {
        challenge: options.challenge,
        rp: { id: options.rpId, name: "USDC Vault Demo" },
        user: {
          id: `${role}-${options.sessionId}`,
          name: `${role}@${profile.rpId}`,
          displayName: role === "primary" ? "First signer" : "Second signer",
        },
        pubKeyCredParams: [{ alg: -7, type: "public-key" }],
        authenticatorSelection: {
          authenticatorAttachment: options.authenticatorAttachment,
          userVerification: "required",
          residentKey: "preferred",
        },
        timeout: 60_000,
        attestation: "none",
      };
      const registration = await createVaultPasskey({
        role,
        challenge: options.challenge,
        rpId: options.rpId,
        origin: options.origin,
        options: registrationOptions,
      });
      await json(`/v1/registrations/${role}/verify`, {
        method: "POST",
        body: JSON.stringify({ sessionId: options.sessionId, registration: registration.response }),
      });
      return registration;
    },
    async autoProvisionVault() {
      return json("/v1/vaults/auto-provision", {
        method: "POST",
        body: "{}",
      }) as Promise<VaultProvisioningResult>;
    },
    async rebindPasskey(role, credentialId) {
      const profile = activeEnvironmentProfile();
      const options = await json<BackendRebindOptions>(`/v1/credentials/${role}/rebind/options`, { method: "POST", body: "{}" });
      if (options.role !== role || options.origin !== profile.appOrigin || options.rpId !== profile.rpId || options.userVerification !== "required") throw new Error("Backend rebind profile does not match the active wallet environment");
      const assertion = await performPasskeyRebind(options, credentialId);
      const verified = await json<{ role: "primary" | "secondary"; credentialId: string; credentialRebind: CredentialRebindStatus }>(`/v1/credentials/${role}/rebind/verify`, {
        method: "POST",
        body: JSON.stringify({ sessionId: options.sessionId, assertion }),
      });
      if (verified.role !== role || verified.credentialId !== credentialId) throw new Error("Backend rebind result does not match the stored credential");
      return verified.credentialRebind;
    },
    async prepareIntent(input) {
      return json("/v1/submissions/prepare", {
        method: "POST",
        body: JSON.stringify(input, (_key, value) =>
          typeof value === "bigint" ? `${value}n` : value,
        ),
      }) as Promise<PreparedSubmission>;
    },
    async submit(id, submission) {
      return json(`/v1/submissions/${id}/submit`, {
        method: "POST",
        body: JSON.stringify(submission),
      }) as Promise<SubmissionStatus>;
    },
    async submission(id) {
      return json(`/v1/submissions/${id}`) as Promise<SubmissionStatus>;
    },
  };
}

function project(snapshot: VaultSnapshot, ui: UiState): VaultState {
  const configured = snapshot.policy;
  const delaySeconds = snapshot.topology?.delay.cooldownSeconds ?? 86_400n;
  const delayHours = Math.max(1, Math.ceil(Number(delaySeconds) / 3_600));
  const recipients = configured?.recipients.map((address) => ({ name: address, address })) ?? [];
  const onboarding = {
    firstSigner: Boolean(ui.primaryCredentialId),
    secondSigner: Boolean(ui.secondaryCredentialId),
    limits: Boolean(
      configured &&
      configured.baseDailyLimit > 0n &&
      configured.baseDailyLimit < configured.instantDailyLimit,
    ),
    rehearsed: ui.rehearsed,
  };
  const periodAnchor = snapshot.spendState?.window;
  const activity: ActivityItem[] = snapshot.queueItems.map((item) => {
    let amount = 0n;
    let address = item.to;
    let counterparty = "Unsupported delayed operation";
    try {
      const decoded = decodeFunctionData({ abi: ERC20_TRANSFER_ABI, data: item.data });
      if (
        decoded.functionName === "transfer" &&
        item.to.toLowerCase() === snapshot.usdc?.address.toLowerCase() &&
        item.value === 0n &&
        item.operation === 0
      ) {
        address = decoded.args[0];
        amount = decoded.args[1];
        counterparty = address;
      }
    } catch {
      // Unsupported tuples stay visible but cannot masquerade as USDC.
    }
    const canonicalNow =
      snapshot.observedTimestamp === undefined
        ? Date.now()
        : Number(snapshot.observedTimestamp) * 1000;
    const createdAt = Number(item.createdAt) * 1000;
    const earliestExecution = createdAt + Number(delaySeconds) * 1000;
    const expiresAt =
      earliestExecution + Number(snapshot.topology?.delay.expirationSeconds ?? 0n) * 1000;
    const status =
      expiresAt > createdAt && canonicalNow >= expiresAt
        ? "expired"
        : canonicalNow >= earliestExecution
          ? "ready"
          : "queued";
    return {
      id: `${item.txHash}:${item.queueNonce.toString()}`,
      direction: "out",
      amount,
      counterparty,
      address,
      lane: "delayed",
      status,
      canonicalNow,
      createdAt,
      earliestExecution,
      expiresAt,
      txHash: item.txHash,
      queueNonce: Number(item.queueNonce),
      approvers: ["First signer", "Second signer"],
      fingerprint: fingerprintOf([snapshot.safe, item.txHash, item.queueNonce]),
    } satisfies ActivityItem;
  });
  return {
    chainId: snapshot.chainId,
    network: "Ethereum Sepolia (testnet)",
    safe: snapshot.safe,
    guard: snapshot.topology?.guard ?? "",
    delay: snapshot.topology?.delay.address ?? "",
    usdc: snapshot.usdc?.address ?? "",
    balance: snapshot.usdcBalance ?? 0n,
    nativeBalance: snapshot.nativeBalance ?? 0n,
    safeNonce: snapshot.safeNonce ?? null,
    policy: {
      basePerTxCap: configured?.basePerTransaction ?? 0n,
      firstSignerDaily: configured?.baseDailyLimit ?? 0n,
      instantDaily: configured?.instantDailyLimit ?? 0n,
      perTxCap: configured?.stepUpPerTransaction ?? 0n,
      delayHours,
      delaySeconds,
    },
    spentFirstSigner: snapshot.spendState?.baseSpent ?? 0n,
    spentInstant: snapshot.spendState?.instantSpent ?? 0n,
    resetsAt:
      periodAnchor && periodAnchor > 0n ? Number(periodAnchor + 86_400n) * 1000 : nextReset(),
    secondSignerName:
      ui.secondaryAuthenticator === "cross-platform"
        ? "Cross-platform second signer"
        : ui.secondaryCredentialId
          ? "Same-device second signer"
          : "Second signer",
    frozen: snapshot.topology?.frozen ?? false,
    writable: snapshot.writable,
    health: snapshot.health,
    onboarding,
    recipients,
    activity,
    notifications: ui.notifications,
    deploymentHash: ui.deploymentHash ?? "0x",
    policyHash: ui.policyHash ?? "0x",
  };
}

export type Classification = { lane: Lane; reason?: string };
/** Advisory only; the onchain guard remains authoritative. */
export function classify(s: VaultState, to: string, amount: bigint): Classification {
  if (!s.writable || s.frozen)
    return {
      lane: "blocked",
      reason: s.frozen
        ? "Your account is frozen. Unfreeze it in Limits & security first."
        : "The vault is not healthy or provisioned yet.",
    };
  if (amount <= 0n) return { lane: "blocked", reason: "Enter an amount above 0 USDC." };
  if (amount > s.balance)
    return { lane: "blocked", reason: "This is more than your available balance." };
  if (!s.recipients.some((r) => r.address.toLowerCase() === to.toLowerCase()))
    return { lane: "blocked", reason: "This recipient is not on your allowed list." };
  if (s.spentInstant + amount > s.policy.instantDaily) return { lane: "delayed" };
  if (amount > s.policy.perTxCap)
    return { lane: "blocked", reason: "This is above the maximum for an instant transfer." };
  if (s.spentFirstSigner + amount > s.policy.firstSignerDaily) return { lane: "step-up" };
  return { lane: "base" };
}

type Ctx = {
  state: VaultState;
  setup: WalletSetupState;
  hydrated: boolean;
  loading: boolean;
  hasAccount: boolean;
  canWrite: boolean;
  finishSetup: () => void;
  refresh: () => Promise<void>;
  registerPrimary: () => Promise<void>;
  registerSecondary: () => Promise<void>;
  retryProvisioning: () => Promise<void>;
  rebindPrimary: () => Promise<void>;
  rebindSecondary: () => Promise<void>;
  prepareTransfer: (
    input: Readonly<{ recipient: Address; amount: bigint }>,
  ) => Promise<SubmissionStatus>;
  approveSubmission: (
    id: string,
    role: "primary" | "secondary" | "none",
  ) => Promise<SubmissionStatus>;
  cancelQueued: (item: ActivityItem) => Promise<SubmissionStatus>;
  executeReady: (item: ActivityItem) => Promise<SubmissionStatus>;
  reconcileSubmission: (id: string) => Promise<SubmissionStatus>;
  provision: () => Promise<void>;
  sendUsdc: (input: Readonly<{ recipient: Address; amount: bigint }>) => Promise<SubmissionStatus>;
};
const VaultCtx = createContext<Ctx | null>(null);

const terminal = (status: SubmissionStatus) =>
  status.state === "confirmed" || status.state === "reverted";
const requireOnline = () => {
  if (typeof navigator !== "undefined" && navigator.onLine === false)
    throw new Error("Wallet writes are unavailable while offline");
};
const requireCredentialRebindReady = (status: CredentialRebindStatus) => {
  if (status.primary !== "ready" || status.secondary !== "ready") throw new Error("Verify both recovered signers before using the vault");
};

export function VaultProvider({
  children,
  client: providedClient,
  config: providedConfig,
  backend: providedBackend,
}: VaultProviderProps) {
  const [state, setState] = useState<VaultState>(emptyState);
  const [hydrated, setHydrated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<VaultConfig | undefined>(providedConfig);
  const storageProfile = useMemo(activeStorageProfile, []);
  const client = useMemo(() => providedClient ?? defaultClient(), [providedClient]);
  const backend = useMemo(() => providedBackend ?? defaultBackend(), [providedBackend]);
  const [ui, setUi] = useState(() => readUiState(storageProfile));
  const prepared = useRef(new Map<string, PreparedSubmission>());
  const automaticProvisioning = useRef<Promise<void> | undefined>(undefined);
  const initialSnapshot = useRef<{ client: PublicClient | undefined; vault: string } | undefined>(
    undefined,
  );
  const refresh = useCallback(async () => {
    if (!config || !client) {
      const blank = emptyState();
      setState({
        ...blank,
        notifications: ui.notifications,
        onboarding: {
          firstSigner: Boolean(ui.primaryCredentialId),
          secondSigner: Boolean(ui.secondaryCredentialId),
          limits: false,
          rehearsed: ui.rehearsed,
        },
      });
      setLoading(false);
      setHydrated(true);
      return;
    }
    setLoading(true);
    try {
      setState(project(await readVaultSnapshot(client, config), ui));
    } catch (error) {
      const blank = emptyState();
      setState({
        ...blank,
        notifications: ui.notifications,
        health: [
          {
            code: "rpc-inconsistent",
            message: error instanceof Error ? error.message : "Vault read failed",
            blocking: true,
          },
        ],
      });
    } finally {
      setLoading(false);
      setHydrated(true);
    }
  }, [client, config, ui]);
  useEffect(() => {
    const stored = providedConfig ?? readConfig(storageProfile);
    setConfig(stored);
    setHydrated(true);
  }, [providedConfig, storageProfile]);
  useEffect(() => {
    if (!hydrated) return;
    const vault = config
      ? [config.chainId, config.safe, config.guard, config.delay, config.usdc].join(":")
      : "unprovisioned";
    const previous = initialSnapshot.current;
    if (previous && previous.client === client && previous.vault === vault) return;
    initialSnapshot.current = { client, vault };
    void refresh();
  }, [client, config, hydrated, refresh]);
  useEffect(() => {
    if (hydrated) localStorage.setItem(walletStorageKey("ui", storageProfile), JSON.stringify(ui));
  }, [hydrated, storageProfile, ui]);
  const finishSetup = useCallback(() => {
    setUi((current) => ({ ...current, rehearsed: true }));
  }, []);
  const rememberSubmission = useCallback(
    (id: string) =>
      setUi((current) =>
        current.submissionIds.includes(id)
          ? current
          : { ...current, submissionIds: [...current.submissionIds, id] },
      ),
    [],
  );
  const completeProvisioning = useCallback(
    () => {
      if (automaticProvisioning.current) return automaticProvisioning.current;
      let succeeded = false;
      const operation = runWalletCriticalFlow(async () => {
        setUi((current) => ({ ...current, provisioning: "provisioning" }));
        try {
          if (!client) throw new Error("Set VITE_SEPOLIA_RPC_URL before provisioning the demo vault");
          requireOnline();
          await backend.health?.();
          const result = await backend.autoProvisionVault();
          const credentialRebind = storedCredentialRebind(result.credentialRebind);
          const next: VaultConfig = {
            chainId: 11155111,
            safe: result.safe,
            guard: result.guard,
            delay: result.delay,
            usdc: result.usdc,
            usdcCandidates: [DEFAULT_USDC],
          };
          saveConfig(storageProfile, next);
          setUi((current) => {
            const nextUi = {
              ...current,
              rehearsed: false,
              provisioning: credentialRebind.required ? "provisioning" as const : "provisioned" as const,
              credentialRebind,
              receiptHash: result.evidence.setupTransactionHash,
              deploymentHash: result.evidence.setupTransactionHash,
              policyHash: result.evidence.verificationReportHash,
            };
            saveUiState(storageProfile, nextUi);
            return nextUi;
          });
          setConfig(next);
          succeeded = true;
        } catch (error) {
          automaticProvisioning.current = undefined;
          setUi((current) => ({ ...current, provisioning: "failed" }));
          throw error;
        }
      });
      automaticProvisioning.current = operation;
      void operation.finally(() => { if (!succeeded) automaticProvisioning.current = undefined; }).catch(() => undefined);
      return operation;
    },
    [backend, client, storageProfile],
  );
  const register = useCallback(
    (role: "primary" | "secondary") =>
      runWalletCriticalFlow(async () => {
        requireOnline();
        await backend.health?.();
        const registration = await backend.registerPasskey(role);
        const otherRegistered = role === "primary" ? Boolean(ui.secondaryCredentialId) : Boolean(ui.primaryCredentialId);
        const next = role === "primary"
          ? { ...ui, primaryCredentialId: registration.credentialId, provisioning: otherRegistered ? "provisioning" as const : "registering" as const }
          : { ...ui, secondaryCredentialId: registration.credentialId, secondaryAuthenticator: registration.response.authenticatorAttachment, provisioning: otherRegistered ? "provisioning" as const : "registering" as const };
        saveUiState(storageProfile, next);
        setUi(next);
        if (otherRegistered) await completeProvisioning();
      }),
    [backend, completeProvisioning, storageProfile, ui],
  );
  const registerPrimary = useCallback(() => register("primary"), [register]);
  const registerSecondary = useCallback(() => register("secondary"), [register]);
  const retryProvisioning = useCallback(() => completeProvisioning(), [completeProvisioning]);
  const rebind = useCallback(
    (role: "primary" | "secondary") => runWalletCriticalFlow(async () => {
      requireOnline();
      await backend.health?.();
      const credentialId = role === "primary" ? ui.primaryCredentialId : ui.secondaryCredentialId;
      if (!credentialId) throw new Error(`Stored ${role} credential ID is required for recovery verification`);
      if (!backend.rebindPasskey) throw new Error("Recovered credential verification is unavailable");
      const credentialRebind = await backend.rebindPasskey(role, credentialId);
      setUi((current) => {
        const nextUi = { ...current, credentialRebind, provisioning: credentialRebind.required ? "provisioning" as const : "provisioned" as const };
        saveUiState(storageProfile, nextUi);
        return nextUi;
      });
    }),
    [backend, storageProfile, ui.primaryCredentialId, ui.secondaryCredentialId],
  );
  const rebindPrimary = useCallback(() => rebind("primary"), [rebind]);
  const rebindSecondary = useCallback(() => rebind("secondary"), [rebind]);
  const approveSubmission = useCallback(
    (id: string, role: "primary" | "secondary" | "none") =>
      runWalletCriticalFlow(async () => {
        requireOnline();
        requireCredentialRebindReady(ui.credentialRebind);
        const request = prepared.current.get(id);
        if (!request) throw new Error("Prepared submission is unavailable; prepare it again");
        let status: SubmissionStatus;
        if (role === "none") status = await backend.submit(id, { role });
        else {
          if (!request.safeTxHash)
            throw new Error("Signed submission is missing its exact Safe transaction hash");
          const credentialId =
            role === "primary" ? ui.primaryCredentialId : ui.secondaryCredentialId;
          if (!credentialId) throw new Error(`${role} passkey is required for this approval`);
          const environment = activeEnvironmentProfile();
          const assertion = await signSafeDigest({
            role,
            safe: state.safe as Address,
            chainId: 11155111,
            safeTxHash: request.safeTxHash,
            challenge: challengeForSafeDigest(request.safeTxHash),
            challengeBinding: {
              safe: state.safe as Address,
              chainId: 11155111,
              safeTxHash: request.safeTxHash,
            },
            rpId: environment.rpId,
            origin: environment.appOrigin,
            credentialId,
          });
          status = await backend.submit(id, { role, assertion });
        }
        rememberSubmission(id);
        if (terminal(status)) await refresh();
        return status;
      }),
    [
      backend,
      refresh,
      rememberSubmission,
      state.safe,
      ui.primaryCredentialId,
      ui.secondaryCredentialId,
      ui.credentialRebind,
    ],
  );
  const prepare = useCallback(
    async (intent: SubmissionIntent) => {
      requireOnline();
      requireCredentialRebindReady(ui.credentialRebind);
      await backend.health?.();
      const request = await backend.prepareIntent(intent);
      prepared.current.set(request.id, request);
      rememberSubmission(request.id);
      return request;
    },
    [backend, rememberSubmission, ui.credentialRebind],
  );
  const prepareTransfer = useCallback(
    ({ recipient, amount }: Readonly<{ recipient: Address; amount: bigint }>) =>
      runWalletCriticalFlow(async () => {
        if (!state.writable || state.health.length > 0)
          throw new Error("vault health checks are blocking writes");
        const request = await prepare({
          kind: "transfer",
          recipient,
          amount,
          idempotencyKey: crypto.randomUUID(),
        });
        let status = await approveSubmission(request.id, "primary");
        if (status.state === "awaiting-secondary")
          status = await approveSubmission(request.id, "secondary");
        return status;
      }),
    [approveSubmission, prepare, state.health.length, state.writable],
  );
  const queueAction = useCallback(
    (item: ActivityItem, kind: "cancel-queued" | "execute-ready" | "skip-expired") =>
      runWalletCriticalFlow(async () => {
        if (
          item.queueNonce === undefined ||
          !item.txHash ||
          !/^0x[0-9a-fA-F]{64}$/.test(item.txHash)
        )
          throw new Error("Canonical queue binding is unavailable");
        const request = await prepare({
          kind,
          queueNonce: BigInt(item.queueNonce),
          queueFingerprint: item.txHash as Hex,
          idempotencyKey: crypto.randomUUID(),
        });
        if (request.requiredApprovals.length === 0) return approveSubmission(request.id, "none");
        let status = await approveSubmission(request.id, "primary");
        if (status.state === "awaiting-secondary")
          status = await approveSubmission(request.id, "secondary");
        return status;
      }),
    [approveSubmission, prepare],
  );
  const cancelQueued = useCallback(
    (item: ActivityItem) => queueAction(item, "cancel-queued"),
    [queueAction],
  );
  const executeReady = useCallback(
    (item: ActivityItem) => {
      const status = effectiveStatus(item);
      if (status !== "ready" && status !== "expired")
        throw new Error("Delayed operation is not ready for a lifecycle action");
      return queueAction(item, status === "expired" ? "skip-expired" : "execute-ready");
    },
    [queueAction],
  );
  const reconcileSubmission = useCallback(
    async (id: string) => {
      requireOnline();
      requireCredentialRebindReady(ui.credentialRebind);
      const status = await backend.submission(id);
      if (terminal(status)) await refresh();
      return status;
    },
    [backend, refresh, ui.credentialRebind],
  );
  const provision = useCallback(
    () =>
      runWalletCriticalFlow(async () => {
        requireOnline();
        await backend.health?.();
        const primary = await backend.registerPasskey("primary");
        const secondary = await backend.registerPasskey("secondary");
        if (primary.credentialId === secondary.credentialId)
          throw new Error("Primary and secondary passkeys must be distinct");
        const next = {
          ...ui,
          primaryCredentialId: primary.credentialId,
          secondaryCredentialId: secondary.credentialId,
          secondaryAuthenticator: secondary.response.authenticatorAttachment,
          provisioning: "provisioning" as const,
        };
        saveUiState(storageProfile, next);
        setUi(next);
        await completeProvisioning();
      }),
    [backend, completeProvisioning, storageProfile, ui],
  );
  const setup = useMemo<WalletSetupState>(
    () => ({
      primaryCredentialId: ui.primaryCredentialId,
      secondaryCredentialId: ui.secondaryCredentialId,
      secondaryAuthenticator: ui.secondaryAuthenticator,
      distinctSecondary: ui.secondaryAuthenticator === "cross-platform",
      provisioning: ui.provisioning,
      credentialRebind: ui.credentialRebind,
      receiptHash: ui.receiptHash,
      submissionIds: ui.submissionIds,
    }),
    [ui],
  );
  const sendUsdc = prepareTransfer;
  const value = useMemo(
    () => ({
      state,
      setup,
      hydrated,
      loading,
      hasAccount: Boolean(config),
      canWrite: state.writable && state.health.length === 0 && ui.credentialRebind.primary === "ready" && ui.credentialRebind.secondary === "ready",
      finishSetup,
      refresh,
      registerPrimary,
      registerSecondary,
      retryProvisioning,
      rebindPrimary,
      rebindSecondary,
      prepareTransfer,
      approveSubmission,
      cancelQueued,
      executeReady,
      reconcileSubmission,
      provision,
      sendUsdc,
    }),
    [
      state,
      setup,
      hydrated,
      loading,
      config,
      ui.credentialRebind,
      finishSetup,
      refresh,
      registerPrimary,
      registerSecondary,
      retryProvisioning,
      rebindPrimary,
      rebindSecondary,
      prepareTransfer,
      approveSubmission,
      cancelQueued,
      executeReady,
      reconcileSubmission,
      provision,
      sendUsdc,
    ],
  );
  return <VaultCtx.Provider value={value}>{children}</VaultCtx.Provider>;
}

export function useVault(): Ctx {
  const c = useContext(VaultCtx);
  if (!c) throw new Error("useVault outside VaultProvider");
  return c;
}
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
export const isAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a.trim());
export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const newId = () => crypto.randomUUID();
export { randAddr };
