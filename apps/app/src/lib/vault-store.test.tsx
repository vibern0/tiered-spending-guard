import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
beforeEach(() => {
  vi.stubEnv("VITE_BACKEND_ORIGIN", "http://localhost:8787");
  // Chain fixtures still require a separately ready loopback backend.
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (input: string | URL | Request) =>
        new Response(
          JSON.stringify(
            String(input).endsWith("/v1/vaults/current")
              ? {
                  ...resumedProvisioningResult,
                  credentialRebind: { required: false, primary: "ready", secondary: "ready" },
                }
              : {
                  ok: true,
                  provisioningReady: true,
                  writesReady: true,
                  chainId: 11155111,
                  profileId: "local",
                  origin: "http://localhost:5173",
                  rpId: "localhost",
                },
          ),
        ),
    ),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  localStorage.clear();
});
import {
  createVaultBackend,
  checkBackendHealth,
  useVault,
  VaultProvider,
  walletStorageKey,
  walletArchiveStorageKey,
  readWalletAccountArchive,
  type VaultBackend,
  type VaultProvisioningResult,
} from "./vault-store";
import { BackendRequestError } from "./provisioning-errors";
import { signSafeDigest } from "./webauthn-passkey";
import type { WalletEnvironmentProfile } from "./environment-profile";
import type { VaultConfig } from "./vault-chain";
import { TEST_USDC_ADDRESS, TEST_USDC_RUNTIME } from "./usdc-test-fixture";
import { activateWaitingServiceWorkerWhenSafe } from "./pwa";
import { HISTORICAL_GUARD_RUNTIME, decodeHistoricalPolicy } from "./historical-guard-test-fixture";
import { TopologyAlert } from "../components/wallet/topology-alert";

function historicalClient(): PublicClient {
  const historical = makeClient();
  vi.mocked(historical.getBytecode).mockImplementation(async ({ address }) =>
    address === GUARD ? HISTORICAL_GUARD_RUNTIME : TEST_USDC_RUNTIME,
  );
  const baseRead = vi.mocked(historical.readContract).getMockImplementation()!;
  vi.mocked(historical.readContract).mockImplementation(async (input) =>
    input.functionName === "assetPolicy"
      ? (decodeHistoricalPolicy(input.abi) as never)
      : baseRead(input),
  );
  return historical;
}

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

function legacyHttpBackend(): VaultBackend {
  const {
    session: _session,
    signIn: _signIn,
    signOut: _signOut,
    createAccount: _createAccount,
    ...api
  } = createVaultBackend();
  return api;
}
function wrapper(
  options: { client?: PublicClient; config?: VaultConfig; backend?: VaultBackend } = {},
) {
  return ({ children }: { children: ReactNode }) =>
    createElement(
      VaultProvider,
      { ...options, backend: options.backend ?? legacyHttpBackend(), children },
      children,
    );
}

