import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AuthenticationResponseJSON } from "@simplewebauthn/browser";
import { createPublicClient, http, keccak256, toHex, type Address, type Hex, type PublicClient } from "viem";
import { sepolia } from "viem/chains";
import { usdc } from "./usdc";
import { fingerprintOf, type ActivityItem, type Lane } from "./activity-model";
import { readVaultSnapshot, type HealthFailure, type VaultConfig, type VaultSnapshot } from "./vault-chain";
import { challengeForSafeDigest, createVaultPasskey, signSafeDigest, type PasskeyRegistration } from "./webauthn-passkey";
import { loadWalletEnvironmentProfile, type WalletEnvironmentProfile } from "./environment-profile";

export type Recipient = { name: string; address: string };
export type Policy = { basePerTxCap: bigint; firstSignerDaily: bigint; instantDaily: bigint; perTxCap: bigint; delayHours: number; delaySeconds: bigint };
export type Onboarding = { firstSigner: boolean; secondSigner: boolean; limits: boolean; rehearsed: boolean };

export type VaultState = {
  chainId: number; network: string; safe: string; guard: string; delay: string; usdc: string;
  balance: bigint; nativeBalance: bigint; safeNonce: bigint | null; policy: Policy;
  spentFirstSigner: bigint; spentInstant: bigint; resetsAt: number; secondSignerName: string; frozen: boolean;
  writable: boolean; health: readonly HealthFailure[]; onboarding: Onboarding; recipients: Recipient[];
  activity: ActivityItem[]; notifications: { email: boolean; push: boolean }; deploymentHash: Hex; policyHash: Hex;
};

export type VaultProvisioningResult = Readonly<{
  chainId: 11155111; safe: Address; guard: Address; delay: Address; primaryPasskey: Address; secondaryPasskey: Address; usdc: Address;
  evidence: Readonly<{ setupTransactionHash: `0x${string}`; verificationReportHash: `0x${string}` }>;
}>;

export type BackendRegistrationOptions = Readonly<{
  sessionId: string; challenge: string; rpId: string; origin: string; role: "primary" | "secondary";
  userVerification: "required"; authenticatorAttachment: "platform" | "cross-platform";
}>;

export type VaultBackend = Readonly<{
  health?: () => Promise<void>;
  registerPasskey: (role: "primary" | "secondary") => Promise<PasskeyRegistration>;
  provisionVault: (input: Readonly<{ primaryCredentialId: string; secondaryCredentialId: string; usdc: Address; chainId: 11155111 }>) => Promise<VaultProvisioningResult>;
  prepareTransfer: (input: PreparedTransferInput) => Promise<SafeExecutionRequest>;
  submitPrimary: (id: Hex, assertion: AuthenticationResponseJSON) => Promise<SubmissionStatus>;
  submitSecondary: (id: Hex, assertion: AuthenticationResponseJSON) => Promise<SubmissionStatus>;
}>;

export type PreparedTransferInput = Readonly<{
  chainId: 11155111; safe: Address; guard: Address; usdc: Address; configuredUsdc: Address; recipient: Address; amount: bigint; nonce: bigint;
  deploymentHash: Hex; policyHash: Hex; idempotencyKey: Hex; expectedSpend: Readonly<{ window: bigint; baseSpent: bigint; instantSpent: bigint }>;
  allowedRecipients: readonly Address[];
}>;
export type SafeExecutionRequest = Readonly<{ idempotencyKey: Hex; safeTxHash: Hex; safe: Address; chainId: 11155111; transaction: Readonly<{ to: Address; value: bigint; data: Hex; operation: 0; nonce: bigint }>; requiredApprovals?: "primary" | "secondary" | "delayed" }>;
export type SubmissionStatus = Readonly<{ id: Hex; state: "awaiting_secondary" | "queued" | "confirmed" | "reverted"; requiredApprovals: "primary" | "secondary" | "delayed"; safeTxHash: Hex; transactionHash?: Hex }>;

export type VaultProviderProps = { children: ReactNode; client?: PublicClient; config?: VaultConfig; backend?: VaultBackend };

