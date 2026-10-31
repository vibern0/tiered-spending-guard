import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { createPublicClient, type Address, type PublicClient } from "viem";

vi.mock("viem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("viem")>()),
  createPublicClient: vi.fn(),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  localStorage.clear();
});
import { checkBackendHealth, useVault, VaultProvider, type VaultBackend } from "./vault-store";
import type { WalletEnvironmentProfile } from "./environment-profile";
import type { VaultConfig } from "./vault-chain";
import { TEST_USDC_ADDRESS, TEST_USDC_RUNTIME } from "./usdc-test-fixture";

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
        assetPolicy: [100_000_000n, 200_000_000n, 250_000_000n, 1_000_000_000n],
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
      id: "local", chainId: 11155111, appOrigin: "http://localhost:5173", rpId: "localhost", backendOrigin: "http://127.0.0.1:8787", credentials: "omit",
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
        async () => new Response(JSON.stringify({ ok: true, chainId: 11155111, profileId: "https", origin: "https://vault.example", rpId: "vault.example" })),
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
});

it("keeps the configured RPC client stable across provider rerenders", async () => {
  vi.stubEnv("VITE_SEPOLIA_RPC_URL", "http://localhost:9999");
  const rpcClient = makeClient();
  vi.mocked(createPublicClient).mockReturnValue(rpcClient);
  const { result, rerender } = renderHook(() => useVault(), { wrapper: wrapper({ config }) });
  await waitFor(() => expect(result.current.state.writable).toBe(true));
  rerender();
  expect(createPublicClient).toHaveBeenCalledTimes(1);
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
    provisionVault: async () => ({
      chainId: 11155111,
      safe: SAFE,
      guard: GUARD,
      delay: DELAY,
      usdc: USDC,
      primaryPasskey: SAFE,
      secondaryPasskey: GUARD,
      evidence: { setupTransactionHash: "0x11", verificationReportHash: "0x22" },
    }),
    prepareTransfer: vi.fn(),
    submitPrimary: vi.fn(),
    submitSecondary: vi.fn(),
  };
  const { result } = renderHook(() => useVault(), {
    wrapper: wrapper({ client: makeClient(), config, backend }),
  });
  await waitFor(() => expect(result.current.hydrated).toBe(true));
  await act(async () => {
    await result.current.provision();
  });
  await waitFor(() =>
    expect(JSON.parse(localStorage.getItem("usdc-vault-ui-v1") ?? "{}")).toMatchObject({
      primaryCredentialId: "primary-credential",
      secondaryCredentialId: "secondary-credential",
    }),
  );
  act(() => result.current.finishSetup());
  await waitFor(() =>
    expect(JSON.parse(localStorage.getItem("usdc-vault-ui-v1") ?? "{}")).toMatchObject({
      primaryCredentialId: "primary-credential",
      secondaryCredentialId: "secondary-credential",
      deploymentHash: "0x11",
      policyHash: "0x22",
      rehearsed: true,
    }),
  );
});