describe("VaultProvider", () => {
  it("keeps a healthy account readable but disables sends until backend write readiness passes a refresh", async () => {
    let writesReady = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (input: string | URL | Request) =>
          new Response(
            JSON.stringify(
              String(input).endsWith("/v1/vaults/current")
                ? {
                    ...resumedProvisioningResult,
                    credentialRebind: { required: false, primary: "ready", secondary: "ready" },
                  }
                : {
                    ok: true,
                    provisioningReady: true,
                    writesReady,
                    chainId: 11155111,
                    profileId: "local",
                    origin: "http://localhost:5173",
                    rpId: "localhost",
                  },
            ),
          ),
      ),
    );
    const { result } = renderHook(() => useVault(), {
      wrapper: wrapper({ config, client: makeClient() }),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.state.safe).toBe(SAFE);
    expect(result.current.state.balance).toBe(12_345_678n);
    expect(result.current.state.writable).toBe(false);
    expect(result.current.canWrite).toBe(false);
    expect(result.current.state.health).toEqual([
      expect.objectContaining({ code: "backend-not-ready", blocking: true }),
    ]);
    writesReady = true;
    await act(() => result.current.refresh());
    expect(result.current.canWrite).toBe(true);
    expect(result.current.state.health).toEqual([]);
  });

  it("queues a recipient addition with ordered approvals and keeps recipients from chain state", async () => {
    const candidate = "0x8888888888888888888888888888888888888888" as Address;
    const profile = { id: "local" as const, rpId: "localhost" };
    localStorage.setItem(
      walletStorageKey("ui", profile),
      JSON.stringify({
        primaryCredentialId: "primary",
        secondaryCredentialId: "secondary",
        submissionIds: [],
      }),
    );
    const backend: VaultBackend = {
      health: async (purpose) =>
        checkBackendHealth(
          {
            ...profile,
            chainId: 11155111,
            appOrigin: "http://localhost:5173",
            backendOrigin: "http://localhost:8787",
            credentials: "include",
          },
          async () =>
            new Response(
              JSON.stringify({
                ok: true,
                provisioningReady: true,
                writesReady: true,
                chainId: 11155111,
                profileId: "local",
                origin: "http://localhost:5173",
                rpId: "localhost",
              }),
            ),
          purpose,
        ),
      registerPasskey: vi.fn(),
      autoProvisionVault: vi.fn(),
      submission: vi.fn(),
      prepareIntent: vi.fn().mockResolvedValue({
        id: "add-recipient-1",
        kind: "add-recipient",
        requestHash: `0x${"ab".repeat(32)}`,
        safeTxHash: `0x${"cd".repeat(32)}`,
        requiredApprovals: ["primary", "secondary"],
        publicRequest: {},
      }),
      submit: vi.fn(async (_id, body) => ({
        id: "add-recipient-1",
        state: body.role === "primary" ? ("awaiting-secondary" as const) : ("confirmed" as const),
      })),
    };
    const { result } = renderHook(() => useVault(), {
      wrapper: wrapper({ config, client: makeClient(), backend }),
    });
    await waitFor(() => expect(result.current.canWrite).toBe(true));
    await act(async () =>
      expect(await result.current.addRecipient(candidate)).toMatchObject({ state: "confirmed" }),
    );
    expect(backend.prepareIntent).toHaveBeenCalledWith({
      kind: "add-recipient",
      recipient: candidate,
      idempotencyKey: expect.any(String),
    });
    expect(vi.mocked(backend.submit).mock.calls.map(([, body]) => body.role)).toEqual([
      "primary",
      "secondary",
    ]);
    expect(result.current.state.recipients).toEqual([{ name: RECIPIENT, address: RECIPIENT }]);
    expect(result.current.setup.submissionIds).toContain("add-recipient-1");
  });

  it("rejects invalid or already listed recipient additions before preparing or signing", async () => {
    const backend: VaultBackend = {
      health: vi.fn(),
      registerPasskey: vi.fn(),
      autoProvisionVault: vi.fn(),
      prepareIntent: vi.fn(),
      submit: vi.fn(),
      submission: vi.fn(),
    };
    const { result } = renderHook(() => useVault(), {
      wrapper: wrapper({ config, client: makeClient(), backend }),
    });
    await waitFor(() => expect(result.current.canWrite).toBe(true));
    for (const candidate of [
      "invalid",
      "0x0000000000000000000000000000000000000000",
      " 0x0000000000000000000000000000000000000000 ",
      RECIPIENT.toUpperCase().replace("0X", "0x"),
    ]) {
      await expect(result.current.addRecipient(candidate as Address)).rejects.toThrow(
        /recipient|address/i,
      );
    }
    expect(backend.prepareIntent).not.toHaveBeenCalled();
    expect(backend.submit).not.toHaveBeenCalled();
  });

  it("archives the exact historical account before starting clean setup and keeps it after reload", async () => {
    const profile = { id: "local" as const, rpId: "localhost" };
    const oldConfig = JSON.stringify({ ...config, preservedPublicReference: "old-account" });
    localStorage.setItem(walletStorageKey("config", profile), oldConfig);
    localStorage.setItem(
      walletStorageKey("ui", profile),
      JSON.stringify({
        primaryCredentialId: "old-primary",
        secondaryCredentialId: "old-secondary",
        secondaryAuthenticator: "cross-platform",
        submissionIds: ["old-submission"],
        provisioning: "provisioned",
        rehearsed: true,
      }),
    );
    localStorage.setItem("unrelated-data", "keep");
    const first = renderHook(() => useVault(), {
      wrapper: wrapper({ client: historicalClient() }),
    });
    await waitFor(() => expect(first.result.current.state.compatibility?.mode).toBe("read-only"));
    const oldUi = localStorage.getItem(walletStorageKey("ui", profile));
    await act(() => first.result.current.startNewVault());
    expect(readWalletAccountArchive(profile, SAFE)).toMatchObject({ config: oldConfig, ui: oldUi });
    expect(localStorage.getItem(walletStorageKey("config", profile))).toBeNull();
    expect(first.result.current.hasAccount).toBe(false);
    expect(first.result.current.state.safe).toBe("");
    expect(first.result.current.setup).toMatchObject({
      provisioning: "registering",
      submissionIds: [],
    });
    expect(first.result.current.setup.primaryCredentialId).toBeUndefined();
    expect(first.result.current.setup.secondaryCredentialId).toBeUndefined();
    expect(first.result.current.state.onboarding).toEqual({
      firstSigner: false,
      secondSigner: false,
      limits: false,
      rehearsed: false,
    });
    expect(localStorage.getItem("unrelated-data")).toBe("keep");
    first.unmount();
    const second = renderHook(() => useVault(), { wrapper: wrapper({ client: makeClient() }) });
    await waitFor(() => expect(second.result.current.hydrated).toBe(true));
    expect(second.result.current.hasAccount).toBe(false);
    expect(second.result.current.setup.submissionIds).toEqual([]);
    expect(readWalletAccountArchive(profile, SAFE)).toMatchObject({ config: oldConfig, ui: oldUi });
  });

  it("shows a canonical queued recipient addition as a policy change rather than a zero-USDC transfer", async () => {
    const candidate = "0x8888888888888888888888888888888888888888" as Address;
    const data = encodeFunctionData({
      abi: parseAbi([
        "function repairPolicy(bytes32,address,uint256,uint256,uint256,uint256,address[],uint8)",
      ]),
      functionName: "repairPolicy",
      args: [
        `0x${"ab".repeat(32)}`,
        USDC,
        100_000_000n,
        200_000_000n,
        250_000_000n,
        1_000_000_000n,
        [RECIPIENT, candidate],
        1,
      ],
    });
    const txHash = keccak256(
      encodePacked(["address", "uint256", "bytes", "uint8"], [GUARD, 0n, data, 0]),
    );
    const client = makeClient();
    const read = vi.mocked(client.readContract).getMockImplementation()!;
    vi.mocked(client.readContract).mockImplementation(async (input) => {
      if (input.functionName === "queueNonce") return 1n as never;
      if (input.functionName === "getTxHash") return txHash as never;
      if (input.functionName === "getTxCreatedAt") return 100n as never;
      return read(input);
    });
    Object.assign(client, {
      getLogs: vi
        .fn()
        .mockResolvedValue([
          { args: { queueNonce: 0n, txHash, to: GUARD, value: 0n, data, operation: 0 } },
        ]),
    });
    const { result } = renderHook(() => useVault(), { wrapper: wrapper({ config, client }) });
    await waitFor(() => expect(result.current.state.activity).toHaveLength(1));
    expect(result.current.state.activity[0]).toMatchObject({
      kind: "recipient-addition",
      address: candidate,
      amount: 0n,
      counterparty: "Recipient addition",
    });
    expect(result.current.state.recipients).toEqual([{ name: RECIPIENT, address: RECIPIENT }]);
  });

  it("leaves the active account intact when its archive cannot be saved", async () => {
    const profile = { id: "local" as const, rpId: "localhost" };
    localStorage.setItem(walletStorageKey("config", profile), JSON.stringify(config));
    localStorage.setItem(
      walletStorageKey("ui", profile),
      JSON.stringify({
        primaryCredentialId: "old-primary",
        secondaryCredentialId: "old-secondary",
        submissionIds: ["old-submission"],
      }),
    );
    const { result } = renderHook(() => useVault(), {
      wrapper: wrapper({ client: historicalClient() }),
    });
    await waitFor(() => expect(result.current.state.compatibility?.mode).toBe("read-only"));
    const oldConfig = localStorage.getItem(walletStorageKey("config", profile));
    const oldUi = localStorage.getItem(walletStorageKey("ui", profile));
    const setItem = Storage.prototype.setItem;
    const save = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (key === walletArchiveStorageKey(profile, SAFE))
        throw new Error("Archive storage unavailable");
      return setItem.call(this, key, value);
    });
    try {
      await expect(result.current.startNewVault()).rejects.toThrow(/archive/i);
      expect(result.current.hasAccount).toBe(true);
      expect(result.current.state.safe).toBe(SAFE);
      expect(localStorage.getItem(walletStorageKey("config", profile))).toBe(oldConfig);
      expect(localStorage.getItem(walletStorageKey("ui", profile))).toBe(oldUi);
    } finally {
      save.mockRestore();
    }
  });

  it("never replaces an earlier archive with different account metadata", async () => {
    const profile = { id: "local" as const, rpId: "localhost" };
    localStorage.setItem(walletStorageKey("config", profile), JSON.stringify(config));
    const previousArchive = JSON.stringify({
      formatVersion: 1,
      safe: SAFE,
      config: JSON.stringify(config),
      ui: "previous metadata",
    });
    localStorage.setItem(walletArchiveStorageKey(profile, SAFE), previousArchive);
    const { result } = renderHook(() => useVault(), {
      wrapper: wrapper({ client: historicalClient() }),
    });
    await waitFor(() => expect(result.current.state.compatibility?.mode).toBe("read-only"));
    await expect(result.current.startNewVault()).rejects.toThrow(/archive/i);
    expect(localStorage.getItem(walletArchiveStorageKey(profile, SAFE))).toBe(previousArchive);
    expect(result.current.hasAccount).toBe(true);
  });

  it("allows provisioning-ready setup while sending remains unready and honors explicit provisioning refusal", async () => {
    const profile: WalletEnvironmentProfile = {
      id: "local",
      chainId: 11155111,
      appOrigin: "http://localhost:5173",
      rpId: "localhost",
      backendOrigin: "http://localhost:8787",
      credentials: "include",
    };
    const identity = {
      ok: true,
      chainId: 11155111,
      profileId: "local",
      origin: profile.appOrigin,
      rpId: profile.rpId,
    };
    const ready = async () =>
      new Response(JSON.stringify({ ...identity, provisioningReady: true, writesReady: false }));
    await expect(checkBackendHealth(profile, ready, "provision")).resolves.toBeUndefined();
    await expect(checkBackendHealth(profile, ready)).rejects.toThrow(
      /submission runtime is not ready/i,
    );
    await expect(
      checkBackendHealth(
        profile,
        async () => new Response(JSON.stringify({ ...identity, writesReady: true })),
        "provision",
      ),
    ).resolves.toBeUndefined();
    await expect(
      checkBackendHealth(
        profile,
        async () =>
          new Response(
            JSON.stringify({ ...identity, provisioningReady: false, writesReady: true }),
          ),
        "provision",
      ),
    ).rejects.toThrow(/provisioning.*not ready/i);
  });

  it("shows historical balances with an explicit read-only notice instead of a verification error", async () => {
    render(
      createElement(VaultProvider, {
        client: historicalClient(),
        config,
        children: createElement(TopologyAlert),
      }),
    );
    await waitFor(() =>
      expect(screen.getByText("Earlier vault version · read-only")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Account verification needs attention")).not.toBeInTheDocument();
    expect(screen.queryByText("Guard, Delay, and USDC checks passed.")).not.toBeInTheDocument();
  });

  it("blocks historical queue preparation and approvals before backend or signer calls", async () => {
    localStorage.setItem(
      walletStorageKey("ui", { id: "local", rpId: "localhost" }),
      JSON.stringify({ primaryCredentialId: "p", secondaryCredentialId: "s", submissionIds: [] }),
    );
    const backend = {
      health: vi.fn(),
      registerPasskey: vi.fn(),
      autoProvisionVault: vi.fn(),
      prepareIntent: vi.fn(),
      submit: vi.fn(),
      submission: vi.fn(),
    };
    const { result } = renderHook(() => useVault(), {
      wrapper: wrapper({ client: historicalClient(), config, backend }),
    });
    await waitFor(() => expect(result.current.state.balance).toBe(12_345_678n));
    expect(result.current.canWrite).toBe(false);
    expect(result.current.state.compatibility?.mode).toBe("read-only");
    await expect(
      result.current.cancelQueued({ queueNonce: 1, txHash: `0x${"12".repeat(32)}` } as never),
    ).rejects.toThrow(/read-only/i);
    await expect(result.current.approveSubmission("stale-request", "primary")).rejects.toThrow(
      /read-only/i,
    );
    expect(backend.health).not.toHaveBeenCalled();
    expect(backend.prepareIntent).not.toHaveBeenCalled();
    expect(backend.submit).not.toHaveBeenCalled();
    const { signSafeDigest } = await import("./webauthn-passkey");
    expect(signSafeDigest).not.toHaveBeenCalled();
  });

  it("blocks writes when backend readiness is unhealthy", async () => {
    const profile: WalletEnvironmentProfile = {
      id: "local",
      chainId: 11155111,
      appOrigin: "http://localhost:5173",
      rpId: "localhost",
      backendOrigin: "http://localhost:8787",
      credentials: "include",
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
              writesReady: true,
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
  expect(createPublicClient).toHaveBeenCalledWith(
    expect.objectContaining({
      batch: { multicall: { wait: 10 } },
    }),
  );
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
    persistedAtProvisioningCall = JSON.parse(
      localStorage.getItem(walletStorageKey("ui", { id: "local", rpId: "localhost" })) ?? "null",
    );
    return new Promise((resolve) => {
      finishProvisioning = resolve;
    });
  });
  let secondary!: Promise<void>;
  act(() => {
    secondary = result.current.registerSecondary();
  });
  await waitFor(() =>
    expect(result.current.setup.secondaryCredentialId).toBe("secondary-credential"),
  );
  expect(result.current.setup.secondaryAuthenticator).toBe("cross-platform");
  expect(result.current.setup.distinctSecondary).toBe(true);
  expect(result.current.setup.provisioning).toBe("provisioning");
  expect(persistedAtProvisioningCall).toMatchObject({
    primaryCredentialId: "primary-credential",
    secondaryCredentialId: "secondary-credential",
  });
  expect(backend.autoProvisionVault).toHaveBeenCalledWith();
  expect(
    localStorage.getItem(walletStorageKey("config", { id: "local", rpId: "localhost" })),
  ).toBeNull();
  finishProvisioning({
    chainId: 11155111,
    safe: SAFE,
    guard: GUARD,
    delay: DELAY,
    usdc: USDC,
    primaryPasskey: SAFE,
    secondaryPasskey: GUARD,
    evidence: {
      setupTransactionHash: `0x${"11".repeat(32)}`,
      verificationReportHash: `0x${"22".repeat(32)}`,
    },
  });
  await act(async () => {
    await secondary;
  });
  expect(result.current.setup.provisioning).toBe("provisioned");
  expect(result.current.setup.receiptHash).toBe(`0x${"11".repeat(32)}`);
  expect(
    JSON.parse(
      localStorage.getItem(walletStorageKey("config", { id: "local", rpId: "localhost" })) ??
        "null",
    ),
  ).toMatchObject({ safe: SAFE, guard: GUARD, delay: DELAY });
  expect(JSON.stringify(localStorage)).not.toMatch(/assertion|signature/i);
});

it("logs safe correlated diagnostics for each bounded backend provisioning attempt", async () => {
  localStorage.setItem(
    walletStorageKey("ui", { id: "local", rpId: "localhost" }),
    JSON.stringify({
      primaryCredentialId: "primary-credential",
      secondaryCredentialId: "secondary-credential",
      secondaryAuthenticator: "cross-platform",
      submissionIds: [],
    }),
  );
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/health"))
        return new Response(
          JSON.stringify({
            ok: true,
            writesReady: true,
            chainId: 11155111,
            profileId: "local",
            origin: "http://localhost:5173",
            rpId: "localhost",
          }),
          { status: 200 },
        );
      return new Response(
        JSON.stringify({
          error:
            "provisioning quote nonce mismatch for secondary-signer: expected 1032, observed 1033",
          code: "provisioning_nonce_mismatch",
          stage: "provisioning-quote",
          requestId: "request-123",
        }),
        { status: 400, headers: { "x-request-id": "request-123" } },
      );
    }),
  );
  const { result } = renderHook(() => useVault(), { wrapper: wrapper({ client: makeClient() }) });
  await waitFor(() => expect(result.current.hydrated).toBe(true));

  await expect(act(() => result.current.retryProvisioning())).rejects.toThrow(/nonce mismatch/i);
  expect(log).toHaveBeenCalledTimes(3);
  expect(log).toHaveBeenCalledWith(
    "Vault backend request failed",
    expect.objectContaining({
      code: "provisioning_nonce_mismatch",
      stage: "provisioning-quote",
      requestId: "request-123",
      path: "/v1/vaults/auto-provision",
    }),
  );
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
    response: {
      id: `${role}-credential`,
      rawId: `${role}-credential`,
      type: "public-key" as const,
      authenticatorAttachment:
        role === "primary" ? ("platform" as const) : ("cross-platform" as const),
      clientExtensionResults: {},
      response: { clientDataJSON: "e30", attestationObject: "e30" },
    },
  });
  const backend = {
    health: vi.fn().mockResolvedValue(undefined),
    registerPasskey: vi.fn(async (role: "primary" | "secondary") => registration(role)),
    autoProvisionVault: vi.fn().mockRejectedValueOnce(new Error("fee cap exceeded")),
    prepareIntent: vi.fn(),
    submit: vi.fn(),
    submission: vi.fn(),
  };
  const { result } = renderHook(() => useVault(), {
    wrapper: wrapper({ client: makeClient(), backend: backend as unknown as VaultBackend }),
  });
  await waitFor(() => expect(result.current.hydrated).toBe(true));
  await act(() => result.current.registerPrimary());
  let failure: unknown;
  await act(async () => {
    try {
      await result.current.registerSecondary();
    } catch (error) {
      failure = error;
    }
  });
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toMatch(/fee cap/i);
  expect(result.current.setup.secondaryCredentialId).toBe("secondary-credential");
  expect(result.current.setup.provisioning).toBe("failed");
  expect(
    localStorage.getItem(walletStorageKey("config", { id: "local", rpId: "localhost" })),
  ).toBeNull();

  let release!: (value: VaultProvisioningResult) => void;
  backend.autoProvisionVault.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  let first!: Promise<void>;
  let second!: Promise<void>;
  act(() => {
    first = result.current.retryProvisioning();
    second = result.current.retryProvisioning();
  });
  await waitFor(() => expect(backend.autoProvisionVault).toHaveBeenCalledTimes(2));
  release({
    chainId: 11155111,
    safe: SAFE,
    guard: GUARD,
    delay: DELAY,
    usdc: USDC,
    primaryPasskey: SAFE,
    secondaryPasskey: GUARD,
    evidence: {
      setupTransactionHash: `0x${"11".repeat(32)}`,
      verificationReportHash: `0x${"22".repeat(32)}`,
    },
  });
  await act(async () => {
    await Promise.all([first, second]);
  });
  expect(result.current.setup.provisioning).toBe("provisioned");
});

