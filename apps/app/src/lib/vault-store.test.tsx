import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import {
  createPublicClient,
  encodeFunctionData,
  encodePacked,
  keccak256,
  parseAbi,
  type Address,
  type PublicClient,
} from "viem";

vi.mock("viem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("viem")>()),
  createPublicClient: vi.fn(),
}));
vi.mock("./webauthn-passkey", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./webauthn-passkey")>()),
  signSafeDigest: vi.fn(async ({ role, credentialId }) => ({
    id: credentialId,
    rawId: credentialId,
    type: "public-key",
    clientExtensionResults: {},
    response: { authenticatorData: "AA", clientDataJSON: "AA", signature: "AA", userHandle: null },
    role,
  })),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  localStorage.clear();
});
import {
  checkBackendHealth,
  useVault,
  VaultProvider,
  walletStorageKey,
  type VaultBackend,
  type VaultProvisioningResult,
} from "./vault-store";
import type { WalletEnvironmentProfile } from "./environment-profile";
import type { VaultConfig } from "./vault-chain";
import { TEST_USDC_ADDRESS, TEST_USDC_RUNTIME } from "./usdc-test-fixture";
import { activateWaitingServiceWorkerWhenSafe } from "./pwa";

const SAFE = "0x1111111111111111111111111111111111111111" as Address;
const GUARD = "0x2222222222222222222222222222222222222222" as Address;
const DELAY = "0x3333333333333333333333333333333333333333" as Address;
const USDC = TEST_USDC_ADDRESS;
const RECIPIENT = "0x7777777777777777777777777777777777777777" as Address;

const config: VaultConfig = {
  chainId: 11155111,
  safe: SAFE,
  guard: GUARD,
  delay: DELAY,
  usdc: USDC,
  usdcCandidates: [USDC],
};

function makeClient(
  values: { balance?: bigint; baseSpent?: bigint; safeNonce?: number; chainId?: number } = {},
): PublicClient {
  return {
    getChainId: vi.fn().mockResolvedValue(values.chainId ?? 11155111),
    getBlockNumber: vi.fn().mockResolvedValue(123n),
    getBlock: vi.fn().mockResolvedValue({ hash: `0x${"ab".repeat(32)}`, timestamp: 456n }),
    getBytecode: vi.fn().mockResolvedValue(TEST_USDC_RUNTIME),
    getBalance: vi.fn().mockResolvedValue(values.balance ?? 2_000_000_000_000_000n),
    getTransactionCount: vi.fn().mockResolvedValue(values.safeNonce ?? 7),
    getStorageAt: vi.fn().mockImplementation(async ({ slot }: { slot: string }) => {
      if (slot.endsWith("c34c8") || slot.endsWith("9947"))
        return `0x${GUARD.slice(2).padStart(64, "0")}`;
      return "0x0000000000000000000000000000000000000000000000000000000000000000";
    }),
    readContract: vi.fn().mockImplementation(async ({ functionName }: { functionName: string }) => {
      const valuesByFunction: Record<string, unknown> = {
        name: "USDC",
        symbol: "USDC",
        decimals: 6,
        balanceOf: 12_345_678n,
        nonce: BigInt(values.safeNonce ?? 7),
        getModulesPaginated: [[DELAY], "0x0000000000000000000000000000000000000001"],
        config: [
          SAFE,
          "0x5555555555555555555555555555555555555555",
          "0x6666666666666666666666666666666666666666",
          DELAY,
          86400n,
          0n,
        ],
        frozen: false,
        getConfiguredTokens: [USDC],
        assetPolicy: [100_000_000n, 200_000_000n, 250_000_000n, 1_000_000_000n, 1],
        getPolicyRecipients: [RECIPIENT],
        spendState: [0n, values.baseSpent ?? 0n, 0n],
        owner: SAFE,
        avatar: SAFE,
        target: SAFE,
        txCooldown: 120n,
        txExpiration: 600n,
        txNonce: 0n,
        queueNonce: 0n,
      };
      return valuesByFunction[functionName];
    }),
  } as unknown as PublicClient;
}

function wrapper(
  options: { client?: PublicClient; config?: VaultConfig; backend?: VaultBackend } = {},
) {
  return ({ children }: { children: ReactNode }) =>
    createElement(VaultProvider, { ...options, children }, children);
}

