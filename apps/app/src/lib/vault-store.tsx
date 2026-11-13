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
  encodeFunctionData,
  http,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { sepolia } from "viem/chains";
import { usdc } from "./usdc";
import { mergeBackendHistory, type HistoryPage } from "./backend-history";
import { useSubmissionStatuses } from "./use-submission-statuses";
import { effectiveStatus, fingerprintOf, type ActivityItem, type Lane } from "./activity-model";
import {
  readVaultSnapshot,
  type HealthFailure,
  type VaultConfig,
  type VaultSnapshot,
} from "./vault-chain";
import {
  authenticateVaultPasskey,
  challengeForSafeDigest,
  createVaultPasskey,
  signSafeDigest,
  type PasskeyRegistration,
} from "./webauthn-passkey";
import { loadWalletEnvironmentProfile, type WalletEnvironmentProfile } from "./environment-profile";
import { runWalletCriticalFlow } from "./pwa";
import { BackendRequestError, describeProvisioningError } from "./provisioning-errors";

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
    blockNumber: string;
  }>;
}>;

export type BackendRegistrationOptions = Readonly<{
  sessionId: string;
  challenge: string;
  rpId: string;
  origin: string;
  role: "primary" | "secondary";
  userVerification: "required";
  userHandle?: string;
  authenticatorAttachment?: "platform" | "cross-platform";
}>;

export type BackendLoginOptions = Readonly<{
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
    | "add-recipient"
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
  publicRequest?: Readonly<Record<string, unknown>>;
  createdAt?: number;
  requestHash?: Hex;
  requiredApprovals?: readonly ("primary" | "secondary")[];
  approvals?: Readonly<{ primary: boolean; secondary: boolean }>;
  transactionHash?: Hex;
  receipt?: Readonly<{ transactionHash: Hex; blockNumber: bigint; blockHash: Hex }>;
}>;
export type SubmissionIntent =
  | Readonly<{ kind: "transfer"; recipient: Address; amount: bigint; idempotencyKey: string }>
  | Readonly<{ kind: "add-recipient"; recipient: Address; idempotencyKey: string }>
  | Readonly<{
      kind: "cancel-queued" | "execute-ready" | "skip-expired";
      queueNonce: bigint;
      queueFingerprint: Hex;
      idempotencyKey: string;
    }>;

export type VaultSession = Readonly<{
  authenticated: boolean;
  csrfToken?: string;
  account?: Readonly<{
    id: string;
    userHandle: string;
    state: "registering" | "queued" | "provisioning" | "verified" | "blocked";
    error?: string;
    primaryCredentialId?: string;
    secondaryCredentialId?: string;
    submissionIds?: readonly string[];
    vault?: VaultProvisioningResult;
  }>;
}>;

export type VaultSetupStatus = Readonly<{
  state: "registering" | "queued" | "provisioning" | "verified" | "blocked";
  error?: string;
}>;

export type VaultBackend = Readonly<{
  session?: () => Promise<VaultSession>;
  signIn?: (
    credentialId?: string,
    credentialTransports?: PasskeyRegistration["response"]["response"]["transports"],
  ) => Promise<VaultSession>;
  signOut?: () => Promise<VaultSession>;
  createAccount?: () => Promise<VaultSession>;
  health?: (purpose?: "provision" | "write") => Promise<void>;
  registerPasskey: (role: "primary" | "secondary") => Promise<PasskeyRegistration>;
  autoProvisionVault: () => Promise<VaultSetupStatus | VaultProvisioningResult>;
  currentVault?: () => Promise<VaultProvisioningResult | undefined>;
  history?: (cursor?: string) => Promise<HistoryPage>;
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

type StorageProfile = Pick<WalletEnvironmentProfile, "id" | "rpId"> & { accountId?: string };
export const walletStorageKey = (kind: "config" | "ui", profile: StorageProfile) =>
  `usdc-vault-${kind}-v2:${profile.id}:${profile.rpId}${profile.accountId ? `:${profile.accountId}` : ""}`;

const DEFAULT_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Address;
const ERC20_TRANSFER_ABI = parseAbi(["function transfer(address,uint256) returns (bool)"]);
const RECIPIENT_REPAIR_ABI = parseAbi([
  "function repairPolicy(bytes32,address,uint256,uint256,uint256,uint256,address[],uint8)",
]);
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
  /** Server-account phase confirms an immutable signer plan, not a cached credential ID. */
  reviewedPlanBound: boolean;
  provisioning: "registering" | "provisioning" | "failed" | "provisioned";
  receiptHash?: Hex | undefined;
  provisioningError?: string | undefined;
  submissionIds: readonly string[];
}>;
type UiState = {
  notifications: VaultState["notifications"];
  rehearsed: boolean;
  primaryCredentialId?: string | undefined;
  secondaryCredentialId?: string | undefined;
  secondaryAuthenticator?: "platform" | "cross-platform" | undefined;
  provisioning: WalletSetupState["provisioning"];
  receiptHash?: Hex | undefined;
  submissionIds: string[];
  deploymentHash?: Hex | undefined;
  policyHash?: Hex | undefined;
};

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
      provisioning:
        parsed?.provisioning === "provisioning"
          ? "failed"
          : ["registering", "failed", "provisioned"].includes(String(parsed?.provisioning))
            ? (parsed!.provisioning as WalletSetupState["provisioning"])
            : parsed?.primaryCredentialId && parsed?.secondaryCredentialId
              ? "failed"
              : "registering",
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
    const fromBlock = parsed.fromBlock;
    if (fromBlock !== undefined && (typeof fromBlock !== "string" || !/^\d+$/.test(fromBlock)))
      return undefined;
    return {
      chainId: 11155111,
      safe: parsed.safe as Address,
      guard: parsed.guard as Address,
      delay: parsed.delay as Address,
      usdc: parsed.usdc as Address,
      usdcCandidates: [DEFAULT_USDC],
      ...(fromBlock === undefined ? {} : { fromBlock: BigInt(fromBlock) }),
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
      ...(config.fromBlock === undefined ? {} : { fromBlock: String(config.fromBlock) }),
    }),
  );
}