const resumedProvisioningResult: VaultProvisioningResult = {
  chainId: 11155111,
  safe: SAFE,
  guard: GUARD,
  delay: DELAY,
  usdc: USDC,
  primaryPasskey: SAFE,
  secondaryPasskey: GUARD,
  evidence: {
    setupTransactionHash: `0x${"11".repeat(32)}`,
    verificationReportHash: `0x${"22".repeat(32)}`,
  },
};
const resumeProfile = { id: "local" as const, rpId: "localhost" };
function storeInterruptedSetup(input: Record<string, unknown> = {}) {
  localStorage.setItem(
    walletStorageKey("ui", resumeProfile),
    JSON.stringify({
      primaryCredentialId: "primary-credential",
      secondaryCredentialId: "secondary-credential",
      secondaryAuthenticator: "cross-platform",
      provisioning: "provisioning",
      submissionIds: [],
      ...input,
    }),
  );
}
function resumeBackend(): VaultBackend {
  return {
    health: vi.fn().mockResolvedValue(undefined),
    registerPasskey: vi.fn(),
    autoProvisionVault: vi.fn().mockResolvedValue(resumedProvisioningResult),
    prepareIntent: vi.fn(),
    submit: vi.fn(),
    submission: vi.fn(),
  };
}

it("automatically resumes stored credentials with one empty HTTP intent and no passkey ceremony", async () => {
  storeInterruptedSetup();
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/health")) {
      return new Response(
        JSON.stringify({
          ok: true,
          provisioningReady: true,
          writesReady: true,
          chainId: 11155111,
          profileId: "local",
          origin: "http://localhost:5173",
          rpId: "localhost",
        }),
      );
    }
    if (String(input).endsWith("/v1/vaults/current"))
      return new Response(
        JSON.stringify({
          ...resumedProvisioningResult,
          credentialRebind: { required: false, primary: "ready", secondary: "ready" },
        }),
      );
    expect(String(input)).toBe("http://localhost:8787/v1/vaults/auto-provision");
    expect(init).toMatchObject({ method: "POST", body: "{}" });
    return new Response(JSON.stringify(resumedProvisioningResult));
  });
  vi.stubGlobal("fetch", fetcher);
  const { result, rerender } = renderHook(() => useVault(), {
    wrapper: wrapper({ client: makeClient() }),
  });
  await waitFor(() => expect(result.current.setup.provisioning).toBe("provisioned"));
  rerender();
  expect(
    fetcher.mock.calls.filter(([url]) => String(url).endsWith("/auto-provision")),
  ).toHaveLength(1);
  expect(result.current.setup.primaryCredentialId).toBe("primary-credential");
  expect(result.current.setup.secondaryCredentialId).toBe("secondary-credential");
  expect(signSafeDigest).not.toHaveBeenCalled();
  expect(
    JSON.parse(localStorage.getItem(walletStorageKey("config", resumeProfile))!),
  ).toMatchObject({ safe: SAFE });
});