describe("VaultProvider", () => {
  it("blocks writes when backend readiness is unhealthy", async () => {
    const profile: WalletEnvironmentProfile = {
      id: "local",
      chainId: 11155111,
      appOrigin: "http://localhost:5173",
      rpId: "localhost",
      backendOrigin: "http://127.0.0.1:8787",
      credentials: "omit",
    };
    await expect(
      checkBackendHealth(
        profile,
        async () => new Response(JSON.stringify({ error: "RPC unavailable" }), { status: 503 }),
      ),
    ).rejects.toThrow(/Backend health check failed: RPC unavailable/);

    await expect(
      checkBackendHealth(
        profile,
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              chainId: 11155111,
              profileId: "https",
              origin: "https://vault.example",
              rpId: "vault.example",
            }),
          ),
      ),
    ).rejects.toThrow(/profile/i);
  });

  it("starts unprovisioned and directs the user to onboarding", async () => {
    const { result } = renderHook(() => useVault(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.hydrated).toBe(true));

    expect(result.current.state.onboarding.firstSigner).toBe(false);
    expect(result.current.state.safe).toBe("");
    expect(result.current.state.writable).toBe(false);
    expect(result.current.state.health[0]?.code).toBe("unprovisioned");
  });

  it("exposes balances, policy, native gas, and nonce from a healthy snapshot", async () => {
    const { result } = renderHook(() => useVault(), {
      wrapper: wrapper({ client: makeClient(), config }),
    });

    await waitFor(() => expect(result.current.state.writable).toBe(true));

    expect(result.current.state.safe).toBe(SAFE);
    expect(result.current.state.usdc).toBe(USDC);
    expect(result.current.state.balance).toBe(12_345_678n);
    expect(result.current.state.nativeBalance).toBe(2_000_000_000_000_000n);
    expect(result.current.state.safeNonce).toBe(7n);
    expect(result.current.state.policy).toMatchObject({
      basePerTxCap: 100_000_000n,
      firstSignerDaily: 250_000_000n,
      instantDaily: 1_000_000_000n,
      delayHours: 1,
    });
    expect(result.current.state.recipients).toEqual([{ name: RECIPIENT, address: RECIPIENT }]);
  });

  it("projects the exact canonical Delay tuple instead of a zero-value placeholder", async () => {
    const data = encodeFunctionData({
      abi: parseAbi(["function transfer(address,uint256) returns (bool)"]),
      functionName: "transfer",
      args: [RECIPIENT, 4_000_000n],
    });
    const txHash = keccak256(
      encodePacked(["address", "uint256", "bytes", "uint8"], [USDC, 0n, data, 0]),
    );
    const queued = makeClient();
    const baseRead = vi.mocked(queued.readContract).getMockImplementation();
    if (!baseRead) throw new Error("test reader is missing its base implementation");
    vi.mocked(queued.readContract).mockImplementation(async (input) => {
      if (input.functionName === "queueNonce") return 1n as never;
      if (input.functionName === "getTxHash") return txHash as never;
      if (input.functionName === "getTxCreatedAt") return 100n as never;
      return baseRead(input) as never;
    });
    Object.assign(queued, {
      getLogs: vi
        .fn()
        .mockResolvedValue([
          { args: { queueNonce: 0n, txHash, to: USDC, value: 0n, data, operation: 0 } },
        ]),
    });

    const { result } = renderHook(() => useVault(), {
      wrapper: wrapper({ client: queued, config }),
    });
    await waitFor(() => expect(result.current.state.writable).toBe(true));

    expect(result.current.state.activity).toEqual([
      expect.objectContaining({ amount: 4_000_000n, address: RECIPIENT, counterparty: RECIPIENT }),
    ]);
  });

  it("disables writes for every blocking health failure", async () => {
    const { result } = renderHook(() => useVault(), {
      wrapper: wrapper({ client: makeClient({ chainId: 1 }), config }),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.state.writable).toBe(false);
    expect(result.current.canWrite).toBe(false);
    expect(result.current.state.health).toEqual([
      expect.objectContaining({ code: "wrong-chain", blocking: true }),
    ]);
  });

  it("replaces stale chain state on refresh instead of merging local simulation", async () => {
    const first = makeClient({ balance: 12_000_000n, baseSpent: 1_000_000n, safeNonce: 7 });
    const fallback = makeClient();
    const client = first as PublicClient;
    let nonce = 7n;
    let baseSpent = 1_000_000n;
    let usdcBalance = 12_345_678n;
    const getBalance = vi
      .spyOn(client, "getBalance")
      .mockResolvedValueOnce(2_000_000_000_000_000n)
      .mockResolvedValueOnce(3_000_000_000_000_000n);
    const readContract = vi.spyOn(client, "readContract");
    readContract.mockImplementation(async (args) => {
      if (args.functionName === "nonce") return nonce as never;
      if (args.functionName === "spendState") return [0n, baseSpent, 0n] as never;
      if (args.functionName === "balanceOf") return usdcBalance as never;
      return (fallback.readContract as unknown as (input: unknown) => Promise<unknown>)(
        args,
      ) as never;
    });

    const { result } = renderHook(() => useVault(), { wrapper: wrapper({ client, config }) });
    await waitFor(() => expect(result.current.state.writable).toBe(true));
    const before = result.current.state.safeNonce;

    nonce = 8n;
    baseSpent = 3_000_000n;
    usdcBalance = 8_000_000n;
    await act(async () => {
      await result.current.refresh();
    });

    expect(before).toBe(7n);
    expect(result.current.state.safeNonce).toBe(8n);
    expect(result.current.state.nativeBalance).toBe(3_000_000_000_000_000n);
    expect(result.current.state.activity).toEqual([]);
    expect(getBalance).toHaveBeenCalledTimes(2);
  });

  it("does not poll the chain after the initial vault snapshot", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const client = makeClient();
    const { result } = renderHook(() => useVault(), { wrapper: wrapper({ client, config }) });

    await waitFor(() => expect(result.current.state.writable).toBe(true));
    const initialReads = vi.mocked(client.getBlockNumber).mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });

    expect(initialReads).toBe(1);
    expect(client.getBlockNumber).toHaveBeenCalledTimes(1);
  });
});