const KEY = "usdc-vault-demo-v1";
const UI_KEY = "usdc-vault-ui-v1";
const DEFAULT_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Address;
const nextReset = () => { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d.getTime(); };
const randAddr = () => "0x" + Array.from({ length: 40 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
const unprovisionedHealth: readonly HealthFailure[] = [{ code: "unprovisioned", message: "Provision a fresh guarded Safe before using this wallet", blocking: true }];

export function emptyState(): VaultState {
  return {
    chainId: 11155111, network: "Ethereum Sepolia (testnet)", safe: "", guard: "", delay: "", usdc: "", balance: 0n, nativeBalance: 0n, safeNonce: null,
    policy: { basePerTxCap: usdc(250), firstSignerDaily: usdc(250), instantDaily: usdc(1000), perTxCap: usdc(2500), delayHours: 24, delaySeconds: 86_400n },
    spentFirstSigner: 0n, spentInstant: 0n, resetsAt: nextReset(), secondSignerName: "Second signer", frozen: false, writable: false,
    health: unprovisionedHealth, onboarding: { firstSigner: false, secondSigner: false, limits: false, rehearsed: false }, recipients: [], activity: [], notifications: { email: true, push: false }, deploymentHash: "0x", policyHash: "0x",
  };
}

/** Compatibility fixture retained for unit tests; production screens never load simulated balances. */
export function demoState(): VaultState {
  const s = emptyState(); const now = Date.now(); const address = randAddr();
  const item: ActivityItem = { id: crypto.randomUUID(), direction: "in", amount: usdc(100), counterparty: "Test USDC", address, lane: "base", status: "executed", createdAt: now, approvers: [], fingerprint: fingerprintOf([address, now]) };
  return { ...s, balance: usdc(100), activity: [item] };
}

function readUiState(): { notifications: VaultState["notifications"]; rehearsed: boolean; primaryCredentialId?: string | undefined; secondaryCredentialId?: string | undefined; deploymentHash?: Hex | undefined; policyHash?: Hex | undefined } {
  try {
    const parsed = JSON.parse(localStorage.getItem(UI_KEY) ?? "null") as Partial<{ notifications: VaultState["notifications"]; rehearsed: boolean; primaryCredentialId: string; secondaryCredentialId: string; deploymentHash: Hex; policyHash: Hex }> | null;
    return { notifications: parsed?.notifications ?? { email: true, push: false }, rehearsed: parsed?.rehearsed === true, primaryCredentialId: parsed?.primaryCredentialId, secondaryCredentialId: parsed?.secondaryCredentialId, deploymentHash: parsed?.deploymentHash as Hex | undefined, policyHash: parsed?.policyHash as Hex | undefined };
  } catch { return { notifications: { email: true, push: false }, rehearsed: false }; }
}

function readConfig(): VaultConfig | undefined {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Record<keyof VaultConfig, string>> | null;
    if (!parsed || !parsed.safe || !parsed.guard || !parsed.delay || !parsed.usdc) return undefined;
    if (![parsed.safe, parsed.guard, parsed.delay, parsed.usdc].every((value) => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value))) return undefined;
    return { chainId: 11155111, safe: parsed.safe as Address, guard: parsed.guard as Address, delay: parsed.delay as Address, usdc: parsed.usdc as Address, usdcCandidates: [DEFAULT_USDC] };
  } catch { return undefined; }
}

function saveConfig(config: VaultConfig): void { localStorage.setItem(KEY, JSON.stringify({ chainId: config.chainId, safe: config.safe, guard: config.guard, delay: config.delay, usdc: config.usdc, usdcCandidates: config.usdcCandidates })); }

function defaultClient(): PublicClient | undefined {
  const rpcUrl = (import.meta.env["VITE_SEPOLIA_RPC_URL"] as string | undefined)?.trim();
  return rpcUrl ? createPublicClient({ chain: sepolia, transport: http(rpcUrl) }) : undefined;
}