it("joins duplicate recovery callbacks to the automatic in-flight request", async () => {
  storeInterruptedSetup();
  const backend = resumeBackend();
  let finish!: (value: VaultProvisioningResult) => void;
  vi.mocked(backend.autoProvisionVault).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { result } = renderHook(() => useVault(), {
    wrapper: wrapper({ client: makeClient(), backend }),
  });
  await waitFor(() => expect(backend.autoProvisionVault).toHaveBeenCalledTimes(1));
  let callbacks!: Promise<void>[];
  act(() => {
    callbacks = [result.current.retryProvisioning(), result.current.retryProvisioning()];
  });
  expect(localStorage.getItem(walletStorageKey("config", resumeProfile))).toBeNull();
  await act(async () => {
    finish(resumedProvisioningResult);
    await Promise.all(callbacks);
  });
  expect(backend.autoProvisionVault).toHaveBeenCalledTimes(1);
  expect(backend.registerPasskey).not.toHaveBeenCalled();
  expect(result.current.setup.provisioning).toBe("provisioned");
});

it.each([
  "empty",
  "primary-only",
  "other-profile",
  "current-account",
  "historical-account",
  "malformed-config",
  "malformed-credentials",
  "same-credential",
])("does not automatically provision for %s state", async (kind) => {
  if (kind === "other-profile") {
    localStorage.setItem(
      walletStorageKey("ui", { id: "https", rpId: "vault.example" }),
      JSON.stringify({ primaryCredentialId: "p", secondaryCredentialId: "s" }),
    );
  } else if (kind !== "empty") {
    const override =
      kind === "primary-only"
        ? { secondaryCredentialId: undefined }
        : kind === "malformed-credentials"
          ? { primaryCredentialId: { id: "unexpected-object" } }
          : kind === "same-credential"
            ? { secondaryCredentialId: "primary-credential" }
            : {};
    storeInterruptedSetup(override);
  }
  if (kind === "malformed-config")
    localStorage.setItem(walletStorageKey("config", resumeProfile), "{}");
  const backend = resumeBackend();
  const { result } = renderHook(() => useVault(), {
    wrapper: wrapper({
      client: kind === "historical-account" ? historicalClient() : makeClient(),
      ...(kind === "current-account" || kind === "historical-account" ? { config } : {}),
      backend,
    }),
  });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(backend.autoProvisionVault).not.toHaveBeenCalled();
  expect(backend.registerPasskey).not.toHaveBeenCalled();
  if (kind === "historical-account")
    expect(result.current.state.compatibility?.mode).toBe("read-only");
});

it.each(["rpc_request_failed", "provisioning_nonce_mismatch", "provisioning_pending_confirmation"])(
  "automatically retries %s with bounded waits and preserves credentials",
  async (code) => {
    storeInterruptedSetup();
    const backend = resumeBackend();
    vi.mocked(backend.autoProvisionVault).mockRejectedValueOnce(
      new BackendRequestError({
        status: 503,
        message: "Temporary setup wait",
        code,
        requestId: "resume-123",
      }),
    );
    vi.useFakeTimers();
    let mounted!: ReturnType<typeof renderHook<ReturnType<typeof useVault>, unknown>>;
    await act(async () => {
      mounted = renderHook(() => useVault(), {
        wrapper: wrapper({ client: makeClient(), backend }),
      });
    });
    expect(backend.autoProvisionVault).toHaveBeenCalledTimes(1);
    expect(mounted.result.current.setup.provisioning).toBe("provisioning");
    expect(localStorage.getItem(walletStorageKey("config", resumeProfile))).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(backend.autoProvisionVault).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mounted.result.current.setup.provisioning).toBe("provisioned");
    expect(backend.autoProvisionVault).toHaveBeenCalledTimes(2);
    expect(backend.registerPasskey).not.toHaveBeenCalled();
    expect(mounted.result.current.setup.primaryCredentialId).toBe("primary-credential");
  },
);