it("keeps the configured RPC client stable across provider rerenders", async () => {
  vi.stubEnv("VITE_SEPOLIA_RPC_URL", "http://localhost:9999");
  const rpcClient = makeClient();
  vi.mocked(createPublicClient).mockReturnValue(rpcClient);
  const { result, rerender } = renderHook(() => useVault(), { wrapper: wrapper({ config }) });
  await waitFor(() => expect(result.current.state.writable).toBe(true));
  rerender();
  expect(createPublicClient).toHaveBeenCalledTimes(1);
  expect(createPublicClient).toHaveBeenCalledWith(expect.objectContaining({
    batch: { multicall: { wait: 10 } },
  }));
});

it("keeps newly provisioned signer references when finishing setup", async () => {
  const backend: VaultBackend = {
    registerPasskey: async (role) => ({
      role,
      credentialId: `${role}-credential`,
      challenge: "challenge",
      rpId: "localhost",
      origin: "http://localhost:5173",
      response: {
        id: `${role}-credential`,
        rawId: `${role}-credential`,
        type: "public-key",
        clientExtensionResults: {},
        response: { clientDataJSON: "e30", attestationObject: "e30" },
      },
    }),
    autoProvisionVault: async () => ({
      chainId: 11155111,
      safe: SAFE,
      guard: GUARD,
      delay: DELAY,
      usdc: USDC,
      primaryPasskey: SAFE,
      secondaryPasskey: GUARD,
      evidence: { setupTransactionHash: "0x11", verificationReportHash: "0x22" },
    }),
    prepareIntent: vi.fn(),
    submit: vi.fn(),
    submission: vi.fn(),
  };
  const { result } = renderHook(() => useVault(), {
    wrapper: wrapper({ client: makeClient(), config, backend }),
  });
  await waitFor(() => expect(result.current.hydrated).toBe(true));
  await act(async () => {
    await result.current.provision();
  });
  await waitFor(() =>
    expect(
      JSON.parse(
        localStorage.getItem(walletStorageKey("ui", { id: "local", rpId: "localhost" })) ?? "{}",
      ),
    ).toMatchObject({
      primaryCredentialId: "primary-credential",
      secondaryCredentialId: "secondary-credential",
    }),
  );
  act(() => result.current.finishSetup());
  await waitFor(() =>
    expect(
      JSON.parse(
        localStorage.getItem(walletStorageKey("ui", { id: "local", rpId: "localhost" })) ?? "{}",
      ),
    ).toMatchObject({
      primaryCredentialId: "primary-credential",
      secondaryCredentialId: "secondary-credential",
      deploymentHash: "0x11",
      policyHash: "0x22",
      rehearsed: true,
    }),
  );
});