export async function checkBackendHealth(profile: WalletEnvironmentProfile, requester: typeof fetch = fetch): Promise<void> {
  const response = await requester(`${profile.backendOrigin}/health`, { headers: { accept: "application/json" }, credentials: profile.credentials });
  let payload: { ok?: unknown; error?: unknown; chainId?: unknown; profileId?: unknown; origin?: unknown; rpId?: unknown } = {};
  try { payload = await response.json() as typeof payload; } catch { /* bounded error below */ }
  if (!response.ok || payload.ok !== true) throw new Error(`Backend health check failed: ${typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`}`);
  if (payload.chainId !== profile.chainId || payload.profileId !== profile.id || payload.origin !== profile.appOrigin || payload.rpId !== profile.rpId) throw new Error("Backend health profile does not match the active wallet environment");
}

function activeEnvironmentProfile(): WalletEnvironmentProfile {
  const configuredOrigin = (import.meta.env["VITE_APP_ORIGIN"] as string | undefined)?.trim() || "http://localhost:5173";
  const observedOrigin = typeof window === "undefined" || window.location.origin === "null" ? configuredOrigin : window.location.origin;
  return loadWalletEnvironmentProfile(import.meta.env, observedOrigin);
}

function defaultBackend(): VaultBackend {
  const json = async (url: string, init?: RequestInit): Promise<any> => {
    const profile = activeEnvironmentProfile();
    const response = await fetch(`${profile.backendOrigin}${url}`, { ...init, credentials: profile.credentials, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
    const payload = JSON.parse(await response.text(), (key, value) => ["amount", "nonce", "window", "baseSpent", "instantSpent", "safeTxGas", "baseGas", "gasPrice"].includes(key) && typeof value === "string" && /^\d+n$/.test(value) ? BigInt(value.slice(0, -1)) : value) as { error?: string; request?: SafeExecutionRequest };
    if (!response.ok) throw new Error(payload.error ?? `Backend request failed (${response.status})`);
    return payload;
  };
  return {
    async health() { await checkBackendHealth(activeEnvironmentProfile()); },
    async registerPasskey(role) {
      const profile = activeEnvironmentProfile();
      const options = await json(`/v1/registrations/${role}/options`, { method: "POST", body: "{}" }) as BackendRegistrationOptions;
      if (options.role !== role || options.origin !== profile.appOrigin || options.rpId !== profile.rpId) throw new Error("Backend registration profile does not match the active wallet environment");
      const registrationOptions = {
        challenge: options.challenge, rp: { id: options.rpId, name: "USDC Vault Demo" },
        user: { id: `${role}-${options.sessionId}`, name: `${role}@${profile.rpId}`, displayName: role === "primary" ? "First signer" : "Second signer" },
        pubKeyCredParams: [{ alg: -7, type: "public-key" }],
        authenticatorSelection: { authenticatorAttachment: options.authenticatorAttachment, userVerification: "required", residentKey: "preferred" }, timeout: 60_000, attestation: "none",
      };
      const registration = await createVaultPasskey({ role, challenge: options.challenge, rpId: options.rpId, origin: options.origin, options: registrationOptions });
      await json(`/v1/registrations/${role}/verify`, { method: "POST", body: JSON.stringify({ sessionId: options.sessionId, registration: registration.response }) });
      return registration;
    },
    async provisionVault(input) { return json("/v1/vaults", { method: "POST", body: JSON.stringify(input) }) as Promise<VaultProvisioningResult>; },
    async prepareTransfer(input) {
      const payload = await json("/v1/submissions/prepare", { method: "POST", body: JSON.stringify(input, (_key, value) => typeof value === "bigint" ? `${value}n` : value) }) as { request?: SafeExecutionRequest } | SafeExecutionRequest;
      return ("request" in payload && payload.request ? payload.request : payload) as SafeExecutionRequest;
    },
    async submitPrimary(id, assertion) { return json(`/v1/submissions/${id}/submit`, { method: "POST", body: JSON.stringify({ role: "primary", assertion }) }) as Promise<SubmissionStatus>; },
    async submitSecondary(id, assertion) { return json(`/v1/submissions/${id}/submit`, { method: "POST", body: JSON.stringify({ role: "secondary", assertion }) }) as Promise<SubmissionStatus>; },
  };
}

function project(snapshot: VaultSnapshot, ui: { notifications: VaultState["notifications"]; rehearsed: boolean }): VaultState {
  const configured = snapshot.policy; const delaySeconds = snapshot.topology?.delay.cooldownSeconds ?? 86_400n; const delayHours = Math.max(1, Math.ceil(Number(delaySeconds) / 3_600));
  const recipients = configured?.recipients.map((address) => ({ name: address, address })) ?? [];
  const onboarding = { firstSigner: Boolean(snapshot.safe && snapshot.writable), secondSigner: Boolean(snapshot.safe && snapshot.topology?.delay && snapshot.writable), limits: Boolean(configured && configured.baseDailyLimit > 0n && configured.baseDailyLimit < configured.instantDailyLimit), rehearsed: ui.rehearsed };
  const periodAnchor = snapshot.spendState?.window;
  const activity: ActivityItem[] = snapshot.queueItems.map((item) => {
    const createdAt = Number(item.createdAt) * 1000;
    const earliestExecution = createdAt + Number(delaySeconds) * 1000;
    const expiresAt = earliestExecution + Number(snapshot.topology?.delay.expirationSeconds ?? 0n) * 1000;
    const status = expiresAt > createdAt && Date.now() >= expiresAt ? "expired" : Date.now() >= earliestExecution ? "ready" : "queued";
    return { id: `${item.txHash}:${item.queueNonce.toString()}`, direction: "out", amount: 0n, counterparty: "Delayed USDC operation", address: snapshot.safe, lane: "delayed", status, createdAt, earliestExecution, expiresAt, txHash: item.txHash, queueNonce: Number(item.queueNonce), approvers: ["First signer", "Second signer"], fingerprint: fingerprintOf([snapshot.safe, item.txHash, item.queueNonce]) } satisfies ActivityItem;
  });
  return {
    chainId: snapshot.chainId, network: "Ethereum Sepolia (testnet)", safe: snapshot.safe, guard: snapshot.topology?.guard ?? "", delay: snapshot.topology?.delay.address ?? "", usdc: snapshot.usdc?.address ?? "",
    balance: snapshot.usdcBalance ?? 0n, nativeBalance: snapshot.nativeBalance ?? 0n, safeNonce: snapshot.safeNonce ?? null,
    policy: { basePerTxCap: configured?.basePerTransaction ?? 0n, firstSignerDaily: configured?.baseDailyLimit ?? 0n, instantDaily: configured?.instantDailyLimit ?? 0n, perTxCap: configured?.stepUpPerTransaction ?? 0n, delayHours, delaySeconds },
    spentFirstSigner: snapshot.spendState?.baseSpent ?? 0n, spentInstant: snapshot.spendState?.instantSpent ?? 0n, resetsAt: periodAnchor && periodAnchor > 0n ? Number(periodAnchor) * 1000 : nextReset(),
    secondSignerName: "Second signer", frozen: snapshot.topology?.frozen ?? false, writable: snapshot.writable, health: snapshot.health, onboarding, recipients, activity, notifications: ui.notifications, deploymentHash: "0x", policyHash: "0x",
  };
}

export type Classification = { lane: Lane; reason?: string };
/** Advisory only; the onchain guard remains authoritative. */
export function classify(s: VaultState, to: string, amount: bigint): Classification {
  if (!s.writable || s.frozen) return { lane: "blocked", reason: s.frozen ? "Your account is frozen. Unfreeze it in Limits & security first." : "The vault is not healthy or provisioned yet." };
  if (amount <= 0n) return { lane: "blocked", reason: "Enter an amount above 0 USDC." };
  if (amount > s.balance) return { lane: "blocked", reason: "This is more than your available balance." };
  if (!s.recipients.some((r) => r.address.toLowerCase() === to.toLowerCase())) return { lane: "blocked", reason: "This recipient is not on your allowed list." };
  if (amount > s.policy.perTxCap) return { lane: "blocked", reason: "This is above the maximum for a single transfer." };
  if (s.spentInstant + amount > s.policy.instantDaily) return { lane: "delayed" };
  if (s.spentFirstSigner + amount > s.policy.firstSignerDaily) return { lane: "step-up" };
  return { lane: "base" };
}

type Ctx = { state: VaultState; hydrated: boolean; loading: boolean; hasAccount: boolean; canWrite: boolean; finishSetup: () => void; refresh: () => Promise<void>; provision: () => Promise<void>; sendUsdc: (input: Readonly<{ recipient: Address; amount: bigint }>) => Promise<SubmissionStatus> };
const VaultCtx = createContext<Ctx | null>(null);

export function VaultProvider({ children, client: providedClient, config: providedConfig, backend: providedBackend }: VaultProviderProps) {
  const [state, setState] = useState<VaultState>(emptyState); const [hydrated, setHydrated] = useState(false); const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<VaultConfig | undefined>(providedConfig);
  const client = useMemo(() => providedClient ?? defaultClient(), [providedClient]);
  const backend = useMemo(() => providedBackend ?? defaultBackend(), [providedBackend]);
  const [ui, setUi] = useState(readUiState);
  const refresh = useCallback(async () => {
    if (!config || !client) { const blank = emptyState(); setState({ ...blank, notifications: ui.notifications, onboarding: { ...blank.onboarding, rehearsed: ui.rehearsed } }); setLoading(false); return; }
    setLoading(true);
    try { setState(project(await readVaultSnapshot(client, config), ui)); }
    catch (error) { const blank = emptyState(); setState({ ...blank, notifications: ui.notifications, health: [{ code: "rpc-inconsistent", message: error instanceof Error ? error.message : "Vault read failed", blocking: true }] }); }
    finally { setLoading(false); setHydrated(true); }
  }, [client, config, ui]);
  useEffect(() => { const stored = providedConfig ?? readConfig(); setConfig(stored); setHydrated(true); }, [providedConfig]);
  useEffect(() => { if (hydrated) void refresh(); }, [config, hydrated, refresh]);
  useEffect(() => { if (hydrated) localStorage.setItem(UI_KEY, JSON.stringify(ui)); }, [hydrated, ui]);
  const finishSetup = useCallback(() => { setUi((current) => ({ ...current, rehearsed: true })); }, []);
  const provision = useCallback(async () => {
    if (!client) throw new Error("Set VITE_SEPOLIA_RPC_URL before provisioning the demo vault");
    await backend.health?.();
    const primary = await backend.registerPasskey("primary"); const secondary = await backend.registerPasskey("secondary");
    if (primary.credentialId === secondary.credentialId) throw new Error("Primary and secondary passkeys must be distinct");
    const result = await backend.provisionVault({ chainId: 11155111, usdc: providedConfig?.usdc ?? DEFAULT_USDC, primaryCredentialId: primary.credentialId, secondaryCredentialId: secondary.credentialId });
    const next: VaultConfig = { chainId: 11155111, safe: result.safe, guard: result.guard, delay: result.delay, usdc: result.usdc, usdcCandidates: [DEFAULT_USDC] }; saveConfig(next); setUi((current) => ({ ...current, rehearsed: false, primaryCredentialId: primary.credentialId, secondaryCredentialId: secondary.credentialId, deploymentHash: result.evidence.setupTransactionHash, policyHash: result.evidence.verificationReportHash })); setConfig(next);
  }, [backend, client, providedConfig, ui]);
  const sendUsdc = useCallback(async ({ recipient, amount }: Readonly<{ recipient: Address; amount: bigint }>) => {
    if (!state.writable || state.health.length > 0) throw new Error("vault health checks are blocking writes");
    await backend.health?.();
    if (!ui.primaryCredentialId || !ui.deploymentHash || !ui.policyHash) throw new Error("passkey session and reviewed deployment evidence are required");
    const idempotencyKey = keccak256(toHex(`${state.safe}:${recipient}:${amount.toString()}:${state.safeNonce?.toString() ?? ""}:${Date.now()}`));
    const prepared = await backend.prepareTransfer({ chainId: 11155111, safe: state.safe as Address, guard: state.guard as Address, usdc: state.usdc as Address, configuredUsdc: state.usdc as Address, recipient, amount, nonce: state.safeNonce ?? 0n, deploymentHash: ui.deploymentHash, policyHash: ui.policyHash, idempotencyKey, expectedSpend: { window: BigInt(Math.max(0, Math.floor(state.resetsAt / 1000) - 86_400)), baseSpent: state.spentFirstSigner, instantSpent: state.spentInstant }, allowedRecipients: state.recipients.map((entry) => entry.address as Address) });
    const environment = activeEnvironmentProfile();
    const assertion = (role: "primary" | "secondary", credentialId: string) => signSafeDigest({ role, safe: state.safe as Address, chainId: 11155111, safeTxHash: prepared.safeTxHash, challenge: challengeForSafeDigest(prepared.safeTxHash), challengeBinding: { safe: state.safe as Address, chainId: 11155111, safeTxHash: prepared.safeTxHash }, rpId: environment.rpId, origin: environment.appOrigin, credentialId });
    const primary = await backend.submitPrimary(prepared.idempotencyKey, await assertion("primary", ui.primaryCredentialId));
    if (primary.state !== "awaiting_secondary") { await refresh(); return primary; }
    if (!ui.secondaryCredentialId) throw new Error("secondary passkey session is required for this tier");
    const secondary = await backend.submitSecondary(prepared.idempotencyKey, await assertion("secondary", ui.secondaryCredentialId));
    await refresh(); return secondary;
  }, [backend, refresh, state, ui]);
  const value = useMemo(() => ({ state, hydrated, loading, hasAccount: Boolean(config), canWrite: state.writable && state.health.length === 0, finishSetup, refresh, provision, sendUsdc }), [state, hydrated, loading, config, finishSetup, refresh, provision, sendUsdc]);
  return <VaultCtx.Provider value={value}>{children}</VaultCtx.Provider>;
}

export function useVault(): Ctx { const c = useContext(VaultCtx); if (!c) throw new Error("useVault outside VaultProvider"); return c; }
export function useNow(intervalMs = 30_000) { const [now, setNow] = useState(() => Date.now()); useEffect(() => { const t = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(t); }, [intervalMs]); return now; }
export const isAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a.trim());
export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const newId = () => crypto.randomUUID();
export { randAddr };