it.each(["rpc_request_failed", "unrecognized_failure"])(
  "stops automatic retries after a bounded %s failure",
  async (code) => {
    storeInterruptedSetup();
    const backend = resumeBackend();
    vi.mocked(backend.autoProvisionVault).mockRejectedValue(
      new BackendRequestError({
        status: 503,
        message: "Setup unavailable",
        code,
        requestId: "bounded-123",
      }),
    );
    vi.useFakeTimers();
    let mounted!: ReturnType<typeof renderHook<ReturnType<typeof useVault>, unknown>>;
    await act(async () => {
      mounted = renderHook(() => useVault(), {
        wrapper: wrapper({ client: makeClient(), backend }),
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(backend.autoProvisionVault).toHaveBeenCalledTimes(code === "rpc_request_failed" ? 3 : 1);
    expect(mounted.result.current.setup.provisioning).toBe("failed");
    expect(mounted.result.current.setup.provisioningError).toContain("bounded-123");
    expect(localStorage.getItem(walletStorageKey("config", resumeProfile))).toBeNull();
    expect(mounted.result.current.setup.secondaryCredentialId).toBe("secondary-credential");
    expect(backend.registerPasskey).not.toHaveBeenCalled();
  },
);

it.each([200, 404])(
  "reads the saved account through the current-vault HTTP endpoint (%s) without redeployment",
  async (status) => {
    storeInterruptedSetup({ provisioning: "provisioned" });
    const saved = JSON.stringify(config);
    localStorage.setItem(walletStorageKey("config", resumeProfile), saved);
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      if (String(input).endsWith("/v1/vaults/current"))
        return new Response(
          JSON.stringify(
            status === 404
              ? { error: "vault is not provisioned" }
              : {
                  ...resumedProvisioningResult,
                  credentialRebind: { required: true, primary: "required", secondary: "required" },
                },
          ),
          { status },
        );
      expect(String(input)).toBe("http://localhost:8787/health");
      return new Response(
        JSON.stringify({
          ok: true,
          provisioningReady: true,
          writesReady: false,
          chainId: 11155111,
          profileId: "local",
          origin: "http://localhost:5173",
          rpId: "localhost",
        }),
      );
    });
    vi.stubGlobal("fetch", fetcher);
    const { result } = renderHook(() => useVault(), { wrapper: wrapper({ client: makeClient() }) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).endsWith("/v1/vaults/current")),
    ).toHaveLength(1);
    expect(result.current.canWrite).toBe(false);
    expect(result.current.state.safe).toBe(SAFE);
    if (status === 200)
      expect(result.current.setup.credentialRebind).toEqual({
        required: true,
        primary: "required",
        secondary: "required",
      });
    expect(localStorage.getItem(walletStorageKey("config", resumeProfile))).toBe(saved);
    expect(signSafeDigest).not.toHaveBeenCalled();
  },
);

it("reloads a saved vault's backend binding status after restart without provisioning or a device prompt", async () => {
  storeInterruptedSetup({
    provisioning: "provisioned",
    credentialRebind: { required: false, primary: "ready", secondary: "ready" },
  });
  localStorage.setItem(walletStorageKey("config", resumeProfile), JSON.stringify(config));
  const backend = {
    ...resumeBackend(),
    health: vi
      .fn()
      .mockRejectedValue(new Error("Backend health check failed: submission runtime is not ready")),
    currentVault: vi.fn().mockResolvedValue({
      ...resumedProvisioningResult,
      credentialRebind: { required: true, primary: "required", secondary: "required" },
    }),
  };
  const { result, rerender } = renderHook(() => useVault(), {
    wrapper: wrapper({ client: makeClient(), backend }),
  });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.setup.credentialRebind).toEqual({
    required: true,
    primary: "required",
    secondary: "required",
  });
  expect(result.current.setup.provisioning).toBe("provisioning");
  expect(result.current.canWrite).toBe(false);
  expect(result.current.state.safe).toBe(SAFE);
  expect(backend.currentVault).toHaveBeenCalledTimes(1);
  rerender();
  expect(backend.currentVault).toHaveBeenCalledTimes(1);
  expect(backend.autoProvisionVault).not.toHaveBeenCalled();
  expect(backend.registerPasskey).not.toHaveBeenCalled();
  await act(() => result.current.refresh());
  expect(backend.currentVault).toHaveBeenCalledTimes(2);
  expect(result.current.setup.credentialRebind.primary).toBe("required");
});

it.each(["chainId", "safe", "guard", "delay", "usdc"])(
  "blocks writes when the server current vault has a different %s without replacing saved references",
  async (field) => {
    storeInterruptedSetup({ provisioning: "provisioned" });
    const saved = JSON.stringify(config);
    localStorage.setItem(walletStorageKey("config", resumeProfile), saved);
    const backend = {
      ...resumeBackend(),
      currentVault: vi.fn().mockResolvedValue({
        ...resumedProvisioningResult,
        credentialRebind: { required: false, primary: "ready", secondary: "ready" },
        [field]: field === "chainId" ? 1 : "0x9999999999999999999999999999999999999999",
      }),
    };
    const { result } = renderHook(() => useVault(), {
      wrapper: wrapper({ client: makeClient(), backend }),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.canWrite).toBe(false);
    expect(result.current.state.health).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "backend-not-ready", blocking: true }),
      ]),
    );
    expect(localStorage.getItem(walletStorageKey("config", resumeProfile))).toBe(saved);
    expect(backend.autoProvisionVault).not.toHaveBeenCalled();
  },
);

it("does not query the current backend vault for a historical account", async () => {
  storeInterruptedSetup({ provisioning: "provisioned" });
  const backend = { ...resumeBackend(), currentVault: vi.fn() };
  const { result } = renderHook(() => useVault(), {
    wrapper: wrapper({ client: historicalClient(), config, backend }),
  });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.state.compatibility?.mode).toBe("read-only");
  expect(backend.currentVault).not.toHaveBeenCalled();
  expect(backend.autoProvisionVault).not.toHaveBeenCalled();
});