function verifiedSetupBlock(vault: VaultProvisioningResult): bigint {
  if (!/^\d+$/.test(vault.evidence.blockNumber))
    throw new Error("Backend vault evidence is missing a valid setup block");
  return BigInt(vault.evidence.blockNumber);
}

function saveUiState(profile: StorageProfile, state: UiState): void {
  localStorage.setItem(walletStorageKey("ui", profile), JSON.stringify(state));
}

function pacedRpcFetch(intervalMs = 250): typeof fetch {
  let queue = Promise.resolve();
  let nextStart = 0;
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = queue.then(async () => {
      const wait = Math.max(0, nextStart - Date.now());
      if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
      nextStart = Date.now() + intervalMs;
      return fetch(input, init);
    });
    queue = request.then(
      () => undefined,
      () => undefined,
    );
    return request;
  }) as typeof fetch;
}

function defaultClient(): PublicClient | undefined {
  const rpcUrl = (import.meta.env["VITE_SEPOLIA_RPC_URL"] as string | undefined)?.trim();
  return rpcUrl
    ? createPublicClient({
        chain: sepolia,
        batch: { multicall: { wait: 10 } },
        transport: http(rpcUrl, {
          fetchFn: pacedRpcFetch(),
          retryCount: 4,
          retryDelay: 1_000,
        }),
      })
    : undefined;
}