it("defers a waiting service-worker update throughout WebAuthn provisioning", async () => {
  let releaseRegistration!: () => void;
  const registrationGate = new Promise<void>((resolve) => {
    releaseRegistration = resolve;
  });
  const backend: VaultBackend = {
    registerPasskey: async (role) => {
      await registrationGate;
      return {
        role,
        credentialId: `${role}-credential`,
        challenge: "challenge",
        rpId: "localhost",
        origin: "http://localhost:5173",
        response: {
          id: `${role}-credential`,
          rawId: `${role}-credential`,
          type: "public-key",
          clientExtensionResults: {},
          response: { clientDataJSON: "e30", attestationObject: "e30" },
        },
      };
    },
    autoProvisionVault: async () => ({
      chainId: 11155111,
      safe: SAFE,
      guard: GUARD,
      delay: DELAY,
      usdc: USDC,
      primaryPasskey: SAFE,
      secondaryPasskey: GUARD,
      evidence: { setupTransactionHash: "0x11", verificationReportHash: "0x22" },
    }),
    prepareIntent: vi.fn(),
    submit: vi.fn(),
    submission: vi.fn(),
  };
  const postMessage = vi.fn();
  const waiting = { waiting: { postMessage } } as unknown as ServiceWorkerRegistration;
  const { result } = renderHook(() => useVault(), {
    wrapper: wrapper({ client: makeClient(), config, backend }),
  });
  await waitFor(() => expect(result.current.hydrated).toBe(true));

  let provisioning!: Promise<void>;
  act(() => {
    provisioning = result.current.provision();
  });
  await waitFor(() => expect(activateWaitingServiceWorkerWhenSafe(waiting)).toBe(false));
  expect(postMessage).not.toHaveBeenCalled();

  releaseRegistration();
  await act(async () => {
    await provisioning;
  });
  expect(postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
});

it("auto-provisions immediately after secondary registration and persists only verified completion", async () => {
  const registration = (
    role: "primary" | "secondary",
    attachment: "platform" | "cross-platform",
  ) => ({
    role,
    credentialId: `${role}-credential`,
    challenge: "challenge",
    rpId: "localhost",
    origin: "http://localhost:5173",
    response: {
      id: `${role}-credential`,
      rawId: `${role}-credential`,
      type: "public-key" as const,
      authenticatorAttachment: attachment,
      clientExtensionResults: {},
      response: { clientDataJSON: "e30", attestationObject: "e30" },
    },
  });
  const backend = {
    health: vi.fn().mockResolvedValue(undefined),
    registerPasskey: vi.fn(async (role) =>
      registration(role, role === "primary" ? "platform" : "cross-platform"),
    ),
    autoProvisionVault: vi.fn(),
    prepareIntent: vi.fn(),
    submit: vi.fn(),
    submission: vi.fn(),
  };
  const { result } = renderHook(() => useVault(), {
    wrapper: wrapper({ client: makeClient(), backend: backend as unknown as VaultBackend }),
  });
  await waitFor(() => expect(result.current.hydrated).toBe(true));
  await act(() => result.current.registerPrimary());
  expect(result.current.setup.primaryCredentialId).toBe("primary-credential");
  let finishProvisioning!: (value: VaultProvisioningResult) => void;
  let persistedAtProvisioningCall: unknown;
  backend.autoProvisionVault.mockImplementationOnce(() => {
    persistedAtProvisioningCall = JSON.parse(localStorage.getItem(walletStorageKey("ui", { id: "local", rpId: "localhost" })) ?? "null");
    return new Promise((resolve) => { finishProvisioning = resolve; });
  });
  let secondary!: Promise<void>;
  act(() => { secondary = result.current.registerSecondary(); });
  await waitFor(() => expect(result.current.setup.secondaryCredentialId).toBe("secondary-credential"));
  expect(result.current.setup.secondaryAuthenticator).toBe("cross-platform");
  expect(result.current.setup.distinctSecondary).toBe(true);
  expect(result.current.setup.provisioning).toBe("provisioning");
  expect(persistedAtProvisioningCall).toMatchObject({ primaryCredentialId: "primary-credential", secondaryCredentialId: "secondary-credential" });
  expect(backend.autoProvisionVault).toHaveBeenCalledWith();
  expect(localStorage.getItem(walletStorageKey("config", { id: "local", rpId: "localhost" }))).toBeNull();
  finishProvisioning({
    chainId: 11155111,
    safe: SAFE,
    guard: GUARD,
    delay: DELAY,
    usdc: USDC,
    primaryPasskey: SAFE,
    secondaryPasskey: GUARD,
    evidence: { setupTransactionHash: `0x${"11".repeat(32)}`, verificationReportHash: `0x${"22".repeat(32)}` },
  });
  await act(async () => { await secondary; });
  expect(result.current.setup.provisioning).toBe("provisioned");
  expect(result.current.setup.receiptHash).toBe(`0x${"11".repeat(32)}`);
  expect(JSON.parse(localStorage.getItem(walletStorageKey("config", { id: "local", rpId: "localhost" })) ?? "null")).toMatchObject({ safe: SAFE, guard: GUARD, delay: DELAY });
  expect(JSON.stringify(localStorage)).not.toMatch(/assertion|signature/i);
});

it("logs one safe correlated frontend diagnostic for a backend provisioning failure", async () => {
  localStorage.setItem(
    walletStorageKey("ui", { id: "local", rpId: "localhost" }),
    JSON.stringify({ primaryCredentialId: "primary-credential", secondaryCredentialId: "secondary-credential", secondaryAuthenticator: "cross-platform", submissionIds: [] }),
  );
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/health")) return new Response(JSON.stringify({ ok: true, chainId: 11155111, profileId: "local", origin: "http://localhost:5173", rpId: "localhost" }), { status: 200 });
    return new Response(JSON.stringify({ error: "provisioning quote nonce mismatch for secondary-signer: expected 1032, observed 1033", code: "provisioning_nonce_mismatch", stage: "provisioning-quote", requestId: "request-123" }), { status: 400, headers: { "x-request-id": "request-123" } });
  }));
  const { result } = renderHook(() => useVault(), { wrapper: wrapper({ client: makeClient() }) });
  await waitFor(() => expect(result.current.hydrated).toBe(true));

  await expect(act(() => result.current.retryProvisioning())).rejects.toThrow(/nonce mismatch/i);
  expect(log).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledWith("Vault backend request failed", expect.objectContaining({ code: "provisioning_nonce_mismatch", stage: "provisioning-quote", requestId: "request-123", path: "/v1/vaults/auto-provision" }));
  expect(JSON.stringify(log.mock.calls)).not.toContain("primary-credential");
  log.mockRestore();
});