it.each([undefined, {}, { required: false, primary: "required", secondary: "ready" }])(
  "blocks writes when current vault or its binding status is unavailable or inconsistent: %j",
  async (credentialRebind) => {
    const backend = {
      ...resumeBackend(),
      currentVault: vi
        .fn()
        .mockResolvedValue(
          credentialRebind === undefined
            ? undefined
            : { ...resumedProvisioningResult, credentialRebind },
        ),
    };
    const { result } = renderHook(() => useVault(), {
      wrapper: wrapper({ client: makeClient(), config, backend }),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.canWrite).toBe(false);
    expect(backend.autoProvisionVault).not.toHaveBeenCalled();
  },
);

it("persists a recovered vault, resumes signer rebind after reload, and never writes before both roles are ready", async () => {
  const storage = { id: "local" as const, rpId: "localhost" };
  localStorage.setItem(
    walletStorageKey("ui", storage),
    JSON.stringify({
      notifications: { email: true, push: false },
      rehearsed: false,
      primaryCredentialId: "primary-credential",
      secondaryCredentialId: "secondary-credential",
      secondaryAuthenticator: "cross-platform",
      provisioning: "failed",
      submissionIds: [],
    }),
  );
  const prepareIntent = vi.fn();
  const rebound = new Set<string>();
  const rebindPasskey = vi.fn(async (role: "primary" | "secondary") => {
    rebound.add(role);
    return {
      required: rebound.size !== 2,
      primary: rebound.has("primary") ? ("ready" as const) : ("required" as const),
      secondary: rebound.has("secondary") ? ("ready" as const) : ("required" as const),
    };
  });
  const backend = {
    health: async (purpose?: "provision" | "write") =>
      checkBackendHealth(
        {
          id: "local",
          rpId: "localhost",
          chainId: 11155111,
          appOrigin: "http://localhost:5173",
          backendOrigin: "http://localhost:8787",
          credentials: "include",
        },
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              provisioningReady: true,
              writesReady: rebound.size === 2,
              chainId: 11155111,
              profileId: "local",
              origin: "http://localhost:5173",
              rpId: "localhost",
            }),
          ),
        purpose,
      ),
    registerPasskey: vi.fn(),
    autoProvisionVault: vi.fn().mockResolvedValue({
      chainId: 11155111,
      safe: SAFE,
      guard: GUARD,
      delay: DELAY,
      usdc: USDC,
      primaryPasskey: SAFE,
      secondaryPasskey: GUARD,
      evidence: {
        setupTransactionHash: `0x${"11".repeat(32)}`,
        verificationReportHash: `0x${"22".repeat(32)}`,
      },
      credentialRebind: { required: true, primary: "required", secondary: "required" },
    }),
    rebindPasskey,
    prepareIntent,
    submit: vi.fn(),
    submission: vi.fn(),
  } satisfies VaultBackend;
  const first = renderHook(() => useVault(), {
    wrapper: wrapper({ client: makeClient(), backend }),
  });
  await waitFor(() => expect(first.result.current.hydrated).toBe(true));
  await act(() => first.result.current.retryProvisioning());
  expect(first.result.current.setup.credentialRebind).toEqual({
    required: true,
    primary: "required",
    secondary: "required",
  });
  expect(
    JSON.parse(localStorage.getItem(walletStorageKey("config", storage)) ?? "null"),
  ).toMatchObject({ safe: SAFE });
  first.unmount();

  const resumed = renderHook(() => useVault(), {
    wrapper: wrapper({ client: makeClient(), backend }),
  });
  await waitFor(() => expect(resumed.result.current.state.safe).toBe(SAFE));
  expect(resumed.result.current.canWrite).toBe(false);
  expect(resumed.result.current.setup.credentialRebind.primary).toBe("required");
  await expect(
    resumed.result.current.prepareTransfer({ recipient: RECIPIENT, amount: 1n }),
  ).rejects.toThrow(/verify both recovered signers/i);
  expect(prepareIntent).not.toHaveBeenCalled();
  await act(() => resumed.result.current.rebindPrimary());
  expect(rebindPasskey).toHaveBeenNthCalledWith(1, "primary", "primary-credential");
  await expect(resumed.result.current.reconcileSubmission("pending")).rejects.toThrow(
    /verify both recovered signers/i,
  );
  expect(backend.submission).not.toHaveBeenCalled();
  await act(() => resumed.result.current.rebindSecondary());
  expect(rebindPasskey).toHaveBeenNthCalledWith(2, "secondary", "secondary-credential");
  expect(resumed.result.current.setup).toMatchObject({
    provisioning: "provisioned",
    credentialRebind: { required: false, primary: "ready", secondary: "ready" },
  });
  expect(resumed.result.current.canWrite).toBe(true);
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

it("unlocks base/status with only first-key login and asks for the original second key only for requested roles", async () => {
  const backend = resumeBackend();
  const prepareIntent = vi.fn(
    async () =>
      ({
        id: "base-first-only",
        requestHash: `0x${"11".repeat(32)}`,
        safeTxHash: `0x${"22".repeat(32)}`,
        kind: "base-transfer",
        requiredApprovals: ["primary"],
        publicRequest: {},
      }) as never,
  );
  const submit = vi.fn(async () => ({ id: "base-first-only", state: "confirmed" }) as never);
  const currentVault = vi.fn(
    async () =>
      ({
        ...resumedProvisioningResult,
        credentialRebind: { required: false, primary: "ready", secondary: "required" },
      }) as VaultProvisioningResult,
  );
  const api: VaultBackend = {
    ...backend,
    session: vi.fn(async () => ({
      authenticated: true,
      account: {
        id: "a",
        userHandle: "dXNlcg",
        state: "verified" as const,
        primaryCredentialId: "a-first",
        vault: await currentVault(),
      },
    })),
    currentVault,
    prepareIntent,
    submit,
  };
  const { result } = renderHook(() => useVault(), {
    wrapper: wrapper({ client: makeClient(), backend: api }),
  });
  await waitFor(() => expect(result.current.canWrite).toBe(true));
  expect(result.current.setup.secondaryCredentialId).toBeUndefined();
  await act(() => result.current.prepareTransfer({ recipient: RECIPIENT, amount: 1n }));
  expect(signSafeDigest).toHaveBeenCalledTimes(1);
  expect(signSafeDigest).toHaveBeenLastCalledWith(
    expect.objectContaining({ role: "primary", credentialId: "a-first" }),
  );
  vi.mocked(backend.submission).mockResolvedValueOnce({ id: "durable", state: "uncertain" });
  await expect(result.current.reconcileSubmission("durable")).resolves.toMatchObject({
    state: "uncertain",
  });
});

it("discards an exact approval when logout occurs while the browser signer is open", async () => {
  let release!: (value: Awaited<ReturnType<typeof signSafeDigest>>) => void;
  const backend = resumeBackend();
  const api: VaultBackend = {
    ...backend,
    signOut: vi.fn(async () => ({ authenticated: false })),
    session: vi.fn(async () => ({
      authenticated: true,
      account: {
        id: "a",
        userHandle: "dXNlcg",
        state: "verified" as const,
        primaryCredentialId: "a-first",
        vault: resumedProvisioningResult,
      },
    })),
    currentVault: vi.fn(async () => ({
      ...resumedProvisioningResult,
      credentialRebind: {
        required: false,
        primary: "ready" as const,
        secondary: "required" as const,
      },
    })),
    prepareIntent: vi.fn(
      async () =>
        ({
          id: "old-approval",
          requestHash: `0x${"11".repeat(32)}`,
          safeTxHash: `0x${"22".repeat(32)}`,
          kind: "base-transfer",
          requiredApprovals: ["primary"],
          publicRequest: {},
        }) as never,
    ),
  };
  const { result } = renderHook(() => useVault(), {
    wrapper: wrapper({ client: makeClient(), backend: api }),
  });
  await waitFor(() => expect(result.current.canWrite).toBe(true));
  vi.mocked(signSafeDigest).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  let approval!: Promise<unknown>;
  await act(async () => {
    approval = result.current.prepareTransfer({ recipient: RECIPIENT, amount: 1n });
  });
  await waitFor(() => expect(release).toBeDefined());
  await act(() => result.current.signOut());
  release({ id: "a-first" } as never);
  await expect(approval).rejects.toThrow(/session changed/i);
  expect(api.submit).not.toHaveBeenCalled();
  expect(result.current.state.safe).toBe("");
});

it("creates a separate server account when starting fresh from a historical signed-in vault", async () => {
  const createAccount = vi.fn(async () => ({
    authenticated: false,
    account: { id: "fresh", userHandle: "dXNlcg", state: "registering" as const },
  }));
  const signOut = vi.fn(async () => ({ authenticated: false }));
  const api: VaultBackend = {
    ...resumeBackend(),
    createAccount,
    signOut,
    session: vi.fn(async () => ({
      authenticated: true,
      account: {
        id: "old",
        userHandle: "dXNlcg",
        state: "verified" as const,
        primaryCredentialId: "old-first",
        vault: resumedProvisioningResult,
      },
    })),
  };
  const { result } = renderHook(() => useVault(), {
    wrapper: wrapper({ client: historicalClient(), backend: api }),
  });
  await waitFor(() => expect(result.current.state.compatibility?.mode).toBe("read-only"));
  await act(() => result.current.startNewVault());
  expect(signOut).toHaveBeenCalledTimes(1);
  expect(createAccount).toHaveBeenCalledTimes(1);
  expect(result.current.accountId).toBe("fresh");
  expect(readWalletAccountArchive(resumeProfile, SAFE)?.safe).toBe(SAFE);
});