export async function checkBackendHealth(
  profile: WalletEnvironmentProfile,
  requester: typeof fetch = fetch,
  purpose: "provision" | "write" = "write",
): Promise<void> {
  const response = await requester(`${profile.backendOrigin}/health`, {
    headers: { accept: "application/json" },
    credentials: profile.credentials,
  });
  let payload: {
    ok?: unknown;
    writesReady?: unknown;
    provisioningReady?: unknown;
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
  const ready =
    purpose === "provision"
      ? payload.provisioningReady === true ||
        (payload.provisioningReady === undefined && payload.writesReady === true)
      : payload.writesReady === true;
  if (!ready)
    throw new Error(
      `Backend health check failed: ${purpose === "provision" ? "provisioning" : "submission runtime"} is not ready`,
    );
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

class StaleAccountSessionError extends Error {
  constructor() {
    super("Account session changed; stale response ignored");
    this.name = "StaleAccountSessionError";
  }
}

export function createVaultBackend(
  fixedProfile?: WalletEnvironmentProfile,
  requester: typeof fetch = fetch,
): VaultBackend {
  const environment = () => fixedProfile ?? activeEnvironmentProfile();
  let csrfToken: string | undefined;
  let accountId: string | undefined;
  let generation = 0;
  let sessionRead: { generation: number; promise: Promise<VaultSession> } | undefined;
  const acceptSession = (projection: VaultSession, expected: number) => {
    if (generation !== expected) throw new StaleAccountSessionError();
    if (
      typeof projection.authenticated !== "boolean" ||
      (projection.authenticated && !projection.account?.id)
    )
      throw new Error("Invalid backend account session");
    if (accountId !== projection.account?.id) generation += 1;
    accountId = projection.account?.id;
    csrfToken = projection.csrfToken;
    return projection;
  };
  const json = async <T,>(url: string, init?: RequestInit, allowMissing = false): Promise<T> => {
    const profile = environment();
    const requestGeneration = generation;
    const accountRoute = !url.startsWith("/v1/auth/");
    const response = await requester(`${profile.backendOrigin}${url}`, {
      ...init,
      credentials: profile.credentials,
      headers: {
        "content-type": "application/json",
        ...(csrfToken && init?.method === "POST" ? { "x-csrf-token": csrfToken } : {}),
        ...(accountRoute && accountId ? { "x-vault-account": accountId } : {}),
        ...(init?.headers ?? {}),
      },
    });
    if (requestGeneration !== generation) throw new StaleAccountSessionError();
    if (allowMissing && response.status === 404) return undefined as T;
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
        "indexedThrough",
      ].includes(key) &&
      typeof value === "string" &&
      /^\d+n$/.test(value)
        ? BigInt(value.slice(0, -1))
        : value,
    ) as unknown;
    if (requestGeneration !== generation) throw new StaleAccountSessionError();
    const error =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : undefined;
    if (!response.ok) {
      const details =
        payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
      const backendError = new BackendRequestError({
        status: response.status,
        message: error ?? `Backend request failed (${response.status})`,
        ...(typeof details["code"] === "string" ? { code: details["code"] } : {}),
        ...(typeof details["stage"] === "string" ? { stage: details["stage"] } : {}),
        ...(typeof details["requestId"] === "string"
          ? { requestId: details["requestId"] }
          : response.headers.get("x-request-id")
            ? { requestId: response.headers.get("x-request-id")! }
            : {}),
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
    async session() {
      const expected = generation;
      if (sessionRead?.generation === expected) return sessionRead.promise;
      const read = {
        generation: expected,
        promise: json<VaultSession>("/v1/auth/session").then((next) =>
          acceptSession(next, expected),
        ),
      };
      sessionRead = read;
      try {
        return await read.promise;
      } finally {
        if (sessionRead === read) sessionRead = undefined;
      }
    },
    async createAccount() {
      const expected = ++generation;
      return acceptSession(
        await json<VaultSession>("/v1/auth/setup", { method: "POST", body: "{}" }),
        expected,
      );
    },
    async signOut() {
      const expected = ++generation;
      const result = await json<VaultSession>("/v1/auth/logout", { method: "POST", body: "{}" });
      return acceptSession(result, expected);
    },
    async signIn(credentialId, credentialTransports) {
      const expected = ++generation;
      const options = await json<BackendLoginOptions & { csrfToken: string }>(
        "/v1/auth/login/options",
        {
          method: "POST",
          body: "{}",
        },
      );
      const profile = environment();
      if (
        options.origin !== profile.appOrigin ||
        options.rpId !== profile.rpId ||
        options.userVerification !== "required"
      )
        throw new Error("Backend login profile does not match the active wallet environment");
      csrfToken = options.csrfToken;
      const assertion = await authenticateVaultPasskey(
        {
          challenge: options.challenge,
          rpId: options.rpId,
          origin: options.origin,
          userVerification: options.userVerification,
          ...(credentialId && credentialTransports?.length ? { credentialTransports } : {}),
        },
        credentialId,
      );
      if (generation !== expected) throw new Error("Account session changed; stale login ignored");
      return acceptSession(
        await json<VaultSession>("/v1/auth/login/verify", {
          method: "POST",
          body: JSON.stringify({
            sessionId: options.sessionId,
            assertion,
          }),
        }),
        expected,
      );
    },
    async health(purpose) {
      await checkBackendHealth(environment(), requester, purpose);
    },
    async registerPasskey(role) {
      const requestGeneration = generation;
      const profile = environment();
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
      const createdAt = new Date();
      const timestamp = [
        createdAt.getFullYear(),
        createdAt.getMonth() + 1,
        createdAt.getDate(),
        createdAt.getHours(),
        createdAt.getMinutes(),
        createdAt.getSeconds(),
      ]
        .map((value) => String(value).padStart(2, "0"))
        .join("-");
      const passkeyName = `tiered-guard-vault-${timestamp}`;
      const registrationOptions = {
        challenge: options.challenge,
        rp: { id: options.rpId, name: "tiered-spending-guard" },
        user: {
          id:
            options.userHandle ??
            (() => {
              throw new Error("Backend registration user handle is required");
            })(),
          name: passkeyName,
          displayName: passkeyName,
        },
        pubKeyCredParams: [{ alg: -7, type: "public-key" }],
        authenticatorSelection: {
          ...(role === "secondary"
            ? { authenticatorAttachment: options.authenticatorAttachment ?? "cross-platform" }
            : {}),
          userVerification: "required",
          residentKey: role === "primary" ? "required" : "preferred",
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
      if (requestGeneration !== generation)
        throw new Error("Account session changed; stale registration ignored");
      await json(`/v1/registrations/${role}/verify`, {
        method: "POST",
        body: JSON.stringify({ sessionId: options.sessionId, registration: registration.response }),
      });
      return registration;
    },
    async currentVault() {
      return json<VaultProvisioningResult | undefined>("/v1/vaults/current", undefined, true);
    },
    async history(cursor) {
      return json<HistoryPage>(
        `/v1/vaults/current/history?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
    },
    async autoProvisionVault() {
      return json("/v1/vaults/auto-provision", {
        method: "POST",
        body: "{}",
      }) as Promise<VaultSetupStatus>;
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
  const periodSeconds = 86_400n;
  const currentWindow =
    snapshot.observedTimestamp === undefined
      ? undefined
      : (snapshot.observedTimestamp / periodSeconds) * periodSeconds;
  const storedSpend = snapshot.spendState;
  const hasRolledOver = Boolean(
    storedSpend &&
    currentWindow !== undefined &&
    storedSpend.window < currentWindow &&
    storedSpend.window % periodSeconds === 0n,
  );
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
  const activity: ActivityItem[] = snapshot.queueItems.map((item) => {
    let amount = 0n;
    let address = item.to;
    let counterparty = "Unsupported delayed operation";
    let kind: NonNullable<ActivityItem["kind"]> = "unsupported";
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
        kind = "transfer";
      }
    } catch {
      // Unsupported tuples stay visible but cannot masquerade as USDC.
    }
    if (
      kind === "unsupported" &&
      item.to.toLowerCase() === snapshot.topology?.guard.toLowerCase() &&
      item.value === 0n &&
      item.operation === 0
    ) {
      try {
        const decoded = decodeFunctionData({ abi: RECIPIENT_REPAIR_ABI, data: item.data });
        const [, token, basePerTx, stepUpPerTx, baseDaily, instantDaily, updatedRecipients, mode] =
          decoded.args;
        const candidate = updatedRecipients.at(-1);
        if (
          configured &&
          candidate &&
          !/^0x0{40}$/i.test(candidate) &&
          token.toLowerCase() === snapshot.usdc?.address.toLowerCase() &&
          basePerTx === configured.basePerTransaction &&
          stepUpPerTx === configured.stepUpPerTransaction &&
          baseDaily === configured.baseDailyLimit &&
          instantDaily === configured.instantDailyLimit &&
          mode === 1 &&
          updatedRecipients.length === configured.recipients.length + 1 &&
          configured.recipients.every(
            (recipient, index) =>
              recipient.toLowerCase() === updatedRecipients[index]?.toLowerCase(),
          ) &&
          !configured.recipients.some(
            (recipient) => recipient.toLowerCase() === candidate.toLowerCase(),
          ) &&
          encodeFunctionData({
            abi: RECIPIENT_REPAIR_ABI,
            functionName: "repairPolicy",
            args: decoded.args,
          }).toLowerCase() === item.data.toLowerCase()
        ) {
          kind = "recipient-addition";
          address = candidate;
          counterparty = "Recipient addition";
        }
      } catch {
        // Display only. The backend independently verifies the full queued policy change.
      }
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
      kind,
      direction: "out",
      amount,
      counterparty,
      address,
      lane: "delayed",
      proposal: true,
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
    spentFirstSigner: hasRolledOver ? 0n : (storedSpend?.baseSpent ?? 0n),
    spentInstant: hasRolledOver ? 0n : (storedSpend?.instantSpent ?? 0n),
    resetsAt:
      currentWindow === undefined ? nextReset() : Number(currentWindow + periodSeconds) * 1000,
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
  if (
    amount <= s.policy.basePerTxCap &&
    s.spentFirstSigner + amount <= s.policy.firstSignerDaily &&
    s.spentInstant + amount <= s.policy.instantDaily
  )
    return { lane: "base" };
  if (!s.recipients.some((r) => r.address.toLowerCase() === to.toLowerCase()))
    return {
      lane: "blocked",
      reason:
        "This amount needs an elevated lane, so add this recipient through delayed maintenance first.",
    };
  if (s.spentInstant + amount > s.policy.instantDaily) return { lane: "delayed" };
  if (amount > s.policy.perTxCap)
    return { lane: "blocked", reason: "This is above the maximum for an instant transfer." };
  if (s.spentFirstSigner + amount > s.policy.firstSignerDaily) return { lane: "step-up" };
  return { lane: "blocked", reason: "This transfer does not fit an available lane." };
}

type Ctx = {
  state: VaultState;
  setup: WalletSetupState;
  hydrated: boolean;
  loading: boolean;
  hasAccount: boolean;
  canWrite: boolean;
  sessionManaged: boolean;
  authenticated: boolean;
  accountId?: string | undefined;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  createAccount: () => Promise<void>;
  finishSetup: () => void;
  refresh: () => Promise<void>;
  loadMoreHistory: () => Promise<void>;
  historyHasMore: boolean;
  historyLoading: boolean;
  historyError?: string | undefined;
  registerPrimary: () => Promise<void>;
  registerSecondary: () => Promise<void>;
  retryProvisioning: () => Promise<void>;
  addRecipient: (recipient: Address) => Promise<SubmissionStatus>;
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
  submissions: Readonly<Record<string, SubmissionStatus>>;
  provision: () => Promise<void>;
  sendUsdc: (input: Readonly<{ recipient: Address; amount: bigint }>) => Promise<SubmissionStatus>;
};
const VaultCtx = createContext<Ctx | null>(null);

/** Journal intent metadata uses canonical decimal units; never round it through Number. */
function publicAmount(value: unknown): bigint | undefined {
  const amount =
    typeof value === "bigint"
      ? value
      : typeof value === "string" && /^(0|[1-9]\d{0,77})$/.test(value)
        ? BigInt(value)
        : undefined;
  return amount !== undefined && amount > 0n && amount <= (1n << 256n) - 1n ? amount : undefined;
}

const requireOnline = () => {
  if (typeof navigator !== "undefined" && navigator.onLine === false)
    throw new Error("Wallet writes are unavailable while offline");
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
  const baseStorageProfile = useMemo(activeStorageProfile, []);
  const [session, setSession] = useState<VaultSession>({ authenticated: false });
  const selectedAccountId = session.account?.id;
  const storageProfile = useMemo(
    () => ({
      ...baseStorageProfile,
      ...(selectedAccountId ? { accountId: selectedAccountId } : {}),
    }),
    [baseStorageProfile, selectedAccountId],
  );
  const client = useMemo(() => providedClient ?? defaultClient(), [providedClient]);
  const backend = useMemo(() => providedBackend ?? createVaultBackend(), [providedBackend]);
  const sessionManaged = Boolean(backend.session);
  const reviewedPlanBound = Boolean(
    sessionManaged &&
    session.authenticated &&
    session.account &&
    ["queued", "provisioning", "verified", "blocked"].includes(session.account.state),
  );
  const [ui, setUi] = useState(() =>
    readUiState(
      sessionManaged ? { ...baseStorageProfile, accountId: "signed-out" } : storageProfile,
    ),
  );
  const prepared = useRef(new Map<string, PreparedSubmission>());
  const automaticProvisioning = useRef<Promise<void> | undefined>(undefined);
  const automaticResumeChecked = useRef(false);
  const [provisioningError, setProvisioningError] = useState<string | undefined>(undefined);
  const initialSnapshot = useRef<{ client: PublicClient | undefined; vault: string } | undefined>(
    undefined,
  );
  const accountGeneration = useRef(0);
  const [history, setHistory] = useState<HistoryPage>({ items: [], observedAt: 0 });
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | undefined>();
  const historyRead = useRef<Promise<void> | undefined>(undefined);
  const historyCursor = useRef<string | undefined>(undefined);
  const historyPagesLoaded = useRef(0);
  const projectedBlock = useRef<{ generation: number; blockNumber: bigint } | undefined>(undefined);
  const sessionChannel = useRef<BroadcastChannel | undefined>(undefined);
  const requireGeneration = useCallback((generation: number) => {
    if (generation !== accountGeneration.current)
      throw new Error("Account session changed; prepare the action again");
  }, []);
  const clearAccount = useCallback(() => {
    accountGeneration.current += 1;
    projectedBlock.current = undefined;
    prepared.current.clear();
    historyRead.current = undefined;
    historyCursor.current = undefined;
    historyPagesLoaded.current = 0;
    setHistory({ items: [], observedAt: 0 });
    setHistoryLoading(false);
    setHistoryError(undefined);
    automaticProvisioning.current = undefined;
    automaticResumeChecked.current = false;
    initialSnapshot.current = undefined;
    setConfig(undefined);
    setState(emptyState());
    setUi(readUiState({ ...baseStorageProfile, accountId: "signed-out" }));
    setSession({ authenticated: false });
    setProvisioningError(undefined);
    return accountGeneration.current;
  }, [baseStorageProfile]);
  const applySession = useCallback(
    async (next: VaultSession, generation: number) => {
      requireGeneration(generation);
      let vault = next.account?.vault;
      if (next.authenticated && next.account?.state === "verified" && !vault) {
        vault = await backend.currentVault?.();
        requireGeneration(generation);
      }
      const accountProfile = { ...baseStorageProfile, accountId: next.account?.id ?? "signed-out" };
      const cached = readUiState(accountProfile);
      const nextUi: UiState = {
        ...cached,
        primaryCredentialId: next.account?.primaryCredentialId,
        secondaryCredentialId: next.account?.secondaryCredentialId,
        submissionIds:
          next.account?.submissionIds === undefined
            ? cached.submissionIds
            : [...next.account.submissionIds],
        provisioning: vault
          ? "provisioned"
          : next.account?.state === "queued" || next.account?.state === "provisioning"
            ? "provisioning"
            : next.account?.state === "blocked"
              ? "failed"
              : "registering",
        ...(vault
          ? {
              receiptHash: vault.evidence.setupTransactionHash,
              deploymentHash: vault.evidence.setupTransactionHash,
              policyHash: vault.evidence.verificationReportHash,
            }
          : {}),
      };
      setSession(next);
      setProvisioningError(
        next.account?.state === "blocked"
          ? (next.account.error ?? "Vault setup is blocked; check the backend status.")
          : undefined,
      );
      setUi(nextUi);
      if (next.account) saveUiState(accountProfile, nextUi);
      if (vault && next.authenticated) {
        const nextConfig: VaultConfig = {
          chainId: 11155111,
          safe: vault.safe,
          guard: vault.guard,
          delay: vault.delay,
          usdc: vault.usdc,
          usdcCandidates: [DEFAULT_USDC],
          fromBlock: verifiedSetupBlock(vault),
        };
        saveConfig(accountProfile, nextConfig);
        setConfig(nextConfig);
      } else setConfig(undefined);
      setHydrated(true);
      setLoading(false);
    },
    [backend, baseStorageProfile, requireGeneration],
  );
  const readHistory = useCallback(
    (cursor?: string): Promise<void> => {
      if (!backend.history) return Promise.resolve();
      if (historyRead.current) return historyRead.current;
      const generation = accountGeneration.current;
      setHistoryLoading(true);
      setHistoryError(undefined);
      const operation = (async () => {
        let requestedCursor = false;
        const fetchPage = async (nextCursor?: string): Promise<HistoryPage> => {
          requestedCursor ||= nextCursor !== undefined;
          const page = await backend.history!(nextCursor);
          requireGeneration(generation);
          if (
            !Array.isArray(page.items) ||
            !Number.isSafeInteger(page.observedAt) ||
            page.observedAt < 0 ||
            page.items.some(
              (item) =>
                typeof item.amount !== "bigint" ||
                item.amount < 0n ||
                !Number.isSafeInteger(item.timestamp) ||
                item.timestamp < 0,
            )
          )
            throw new Error("Invalid backend history response");
          return page;
        };
        try {
          if (cursor) {
            const page = await fetchPage(cursor);
            historyCursor.current = page.nextCursor;
            historyPagesLoaded.current += 1;
            setHistory((previous) => ({
              ...page,
              items: [
                ...new Map(
                  [...previous.items, ...page.items].map((item) => [item.id, item]),
                ).values(),
              ],
            }));
          } else {
            // Rebuild the loaded range from fresh server cursors. Never retain stale pages
            // merely because their old row IDs still exist in browser memory.
            const pageLimit = Math.max(1, historyPagesLoaded.current);
            const pages: HistoryPage[] = [];
            let nextCursor: string | undefined;
            for (let index = 0; index < pageLimit; index += 1) {
              const page = await fetchPage(nextCursor);
              pages.push(page);
              nextCursor = page.nextCursor;
              if (!nextCursor) break;
            }
            const last = pages[pages.length - 1]!;
            historyCursor.current = last.nextCursor;
            historyPagesLoaded.current = pages.length;
            setHistory({
              ...last,
              items: [
                ...new Map(
                  pages.flatMap((page) => page.items).map((item) => [item.id, item]),
                ).values(),
              ],
            });
          }
        } catch (error) {
          if (generation === accountGeneration.current) {
            if (requestedCursor && error instanceof BackendRequestError && error.status === 400) {
              historyCursor.current = undefined;
              historyPagesLoaded.current = 0;
              setHistory({ items: [], observedAt: 0 });
            }
            setHistoryError(error instanceof Error ? error.message : "History is unavailable");
          }
        } finally {
          if (generation === accountGeneration.current) {
            historyRead.current = undefined;
            setHistoryLoading(false);
          }
        }
      })();
      historyRead.current = operation;
      return operation;
    },
    [backend, requireGeneration],
  );
  const loadMoreHistory = useCallback(async () => {
    if (historyCursor.current) await readHistory(historyCursor.current);
  }, [readHistory]);
  useEffect(() => {
    if (!hydrated || !config?.safe || (sessionManaged && !session.authenticated)) return;
    void readHistory();
    const timer = window.setInterval(() => {
      if (navigator.onLine !== false) void readHistory();
    }, 30000);
    return () => window.clearInterval(timer);
  }, [hydrated, config?.safe, sessionManaged, session.authenticated, readHistory]);
  const changeSession = useCallback(
    async (action: () => Promise<VaultSession>) => {
      const generation = clearAccount();
      setLoading(true);
      try {
        await applySession(await action(), generation);
      } finally {
        sessionChannel.current?.postMessage("changed");
        if (generation === accountGeneration.current) {
          setLoading(false);
          setHydrated(true);
        }
      }
    },
    [applySession, clearAccount],
  );
  const signIn = useCallback(async () => {
    if (!backend.signIn) throw new Error("Account sign-in is unavailable");
    await changeSession(() => backend.signIn!());
  }, [backend, changeSession]);
  const signOut = useCallback(async () => {
    if (!backend.signOut) throw new Error("Account sign-out is unavailable");
    await changeSession(() => backend.signOut!());
  }, [backend, changeSession]);
  const createAccount = useCallback(async () => {
    if (!backend.createAccount) throw new Error("Account creation is unavailable");
    await changeSession(async () => {
      if (session.account || session.authenticated) await backend.signOut!();
      return backend.createAccount!();
    });
  }, [backend, changeSession, session.account, session.authenticated]);
  useEffect(() => {
    if (!backend.session || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(
      `vault-session:${baseStorageProfile.id}:${baseStorageProfile.rpId}`,
    );
    sessionChannel.current = channel;
    channel.onmessage = (event: MessageEvent) => {
      if (event.data !== "changed") return;
      const generation = clearAccount();
      setLoading(true);
      void backend.session!()
        .then((next) => applySession(next, generation))
        .catch(() => {
          if (generation === accountGeneration.current) {
            setLoading(false);
            setHydrated(true);
          }
        });
    };
    return () => {
      channel.close();
      sessionChannel.current = undefined;
    };
  }, [backend, baseStorageProfile, clearAccount, applySession]);
  const refresh = useCallback(async () => {
    const generation = accountGeneration.current;
    if (!config || !client) {
      const blank = emptyState();
      setState({
        ...blank,
        notifications: ui.notifications,
        onboarding: {
          firstSigner: Boolean(ui.primaryCredentialId),
          secondSigner: Boolean(ui.secondaryCredentialId) || reviewedPlanBound,
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
      const snapshot = await readVaultSnapshot(client, config);
      let next = project(snapshot, ui);
      if (reviewedPlanBound)
        next = { ...next, onboarding: { ...next.onboarding, secondSigner: true } };
      if (snapshot.writable) {
        try {
          if (backend.currentVault) {
            const current = await backend.currentVault();
            if (
              !current ||
              current.chainId !== config.chainId ||
              !(["safe", "guard", "delay", "usdc"] as const).every(
                (field) =>
                  typeof current[field] === "string" &&
                  current[field].toLowerCase() === config[field].toLowerCase(),
              )
            )
              throw new Error("Backend current vault does not match the saved account");
          }
          await backend.health?.();
        } catch (error) {
          next = {
            ...next,
            writable: false,
            health: [
              ...next.health,
              {
                code: "backend-not-ready",
                message:
                  error instanceof Error ? error.message : "The backend is not ready for sending.",
                blocking: true,
              },
            ],
          };
        }
      }
      if (generation === accountGeneration.current) {
        projectedBlock.current =
          snapshot.observedBlock === undefined
            ? undefined
            : { generation, blockNumber: snapshot.observedBlock };
        setState((current) =>
          snapshot.observedBlock === undefined && snapshot.health.length > 0
            ? {
                ...current,
                writable: false,
                health: next.health,
                notifications: ui.notifications,
              }
            : next,
        );
      }
    } catch (error) {
      if (generation !== accountGeneration.current) return;
      projectedBlock.current = undefined;
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
      if (generation === accountGeneration.current) {
        setLoading(false);
        setHydrated(true);
      }
    }
  }, [backend, client, config, ui, reviewedPlanBound]);
  const receiptGeneration = accountGeneration.current;
  const receiptSessionCurrent = useCallback(
    () => receiptGeneration === accountGeneration.current,
    [receiptGeneration],
  );
  const { submissions, observeSubmission, readSubmission } = useSubmissionStatuses({
    scope: `${walletStorageKey("ui", storageProfile)}:${receiptGeneration}`,
    enabled: hydrated && (!sessionManaged || session.authenticated),
    ids: ui.submissionIds,
    read: backend.submission,
    isCurrent: receiptSessionCurrent,
    onTerminal: refresh,
    isCovered: (status) => {
      const covered = projectedBlock.current;
      const receipt = status.receipt;
      return Boolean(
        covered?.generation === accountGeneration.current &&
        receipt &&
        receipt.transactionHash === status.transactionHash &&
        typeof receipt.blockNumber === "bigint" &&
        receipt.blockNumber >= 0n &&
        covered.blockNumber >= receipt.blockNumber,
      );
    },
  });
  useEffect(() => {
    if (!backend.session) {
      const stored = providedConfig ?? readConfig(baseStorageProfile);
      setConfig(stored);
      setHydrated(true);
      return;
    }
    const generation = accountGeneration.current;
    void backend
      .session()
      .then((next) => applySession(next, generation))
      .catch((error: unknown) => {
        if (generation !== accountGeneration.current) return;
        setProvisioningError(
          error instanceof Error ? error.message : "Sign in to resume your account",
        );
        setHydrated(true);
        setLoading(false);
      });
    // Session hydration is authoritative; public storage never selects a live account.
  }, [backend, providedConfig, baseStorageProfile, applySession]);
  useEffect(() => {
    if (!backend.session) return;
    const checkSession = () => {
      const generation = accountGeneration.current;
      void backend.session!()
        .then((next) => {
          if (generation !== accountGeneration.current) return;
          if (
            next.account?.id !== session.account?.id ||
            next.authenticated !== session.authenticated
          ) {
            const selected = clearAccount();
            return applySession(next, selected);
          }
          if (
            next.account?.state !== session.account?.state ||
            next.account?.error !== session.account?.error
          )
            return applySession(next, generation);
          return undefined;
        })
        .catch((error: unknown) => {
          if (error instanceof StaleAccountSessionError) return;
          if (generation === accountGeneration.current) clearAccount();
        });
    };
    window.addEventListener("focus", checkSession);
    const timer =
      session.authenticated && ["queued", "provisioning"].includes(session.account?.state ?? "")
        ? window.setInterval(checkSession, 3000)
        : undefined;
    return () => {
      window.removeEventListener("focus", checkSession);
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [
    backend,
    session.account?.id,
    session.account?.state,
    session.account?.error,
    session.authenticated,
    clearAccount,
    applySession,
  ]);
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
    if (hydrated && (!sessionManaged || session.account))
      localStorage.setItem(walletStorageKey("ui", storageProfile), JSON.stringify(ui));
  }, [hydrated, storageProfile, ui, sessionManaged, session.account]);
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
  const completeProvisioning = useCallback(() => {
    if (automaticProvisioning.current) return automaticProvisioning.current;
    let succeeded = false;
    const generation = accountGeneration.current;
    const operation = runWalletCriticalFlow(async () => {
      setUi((current) => ({ ...current, provisioning: "provisioning" }));
      try {
        if (!client) throw new Error("Set VITE_SEPOLIA_RPC_URL before provisioning the demo vault");
        if (sessionManaged && !session.authenticated)
          throw new Error("Sign in before resuming account provisioning");
        requireGeneration(generation);
        requireOnline();
        await backend.health?.("provision");
        requireGeneration(generation);
        const result = await backend.autoProvisionVault();
        requireGeneration(generation);
        if (!("safe" in result))
          throw new Error("Provided backend requires account session observation");
        const next: VaultConfig = {
          chainId: 11155111,
          safe: result.safe,
          guard: result.guard,
          delay: result.delay,
          usdc: result.usdc,
          usdcCandidates: [DEFAULT_USDC],
          fromBlock: verifiedSetupBlock(result),
        };
        saveConfig(storageProfile, next);
        setUi((current) => {
          const nextUi = {
            ...current,
            rehearsed: false,
            provisioning: "provisioned" as const,
            receiptHash: result.evidence.setupTransactionHash,
            deploymentHash: result.evidence.setupTransactionHash,
            policyHash: result.evidence.verificationReportHash,
          };
          saveUiState(storageProfile, nextUi);
          return nextUi;
        });
        setConfig(next);
        setProvisioningError(undefined);
        succeeded = true;
      } catch (error) {
        if (generation !== accountGeneration.current) throw error;
        setProvisioningError(describeProvisioningError(error));
        setUi((current) => ({ ...current, provisioning: "failed" }));
        throw error;
      }
    });
    automaticProvisioning.current = operation;
    void operation
      .finally(() => {
        if (!succeeded && generation === accountGeneration.current)
          automaticProvisioning.current = undefined;
      })
      .catch(() => undefined);
    return operation;
  }, [backend, client, storageProfile, sessionManaged, session.authenticated, requireGeneration]);
  useEffect(() => {
    if (sessionManaged || !hydrated || automaticResumeChecked.current) return;
    automaticResumeChecked.current = true;
    // An authenticated queued/provisioning phase resumes the server's exact bound plan.
    // Missing browser credential references never require replacement registration.
    if (config) return;
    if (reviewedPlanBound) {
      void completeProvisioning().catch(() => undefined);
      return;
    }
    // A provided test backend may use isolated public credential references.
    if (
      localStorage.getItem(walletStorageKey("config", storageProfile)) !== null ||
      typeof ui.primaryCredentialId !== "string" ||
      !ui.primaryCredentialId.trim() ||
      typeof ui.secondaryCredentialId !== "string" ||
      !ui.secondaryCredentialId.trim() ||
      ui.primaryCredentialId === ui.secondaryCredentialId
    )
      return;
    void completeProvisioning().catch(() => undefined);
  }, [
    completeProvisioning,
    config,
    hydrated,
    storageProfile,
    ui.primaryCredentialId,
    ui.secondaryCredentialId,
    sessionManaged,
    session.authenticated,
    reviewedPlanBound,
  ]);
  const register = useCallback(
    (role: "primary" | "secondary") =>
      runWalletCriticalFlow(async () => {
        requireOnline();
        const generation = accountGeneration.current;
        if (reviewedPlanBound)
          throw new Error(
            "Existing signer keys are fixed by the reviewed plan; resume provisioning instead",
          );
        if (
          sessionManaged &&
          (!session.account || (role === "secondary" && !session.authenticated))
        )
          throw new Error(
            "Create an account and sign in with its first passkey before registering the second signer",
          );
        await backend.health?.("provision");
        requireGeneration(generation);
        const registration = await backend.registerPasskey(role);
        requireGeneration(generation);
        const otherRegistered =
          role === "primary" ? Boolean(ui.secondaryCredentialId) : Boolean(ui.primaryCredentialId);
        const next =
          role === "primary"
            ? {
                ...ui,
                primaryCredentialId: registration.credentialId,
                provisioning: otherRegistered
                  ? ("provisioning" as const)
                  : ("registering" as const),
              }
            : {
                ...ui,
                secondaryCredentialId: registration.credentialId,
                secondaryAuthenticator: registration.response.authenticatorAttachment,
                provisioning: otherRegistered
                  ? ("provisioning" as const)
                  : ("registering" as const),
              };
        saveUiState(storageProfile, next);
        setUi(next);
        if (sessionManaged && role === "primary") {
          if (!backend.signIn) throw new Error("Fresh first-passkey sign-in is unavailable");
          try {
            const transports = registration.response.response?.transports;
            await applySession(
              await (transports?.length
                ? backend.signIn(registration.credentialId, transports)
                : backend.signIn(registration.credentialId)),
              generation,
            );
          } finally {
            sessionChannel.current?.postMessage("changed");
          }
        }
        requireGeneration(generation);
        if (otherRegistered) {
          if (sessionManaged && backend.session)
            await applySession(await backend.session(), generation);
          else await completeProvisioning();
        }
      }),
    [
      backend,
      completeProvisioning,
      storageProfile,
      ui,
      sessionManaged,
      session.account,
      session.authenticated,
      reviewedPlanBound,
      requireGeneration,
      applySession,
    ],
  );
  const registerPrimary = useCallback(() => register("primary"), [register]);
  const registerSecondary = useCallback(() => register("secondary"), [register]);
  const retryProvisioning = useCallback(async () => {
    if (!sessionManaged) return completeProvisioning();
    const generation = accountGeneration.current;
    await backend.autoProvisionVault();
    requireGeneration(generation);
    if (backend.session) await applySession(await backend.session(), generation);
  }, [backend, sessionManaged, completeProvisioning, applySession, requireGeneration]);
  const requireSignedIn = useCallback(() => {
    if (sessionManaged && !session.authenticated)
      throw new Error("First-passkey sign-in is required before using the vault");
  }, [sessionManaged, session.authenticated]);
  const approveSubmission = useCallback(
    (id: string, role: "primary" | "secondary" | "none") =>
      runWalletCriticalFlow(async () => {
        requireOnline();
        const generation = accountGeneration.current;
        requireSignedIn();
        await backend.health?.();
        requireGeneration(generation);
        const request = prepared.current.get(id);
        if (!request) throw new Error("Prepared submission is unavailable; prepare it again");
        let status: SubmissionStatus;
        if (role === "none") status = await backend.submit(id, { role });
        else {
          if (!request.safeTxHash)
            throw new Error("Signed submission is missing its exact Safe transaction hash");
          const credentialId =
            role === "primary" ? ui.primaryCredentialId : ui.secondaryCredentialId;
          if (!credentialId && (role === "primary" || !sessionManaged))
            throw new Error(`${role} passkey is required for this approval`);
          if (!request.requiredApprovals.includes(role))
            throw new Error("This signer is not required for the prepared transaction");
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
            ...(credentialId ? { credentialId } : {}),
          });
          requireGeneration(generation);
          status = await backend.submit(id, { role, assertion });
        }
        requireGeneration(generation);
        rememberSubmission(id);
        await observeSubmission(status);
        return status;
      }),
    [
      backend,
      rememberSubmission,
      observeSubmission,
      state.safe,
      ui.primaryCredentialId,
      ui.secondaryCredentialId,

      sessionManaged,
      requireGeneration,
      requireSignedIn,
    ],
  );
  const prepare = useCallback(
    async (intent: SubmissionIntent) => {
      requireOnline();
      const generation = accountGeneration.current;
      requireSignedIn();
      await backend.health?.();
      requireGeneration(generation);
      const request = await backend.prepareIntent(intent);
      requireGeneration(generation);
      prepared.current.set(request.id, request);
      rememberSubmission(request.id);
      return request;
    },
    [backend, rememberSubmission, requireGeneration, requireSignedIn],
  );
  const prepareTransfer = useCallback(
    ({ recipient, amount }: Readonly<{ recipient: Address; amount: bigint }>) =>
      runWalletCriticalFlow(async () => {
        requireSignedIn();

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
    [approveSubmission, prepare, state.health.length, state.writable, requireSignedIn],
  );
  const addRecipient = useCallback(
    (recipient: Address) =>
      runWalletCriticalFlow(async () => {
        requireSignedIn();
        if (!state.writable || state.health.length > 0 || state.frozen)
          throw new Error("vault health checks are blocking recipient changes");
        const candidate = recipient.trim() as Address;
        if (!isAddress(candidate) || /^0x0{40}$/i.test(candidate))
          throw new Error("Recipient must be a valid nonzero address");
        if (
          state.recipients.some((entry) => entry.address.toLowerCase() === candidate.toLowerCase())
        )
          throw new Error("Recipient is already allowed for elevated transfers");
        const request = await prepare({
          kind: "add-recipient",
          recipient: candidate,
          idempotencyKey: crypto.randomUUID(),
        });
        if (
          request.kind !== "add-recipient" ||
          request.requiredApprovals.join(",") !== "primary,secondary"
        )
          throw new Error("Recipient addition requires both signer approvals");
        const primary = await approveSubmission(request.id, "primary");
        if (primary.state !== "awaiting-secondary")
          throw new Error("Recipient addition did not reach second-signer approval");
        return approveSubmission(request.id, "secondary");
      }),
    [
      approveSubmission,
      prepare,
      state.writable,
      state.health.length,
      state.frozen,
      state.recipients,
      requireSignedIn,
    ],
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

      const generation = accountGeneration.current;
      requireSignedIn();
      const status = await readSubmission(id);
      requireGeneration(generation);
      return status;
    },
    [readSubmission, requireGeneration, requireSignedIn],
  );
  const provision = useCallback(
    () =>
      runWalletCriticalFlow(async () => {
        requireOnline();
        if (sessionManaged)
          throw new Error("Use account creation and sequential signer registration");
        await backend.health?.("provision");
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
    [backend, completeProvisioning, storageProfile, ui, sessionManaged],
  );
  const setup = useMemo<WalletSetupState>(
    () => ({
      primaryCredentialId: ui.primaryCredentialId,
      secondaryCredentialId: ui.secondaryCredentialId,
      secondaryAuthenticator: ui.secondaryAuthenticator,
      distinctSecondary: ui.secondaryAuthenticator === "cross-platform",
      reviewedPlanBound,
      provisioning: ui.provisioning,
      receiptHash: ui.receiptHash,
      provisioningError,
      submissionIds: ui.submissionIds,
    }),
    [ui, provisioningError, reviewedPlanBound],
  );
  const activityState = useMemo(() => {
    const local: ActivityItem[] = Object.values(submissions).flatMap((status) => {
      if (status.state === "confirmed" || status.state === "superseded") return [];
      const request = prepared.current.get(status.id);
      const publicRequest = request?.publicRequest ?? status.publicRequest;
      const rawIntent = publicRequest?.["intent"];
      const intent =
        rawIntent && typeof rawIntent === "object"
          ? (rawIntent as Record<string, unknown>)
          : publicRequest;
      const savedKind = publicRequest?.["preparedKind"];
      const kind = request?.kind ?? (typeof savedKind === "string" ? savedKind : status.kind);
      const amount = publicAmount(intent?.["amount"]);
      const transfer =
        ["base-transfer", "step-up-transfer", "queue-transfer", "transfer"].includes(kind ?? "") &&
        amount !== undefined;
      const recipient =
        typeof intent?.["recipient"] === "string" ? intent["recipient"] : "Submission";
      return [
        {
          id: `submission:${status.id}`,
          kind:
            kind === "add-recipient"
              ? "recipient-addition"
              : kind === "cancel-queued"
                ? "cancel"
                : kind === "execute-ready"
                  ? "execute"
                  : kind === "skip-expired"
                    ? "skip"
                    : transfer
                      ? "transfer"
                      : "unsupported",
          direction: "out",
          amount: amount ?? 0n,
          address: recipient,
          counterparty: recipient,
          lane:
            transfer && kind === "base-transfer"
              ? "base"
              : transfer && kind === "step-up-transfer"
                ? "step-up"
                : [
                      "queue-transfer",
                      "add-recipient",
                      "cancel-queued",
                      "execute-ready",
                      "skip-expired",
                    ].includes(kind ?? "") &&
                    (kind !== "queue-transfer" || transfer)
                  ? "delayed"
                  : "blocked",
          status:
            status.state === "reverted"
              ? "failed"
              : status.state === "awaiting-primary" || status.state === "prepared"
                ? "awaiting_first_signer"
                : status.state === "awaiting-secondary"
                  ? "awaiting_second_signer"
                  : "submitting",
          createdAt:
            status.createdAt ??
            (typeof publicRequest?.["preparedAt"] === "number" ? publicRequest["preparedAt"] : 0),
          ...(status.transactionHash ? { txHash: status.transactionHash } : {}),
          approvers: [],
          fingerprint: status.requestHash ?? status.id,
        } satisfies ActivityItem,
      ];
    });
    return {
      ...state,
      activity: mergeBackendHistory(history.items, state.activity, local, history.observedAt),
    };
  }, [state, history, submissions]);
  const sendUsdc = prepareTransfer;
  const value = useMemo(
    () => ({
      state: activityState,
      setup,
      hydrated,
      loading,
      hasAccount: Boolean(config),
      sessionManaged,
      authenticated: session.authenticated,
      accountId: session.account?.id,
      signIn,

      signOut,
      createAccount,
      canWrite:
        (!sessionManaged || session.authenticated) &&
        activityState.writable &&
        activityState.health.length === 0,
      finishSetup,
      refresh,
      loadMoreHistory,
      historyHasMore: Boolean(history.nextCursor),
      historyLoading,
      historyError,
      registerPrimary,
      registerSecondary,
      retryProvisioning,

      addRecipient,
      prepareTransfer,
      approveSubmission,
      cancelQueued,
      executeReady,
      reconcileSubmission,
      submissions,
      provision,
      sendUsdc,
    }),
    [
      activityState,
      setup,
      hydrated,
      loading,
      config,
      sessionManaged,
      session,
      signIn,

      signOut,
      createAccount,

      finishSetup,
      refresh,
      loadMoreHistory,
      history.nextCursor,
      historyLoading,
      historyError,
      registerPrimary,
      registerSecondary,
      retryProvisioning,

      addRecipient,
      prepareTransfer,
      approveSubmission,
      cancelQueued,
      executeReady,
      reconcileSubmission,
      submissions,
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