it("keeps credentials but no config after failure and single-flights explicit retry", async () => {
  const registration = (role: "primary" | "secondary") => ({
    role,
    credentialId: `${role}-credential`,
    challenge: "challenge",
    rpId: "localhost",
    origin: "http://localhost:5173",
    response: { id: `${role}-credential`, rawId: `${role}-credential`, type: "public-key" as const, authenticatorAttachment: role === "primary" ? "platform" as const : "cross-platform" as const, clientExtensionResults: {}, response: { clientDataJSON: "e30", attestationObject: "e30" } },
  });
  const backend = {
    health: vi.fn().mockResolvedValue(undefined),
    registerPasskey: vi.fn(async (role: "primary" | "secondary") => registration(role)),
    autoProvisionVault: vi.fn().mockRejectedValueOnce(new Error("fee cap exceeded")),
    prepareIntent: vi.fn(), submit: vi.fn(), submission: vi.fn(),
  };
  const { result } = renderHook(() => useVault(), { wrapper: wrapper({ client: makeClient(), backend: backend as unknown as VaultBackend }) });
  await waitFor(() => expect(result.current.hydrated).toBe(true));
  await act(() => result.current.registerPrimary());
  let failure: unknown;
  await act(async () => { try { await result.current.registerSecondary(); } catch (error) { failure = error; } });
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toMatch(/fee cap/i);
  expect(result.current.setup.secondaryCredentialId).toBe("secondary-credential");
  expect(result.current.setup.provisioning).toBe("failed");
  expect(localStorage.getItem(walletStorageKey("config", { id: "local", rpId: "localhost" }))).toBeNull();

  let release!: (value: VaultProvisioningResult) => void;
  backend.autoProvisionVault.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
  let first!: Promise<void>;
  let second!: Promise<void>;
  act(() => { first = result.current.retryProvisioning(); second = result.current.retryProvisioning(); });
  await waitFor(() => expect(backend.autoProvisionVault).toHaveBeenCalledTimes(2));
  release({ chainId: 11155111, safe: SAFE, guard: GUARD, delay: DELAY, usdc: USDC, primaryPasskey: SAFE, secondaryPasskey: GUARD, evidence: { setupTransactionHash: `0x${"11".repeat(32)}`, verificationReportHash: `0x${"22".repeat(32)}` } });
  await act(async () => { await Promise.all([first, second]); });
  expect(result.current.setup.provisioning).toBe("provisioned");
});