it.each(["queued", "provisioning"] as const)(
  "resumes a %s immutable legacy plan without a secondary credential reference or re-registration",
  async (phase) => {
    const api: VaultBackend = {
      ...resumeBackend(),
      session: vi.fn(async () => ({
        authenticated: true,
        account: {
          id: "legacy",
          userHandle: "dXNlcg",
          state: phase,
          primaryCredentialId: "legacy-first",
        },
      })),
    };
    const { result } = renderHook(() => useVault(), {
      wrapper: wrapper({ client: makeClient(), backend: api }),
    });
    await waitFor(() => expect(api.autoProvisionVault).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.setup.provisioning).toBe("provisioned"));
    expect(result.current.setup.reviewedPlanBound).toBe(true);
    expect(result.current.setup.secondaryCredentialId).toBeUndefined();
    expect(api.registerPasskey).not.toHaveBeenCalled();
    expect(signSafeDigest).not.toHaveBeenCalled();
  },
);

it("does not treat a registering account with a missing second signer as a bound recovery plan", async () => {
  const api: VaultBackend = {
    ...resumeBackend(),
    session: vi.fn(async () => ({
      authenticated: true,
      account: {
        id: "new",
        userHandle: "dXNlcg",
        state: "registering" as const,
        primaryCredentialId: "new-first",
      },
    })),
  };
  const { result } = renderHook(() => useVault(), {
    wrapper: wrapper({ client: makeClient(), backend: api }),
  });
  await waitFor(() => expect(result.current.hydrated).toBe(true));
  expect(result.current.setup.reviewedPlanBound).toBe(false);
  expect(api.autoProvisionVault).not.toHaveBeenCalled();
});

describe("automatic receipt status", () => {
  const hash = `0x${"aa".repeat(32)}` as const;
  function saved(ids: string[]) {
    localStorage.setItem(
      walletStorageKey("ui", { id: "local", rpId: "localhost" }),
      JSON.stringify({ primaryCredentialId: "p", secondaryCredentialId: "s", submissionIds: ids }),
    );
  }
  function statusBackend(submission: VaultBackend["submission"]): VaultBackend {
    return {
      health: vi.fn().mockResolvedValue(undefined),
      registerPasskey: vi.fn(),
      autoProvisionVault: vi.fn(),
      prepareIntent: vi.fn(),
      submit: vi.fn(),
      submission,
    };
  }
  it("restores known ids, updates pending receipts and refreshes the vault only once on completion", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    saved(["pending", "approval", "superseded"]);
    const client = makeClient();
    let confirmed = false;
    const submission = vi.fn(async (id: string) => ({
      id,
      state:
        id === "approval"
          ? ("awaiting-secondary" as const)
          : id === "superseded"
            ? ("superseded" as const)
            : confirmed
              ? ("confirmed" as const)
              : ("uncertain" as const),
      ...(id === "pending" ? { transactionHash: hash } : {}),
    }));
    const backend = statusBackend(submission);
    const { result } = renderHook(() => useVault(), {
      wrapper: wrapper({ client, config, backend }),
    });
    await waitFor(() => expect(result.current.state.writable).toBe(true));
    await waitFor(() => expect(result.current.submissions?.["pending"]?.state).toBe("uncertain"));
    expect(result.current.submissions["approval"]?.state).toBe("awaiting-secondary");
    expect(client.getBlockNumber).toHaveBeenCalledTimes(1);
    confirmed = true;
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(result.current.submissions["pending"]?.state).toBe("confirmed");
    expect(client.getBlockNumber).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(submission.mock.calls.map(([id]) => id)).toEqual([
      "pending",
      "approval",
      "superseded",
      "pending",
    ]);
    expect(client.getBlockNumber).toHaveBeenCalledTimes(2);
    expect(backend.submit).not.toHaveBeenCalled();
    expect(signSafeDigest).not.toHaveBeenCalled();
  });
  it("retries failed reads at a bounded cadence without overlapping manual or automatic reads", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    saved(["retry"]);
    let release!: (status: {
      id: string;
      state: "uncertain";
      transactionHash: typeof hash;
    }) => void;
    const submission = vi
      .fn()
      .mockRejectedValueOnce(new Error("RPC unavailable"))
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
    const { result, unmount } = renderHook(() => useVault(), {
      wrapper: wrapper({ backend: statusBackend(submission) }),
    });
    await waitFor(() => expect(submission).toHaveBeenCalledTimes(1));
    await act(() => vi.advanceTimersByTimeAsync(4_900));
    expect(submission).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(submission).toHaveBeenCalledTimes(2);
    let manual!: Promise<unknown>;
    act(() => {
      manual = result.current.reconcileSubmission("retry");
    });
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(submission).toHaveBeenCalledTimes(2);
    await act(async () => {
      release({ id: "retry", state: "uncertain", transactionHash: hash });
      await manual;
    });
    expect(result.current.submissions["retry"]?.state).toBe("uncertain");
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(submission).toHaveBeenCalledTimes(2);
  });
  it("discards an old receipt response on logout and fetches only the next account's ids", async () => {
    let release!: (status: {
      id: string;
      state: "confirmed";
      transactionHash: typeof hash;
    }) => void;
    const submission = vi.fn((id: string) =>
      id === "old"
        ? new Promise<{ id: string; state: "confirmed"; transactionHash: typeof hash }>(
            (resolve) => {
              release = resolve;
            },
          )
        : Promise.resolve({ id, state: "awaiting-primary" as const }),
    );
    const backend: VaultBackend = {
      ...statusBackend(submission),
      session: vi.fn(async () => ({
        authenticated: true,
        account: {
          id: "a",
          userHandle: "a",
          state: "registering" as const,
          submissionIds: ["old"],
        },
      })),
      signOut: vi.fn(async () => ({ authenticated: false })),
      signIn: vi.fn(async () => ({
        authenticated: true,
        account: {
          id: "b",
          userHandle: "b",
          state: "registering" as const,
          submissionIds: ["new"],
        },
      })),
    };
    const { result } = renderHook(() => useVault(), { wrapper: wrapper({ backend }) });
    await waitFor(() => expect(submission).toHaveBeenCalledWith("old"));
    await act(() => result.current.signOut());
    await act(() => result.current.signIn());
    await waitFor(() =>
      expect(result.current.submissions?.["new"]?.state).toBe("awaiting-primary"),
    );
    await act(async () => {
      release({ id: "old", state: "confirmed", transactionHash: hash });
    });
    expect(result.current.accountId).toBe("b");
    expect(result.current.submissions["old"]).toBeUndefined();
    expect(result.current.setup.submissionIds).toEqual(["new"]);
  });
  it("tracks a newly submitted hash without further signing or submission", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    saved([]);
    const submission = vi.fn(async (id: string) => ({
      id,
      state: "confirmed" as const,
      transactionHash: hash,
    }));
    const backend = {
      ...statusBackend(submission),
      prepareIntent: vi.fn(async () => ({
        id: "new",
        kind: "base-transfer" as const,
        requestHash: hash,
        safeTxHash: hash,
        requiredApprovals: ["primary" as const],
        publicRequest: {},
      })),
      submit: vi.fn(async () => ({
        id: "new",
        state: "uncertain" as const,
        transactionHash: hash,
      })),
    };
    const client = makeClient();
    const { result } = renderHook(() => useVault(), {
      wrapper: wrapper({ client, config, backend }),
    });
    await waitFor(() => expect(result.current.state.writable).toBe(true));
    await act(() => result.current.prepareTransfer({ recipient: RECIPIENT, amount: 1n }));
    expect(result.current.submissions["new"]?.state).toBe("uncertain");
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(result.current.submissions["new"]?.state).toBe("confirmed");
    expect(client.getBlockNumber).toHaveBeenCalledTimes(2);
    expect(backend.submit).toHaveBeenCalledTimes(1);
    expect(signSafeDigest).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(submission).toHaveBeenCalledTimes(1);
    expect(backend.submit).toHaveBeenCalledTimes(1);
  });
  it("does not regress a completed receipt when an earlier submit response arrives late", async () => {
    saved([]);
    let release!: (status: {
      id: string;
      state: "uncertain";
      transactionHash: typeof hash;
    }) => void;
    const backend = {
      ...statusBackend(
        vi.fn(async (id: string) => ({ id, state: "confirmed" as const, transactionHash: hash })),
      ),
      prepareIntent: vi.fn(async () => ({
        id: "race",
        kind: "base-transfer" as const,
        requestHash: hash,
        safeTxHash: hash,
        requiredApprovals: ["primary" as const],
        publicRequest: {},
      })),
      submit: vi.fn(
        () =>
          new Promise<{ id: string; state: "uncertain"; transactionHash: typeof hash }>(
            (resolve) => {
              release = resolve;
            },
          ),
      ),
    };
    const { result } = renderHook(() => useVault(), {
      wrapper: wrapper({ client: makeClient(), config, backend }),
    });
    await waitFor(() => expect(result.current.state.writable).toBe(true));
    let action!: Promise<unknown>;
    await act(async () => {
      action = result.current.prepareTransfer({ recipient: RECIPIENT, amount: 1n });
    });
    await waitFor(() => expect(result.current.submissions["race"]?.state).toBe("confirmed"));
    await act(async () => {
      release({ id: "race", state: "uncertain", transactionHash: hash });
      await action;
    });
    expect(result.current.submissions["race"]?.state).toBe("confirmed");
  });
  it("ignores in-flight status completion after unmount", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    saved(["pending"]);
    let release!: (status: {
      id: string;
      state: "confirmed";
      transactionHash: typeof hash;
    }) => void;
    const submission = vi.fn(
      () =>
        new Promise<{ id: string; state: "confirmed"; transactionHash: typeof hash }>((resolve) => {
          release = resolve;
        }),
    );
    const client = makeClient();
    const { result, unmount } = renderHook(() => useVault(), {
      wrapper: wrapper({ client, config, backend: statusBackend(submission) }),
    });
    await waitFor(() => expect(result.current.state.writable).toBe(true));
    await waitFor(() => expect(submission).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => {
      release({ id: "pending", state: "confirmed", transactionHash: hash });
    });
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(submission).toHaveBeenCalledTimes(1);
    expect(client.getBlockNumber).toHaveBeenCalledTimes(1);
  });
  it("refreshes a restored receipt that first confirms after the hydration snapshot", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    saved(["confirmed-after-hydration"]);
    const client = makeClient();
    const submission = vi.fn().mockRejectedValueOnce(new Error("temporarily unavailable")).mockResolvedValue({
      id: "confirmed-after-hydration", state: "confirmed", transactionHash: hash,
      receipt: { transactionHash: hash, blockNumber: 124n, blockHash: hash },
    });
    const { result } = renderHook(() => useVault(), {
      wrapper: wrapper({ client, config, backend: statusBackend(submission) }),
    });
    await waitFor(() => expect(result.current.state.writable).toBe(true));
    await waitFor(() => expect(submission).toHaveBeenCalledTimes(1));
    expect(result.current.state.balance).toBe(12_345_678n);
    vi.mocked(client.getBlockNumber).mockResolvedValue(129n);
    const read = vi.mocked(client.readContract).getMockImplementation()!;
    vi.mocked(client.readContract).mockImplementation(async input =>
      input.functionName === "balanceOf" ? 22_345_678n : read(input),
    );
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(result.current.submissions["confirmed-after-hydration"]?.state).toBe("confirmed");
    expect(result.current.state.balance).toBe(22_345_678n);
    expect(client.getBlockNumber).toHaveBeenCalledTimes(2);
  });
  it("reads restored terminal history without collecting extra vault snapshots", async () => {
    saved(["old-confirmed", "old-reverted"]);
    const client = makeClient();
    const submission = vi.fn(async (id: string) => ({
      id,
      state: id === "old-confirmed" ? ("confirmed" as const) : ("reverted" as const),
      transactionHash: hash,
      receipt: { transactionHash: hash, blockNumber: 120n, blockHash: hash },
    }));
    const { result } = renderHook(() => useVault(), {
      wrapper: wrapper({ client, config, backend: statusBackend(submission) }),
    });
    await waitFor(() => expect(result.current.submissions["old-reverted"]?.state).toBe("reverted"));
    expect(client.getBlockNumber).toHaveBeenCalledTimes(1);
  });
  it("coalesces terminal completions in one status sweep into one vault refresh", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    saved(["one", "two"]);
    let complete = false;
    const client = makeClient();
    const submission = vi.fn(async (id: string) => ({
      id,
      state: complete ? ("confirmed" as const) : ("uncertain" as const),
      transactionHash: hash,
    }));
    const { result } = renderHook(() => useVault(), {
      wrapper: wrapper({ client, config, backend: statusBackend(submission) }),
    });
    await waitFor(() => expect(result.current.submissions["two"]?.state).toBe("uncertain"));
    complete = true;
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(result.current.submissions["one"]?.state).toBe("confirmed");
    expect(result.current.submissions["two"]?.state).toBe("confirmed");
    expect(client.getBlockNumber).toHaveBeenCalledTimes(2);
  });
  it("ignores an older approval status GET after observing a newer submitted hash", async () => {
    saved([]);
    let releaseRead!: (status: { id: string; state: "awaiting-primary" }) => void;
    let releaseSubmit!: (status: {
      id: string;
      state: "uncertain";
      transactionHash: typeof hash;
    }) => void;
    const submission = vi.fn(
      () =>
        new Promise<{ id: string; state: "awaiting-primary" }>((resolve) => {
          releaseRead = resolve;
        }),
    );
    const backend = {
      ...statusBackend(submission),
      prepareIntent: vi.fn(async () => ({
        id: "newer",
        kind: "base-transfer" as const,
        requestHash: hash,
        safeTxHash: hash,
        requiredApprovals: ["primary" as const],
        publicRequest: {},
      })),
      submit: vi.fn(
        () =>
          new Promise<{ id: string; state: "uncertain"; transactionHash: typeof hash }>(
            (resolve) => {
              releaseSubmit = resolve;
            },
          ),
      ),
    };
    const { result } = renderHook(() => useVault(), {
      wrapper: wrapper({ client: makeClient(), config, backend }),
    });
    await waitFor(() => expect(result.current.state.writable).toBe(true));
    let action!: Promise<unknown>;
    await act(async () => {
      action = result.current.prepareTransfer({ recipient: RECIPIENT, amount: 1n });
    });
    await waitFor(() => expect(submission).toHaveBeenCalledTimes(1));
    await act(async () => {
      releaseSubmit({ id: "newer", state: "uncertain", transactionHash: hash });
      await action;
    });
    await act(async () => {
      releaseRead({ id: "newer", state: "awaiting-primary" });
    });
    expect(result.current.submissions["newer"]?.state).toBe("uncertain");
  });
  it("pauses offline status reads and resumes known pending hashes on reconnect", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    saved(["pending", "without-hash"]);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    const submission = vi.fn(async (id: string) => ({
      id,
      state: "uncertain" as const,
      ...(id === "pending" ? { transactionHash: hash } : {}),
    }));
    const { result } = renderHook(() => useVault(), {
      wrapper: wrapper({ backend: statusBackend(submission) }),
    });
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(submission).not.toHaveBeenCalled();
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(result.current.submissions["pending"]?.state).toBe("uncertain");
    expect(result.current.submissions["without-hash"]?.state).toBe("uncertain");
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(submission.mock.calls.map(([id]) => id)).toEqual(["pending", "without-hash", "pending"]);
  });
});