it("recovers an interrupted persisted provisioning state as retryable after reload", async () => {
  localStorage.setItem(walletStorageKey("ui", { id: "local", rpId: "localhost" }), JSON.stringify({
    notifications: { email: true, push: false }, rehearsed: false, primaryCredentialId: "primary-credential", secondaryCredentialId: "secondary-credential", secondaryAuthenticator: "cross-platform", provisioning: "provisioning", submissionIds: [],
  }));
  const backend = { health: vi.fn(), registerPasskey: vi.fn(), autoProvisionVault: vi.fn(), prepareIntent: vi.fn(), submit: vi.fn(), submission: vi.fn() };
  const { result } = renderHook(() => useVault(), { wrapper: wrapper({ client: makeClient(), backend: backend as unknown as VaultBackend }) });
  await waitFor(() => expect(result.current.hydrated).toBe(true));
  expect(result.current.setup).toMatchObject({ primaryCredentialId: "primary-credential", secondaryCredentialId: "secondary-credential", provisioning: "failed" });
  expect(backend.autoProvisionVault).not.toHaveBeenCalled();
});

it("persists a recovered vault, resumes signer rebind after reload, and never writes before both roles are ready", async () => {
  const storage = { id: "local" as const, rpId: "localhost" };
  localStorage.setItem(walletStorageKey("ui", storage), JSON.stringify({
    notifications: { email: true, push: false }, rehearsed: false,
    primaryCredentialId: "primary-credential", secondaryCredentialId: "secondary-credential",
    secondaryAuthenticator: "cross-platform", provisioning: "failed", submissionIds: [],
  }));
  const prepareIntent = vi.fn();
  const rebindPasskey = vi.fn()
    .mockResolvedValueOnce({ required: true, primary: "ready", secondary: "required" })
    .mockResolvedValueOnce({ required: false, primary: "ready", secondary: "ready" });
  const backend = {
    health: vi.fn().mockResolvedValue(undefined), registerPasskey: vi.fn(),
    autoProvisionVault: vi.fn().mockResolvedValue({
      chainId: 11155111, safe: SAFE, guard: GUARD, delay: DELAY, usdc: USDC,
      primaryPasskey: SAFE, secondaryPasskey: GUARD,
      evidence: { setupTransactionHash: `0x${"11".repeat(32)}`, verificationReportHash: `0x${"22".repeat(32)}` },
      credentialRebind: { required: true, primary: "required", secondary: "required" },
    }),
    rebindPasskey, prepareIntent, submit: vi.fn(), submission: vi.fn(),
  } satisfies VaultBackend;
  const first = renderHook(() => useVault(), { wrapper: wrapper({ client: makeClient(), backend }) });
  await waitFor(() => expect(first.result.current.hydrated).toBe(true));
  await act(() => first.result.current.retryProvisioning());
  expect(first.result.current.setup.credentialRebind).toEqual({ required: true, primary: "required", secondary: "required" });
  expect(JSON.parse(localStorage.getItem(walletStorageKey("config", storage)) ?? "null")).toMatchObject({ safe: SAFE });
  first.unmount();

  const resumed = renderHook(() => useVault(), { wrapper: wrapper({ client: makeClient(), backend }) });
  await waitFor(() => expect(resumed.result.current.state.writable).toBe(true));
  expect(resumed.result.current.setup.credentialRebind.primary).toBe("required");
  await expect(resumed.result.current.prepareTransfer({ recipient: RECIPIENT, amount: 1n })).rejects.toThrow(/verify both recovered signers/i);
  expect(prepareIntent).not.toHaveBeenCalled();
  await act(() => resumed.result.current.rebindPrimary());
  expect(rebindPasskey).toHaveBeenNthCalledWith(1, "primary", "primary-credential");
  await expect(resumed.result.current.reconcileSubmission("pending")).rejects.toThrow(/verify both recovered signers/i);
  expect(backend.submission).not.toHaveBeenCalled();
  await act(() => resumed.result.current.rebindSecondary());
  expect(rebindPasskey).toHaveBeenNthCalledWith(2, "secondary", "secondary-credential");
  expect(resumed.result.current.setup).toMatchObject({ provisioning: "provisioned", credentialRebind: { required: false, primary: "ready", secondary: "ready" } });
});

it("warns when the secondary is same-device and isolates public state by environment", async () => {
  const backend = {
    health: vi.fn(),
    registerPasskey: vi.fn(async (role: "primary" | "secondary") => ({
      role,
      credentialId: `${role}-credential`,
      challenge: "c",
      rpId: "localhost",
      origin: "http://localhost:5173",
      response: {
        id: `${role}-credential`,
        rawId: `${role}-credential`,
        type: "public-key",
        authenticatorAttachment: "platform",
        clientExtensionResults: {},
        response: { clientDataJSON: "e30", attestationObject: "e30" },
      },
    })),
    autoProvisionVault: vi.fn(),
    prepareIntent: vi.fn(),
    submit: vi.fn(),
    submission: vi.fn(),
  } as unknown as VaultBackend;
  const { result } = renderHook(() => useVault(), {
    wrapper: wrapper({ client: makeClient(), backend }),
  });
  await waitFor(() => expect(result.current.hydrated).toBe(true));
  await act(() => result.current.registerSecondary());
  expect(result.current.setup.distinctSecondary).toBe(false);
  expect(
    localStorage.getItem(walletStorageKey("ui", { id: "https", rpId: "vault.example" })),
  ).toBeNull();
});

it("does not advance either signer when its passkey ceremony is cancelled", async () => {
  const cancelled = new DOMException("The operation was cancelled", "NotAllowedError");
  const primary = {
    role: "primary" as const,
    credentialId: "primary-credential",
    challenge: "c",
    rpId: "localhost",
    origin: "http://localhost:5173",
    response: {
      id: "primary-credential",
      rawId: "primary-credential",
      type: "public-key" as const,
      authenticatorAttachment: "platform" as const,
      clientExtensionResults: {},
      response: { clientDataJSON: "e30", attestationObject: "e30" },
    },
  };
  const backend = {
    health: vi.fn().mockResolvedValue(undefined),
    registerPasskey: vi
      .fn()
      .mockRejectedValueOnce(cancelled)
      .mockResolvedValueOnce(primary)
      .mockRejectedValueOnce(cancelled),
    autoProvisionVault: vi.fn(),
    prepareIntent: vi.fn(),
    submit: vi.fn(),
    submission: vi.fn(),
  } as unknown as VaultBackend;
  const { result } = renderHook(() => useVault(), {
    wrapper: wrapper({ client: makeClient(), backend }),
  });
  await waitFor(() => expect(result.current.hydrated).toBe(true));
  await expect(result.current.registerPrimary()).rejects.toThrow(/cancelled/i);
  expect(result.current.setup.primaryCredentialId).toBeUndefined();
  await act(() => result.current.registerPrimary());
  await expect(result.current.registerSecondary()).rejects.toThrow(/cancelled/i);
  expect(result.current.setup.primaryCredentialId).toBe("primary-credential");
  expect(result.current.setup.secondaryCredentialId).toBeUndefined();
});

it("orders X/Y/Z approvals and handles queue, uncertainty, revert, offline, and stale snapshots", async () => {
  const hash = `0x${"aa".repeat(32)}` as const;
  localStorage.setItem(
    walletStorageKey("ui", { id: "local", rpId: "localhost" }),
    JSON.stringify({
      primaryCredentialId: "p",
      secondaryCredentialId: "s",
      secondaryAuthenticator: "cross-platform",
      submissionIds: [],
    }),
  );
  const prepared = (id: string, kind: string, roles: string[]) => ({
    id,
    requestHash: hash,
    safeTxHash: hash,
    kind,
    requiredApprovals: roles,
    publicRequest: { kind: "transfer", idempotencyKey: id },
  });
  const prepareIntent = vi
    .fn()
    .mockResolvedValueOnce(prepared("x", "base-transfer", ["primary"]))
    .mockResolvedValueOnce(prepared("y", "step-up-transfer", ["primary", "secondary"]))
    .mockResolvedValueOnce(prepared("z", "queue-transfer", ["primary", "secondary"]))
    .mockResolvedValueOnce(prepared("cancel", "cancel-queued", ["primary", "secondary"]))
    .mockResolvedValueOnce(prepared("execute", "execute-ready", []))
    .mockResolvedValueOnce(prepared("expired", "skip-expired", []));
  const submit = vi.fn(async (id: string, body: { role: string }) => ({
    id,
    state:
      body.role === "primary" && ["y", "z", "cancel"].includes(id)
        ? "awaiting-secondary"
        : "confirmed",
    transactionHash: hash,
    approvals: { primary: true, secondary: body.role === "secondary" },
  }));
  const backend = {
    health: vi.fn().mockResolvedValue(undefined),
    registerPasskey: vi.fn(),
    autoProvisionVault: vi.fn(),
    prepareIntent,
    submit,
    submission: vi
      .fn()
      .mockResolvedValue({ id: "uncertain", state: "reverted", transactionHash: hash }),
  } as unknown as VaultBackend;
  const { result } = renderHook(() => useVault(), {
    wrapper: wrapper({ client: makeClient(), config, backend }),
  });
  await waitFor(() => expect(result.current.state.writable).toBe(true));
  await act(() => result.current.prepareTransfer({ recipient: RECIPIENT, amount: 1_000_000n }));
  await act(() => result.current.prepareTransfer({ recipient: RECIPIENT, amount: 2_000_000n }));
  await act(() => result.current.prepareTransfer({ recipient: RECIPIENT, amount: 4_000_000n }));
  expect(submit.mock.calls.map(([, body]) => body.role)).toEqual([
    "primary",
    "primary",
    "secondary",
    "primary",
    "secondary",
  ]);
  const queue = {
    queueNonce: 2,
    txHash: hash,
    fingerprint: "FP",
    status: "queued" as const,
    id: "q",
    direction: "out" as const,
    amount: 4_000_000n,
    counterparty: RECIPIENT,
    address: RECIPIENT,
    lane: "delayed" as const,
    createdAt: 1,
    approvers: [],
    earliestExecution: Date.now() + 60_000,
    expiresAt: Date.now() + 600_000,
  };
  expect(() => result.current.executeReady(queue)).toThrow(/not ready/i);
  await act(() => result.current.cancelQueued(queue));
  await act(() => result.current.executeReady({ ...queue, status: "ready", earliestExecution: 0 }));
  await act(() =>
    result.current.executeReady({
      ...queue,
      status: "ready",
      canonicalNow: 2,
      earliestExecution: 0,
      expiresAt: 1,
    }),
  );
  expect(submit.mock.calls.slice(-4).map(([, body]) => body.role)).toEqual([
    "primary",
    "secondary",
    "none",
    "none",
  ]);
  await act(() => result.current.reconcileSubmission("uncertain"));
  expect(backend.submission).toHaveBeenCalledWith("uncertain");
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
  await expect(
    result.current.prepareTransfer({ recipient: RECIPIENT, amount: 1n }),
  ).rejects.toThrow(/offline/i);
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  prepareIntent.mockRejectedValueOnce(new Error("stale snapshot"));
  await expect(
    result.current.prepareTransfer({ recipient: RECIPIENT, amount: 1n }),
  ).rejects.toThrow(/stale/i);
});
