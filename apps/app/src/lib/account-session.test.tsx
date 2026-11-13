import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createVaultBackend,
  useVault,
  VaultProvider,
  walletStorageKey,
  type VaultBackend,
} from "./vault-store";
import { authenticateVaultPasskey, createVaultPasskey } from "./webauthn-passkey";
import { loadWalletEnvironmentProfile } from "./environment-profile";

vi.mock("./webauthn-passkey", async (original) => ({
  ...(await original<typeof import("./webauthn-passkey")>()),
  createVaultPasskey: vi.fn(async () => ({ credentialId: "fresh", response: {} })),
  authenticateVaultPasskey: vi.fn(async () => ({ id: "first", response: {} })),
}));
beforeEach(() => vi.stubEnv("VITE_BACKEND_ORIGIN", "http://localhost:8787"));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  localStorage.clear();
});
const account = (id: string) => ({
  id,
  userHandle: "dXNlcg",
  state: "registering" as const,
  primaryCredentialId: `${id}-first`,
});
const projection = (id: string) => ({
  authenticated: true,
  account: account(id),
  csrfToken: `csrf-${id}`,
});
const profile = loadWalletEnvironmentProfile({}, "http://localhost:5173");
const response = (value: unknown) => new Response(JSON.stringify(value));
function backend(overrides: Partial<VaultBackend> = {}): VaultBackend {
  return {
    session: vi.fn(async () => ({ authenticated: false })),
    signIn: vi.fn(async () => projection("a")),
    signOut: vi.fn(async () => ({ authenticated: false })),
    createAccount: vi.fn(async () => ({ authenticated: false, account: account("new") })),
    registerPasskey: vi.fn(),
    autoProvisionVault: vi.fn(),
    prepareIntent: vi.fn(),
    submit: vi.fn(),
    submission: vi.fn(),
    ...overrides,
  };
}
function wrapper(api: VaultBackend) {
  return ({ children }: { children: ReactNode }) =>
    createElement(VaultProvider, { backend: api, children });
}

describe("account HTTP client", () => {
  it("shares simultaneous hydration and focus reads for an unfinished signup", async () => {
    const fetcher = vi.fn(async () =>
      response({
        authenticated: false,
        csrfToken: "signup-csrf",
        account: { id: "new", state: "registering" },
      }),
    );
    const api = createVaultBackend(profile, fetcher);
    const results = await Promise.all([api.session!(), api.session!()]);
    expect(results.map((session) => session.account?.id)).toEqual(["new", "new"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("restores an unfinished signup under StrictMode without competing session reads", async () => {
    const signup = {
      authenticated: false,
      csrfToken: "signup-csrf",
      account: { id: "new", userHandle: "dXNlcg", state: "registering" },
    };
    const fetcher = vi.fn(async () => response(signup));
    const api = createVaultBackend(profile, fetcher);
    const { result } = renderHook(() => useVault(), {
      wrapper: ({ children }) =>
        createElement(StrictMode, {}, createElement(VaultProvider, { backend: api, children })),
    });
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.accountId).toBe("new");
    expect(result.current.setup.provisioningError).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("uses cookies and closure-only CSRF/account headers; discoverable sign in needs no saved credential", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, _init?: RequestInit) =>
      String(url).endsWith("/login/options")
        ? response({
            sessionId: "challenge",
            challenge: "YQ",
            rpId: "localhost",
            origin: profile.appOrigin,
            userVerification: "required",
            csrfToken: "anonymous-csrf",
          })
        : response(projection("a")),
    );
    const api = createVaultBackend(profile, fetcher);
    await api.signIn!();
    expect(authenticateVaultPasskey).toHaveBeenCalledWith(
      expect.objectContaining({ challenge: "YQ" }),
      undefined,
    );
    await api.prepareIntent({
      kind: "transfer",
      recipient: `0x${"11".repeat(20)}`,
      amount: 1n,
      idempotencyKey: "unique",
    });
    const [, verify] = fetcher.mock.calls.find(([url]) => String(url).endsWith("/login/verify"))!;
    expect(verify).toMatchObject({
      credentials: "include",
      headers: expect.objectContaining({ "x-csrf-token": "anonymous-csrf" }),
    });
    const [, request] = fetcher.mock.calls.at(-1)!;
    expect(request).toMatchObject({
      credentials: "include",
      headers: expect.objectContaining({ "x-csrf-token": "csrf-a", "x-vault-account": "a" }),
    });
    expect(localStorage.length).toBe(0);
  });
  it("forwards provider hints only with the exact targeted first credential", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/options")
        ? response({
            sessionId: "challenge",
            challenge: "YQ",
            rpId: "localhost",
            origin: profile.appOrigin,
            userVerification: "required",
            csrfToken: "csrf",
          })
        : response(projection("a")),
    );
    await createVaultBackend(profile, fetcher).signIn!("first", ["hybrid", "internal"]);
    expect(authenticateVaultPasskey).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialTransports: ["hybrid", "internal"],
      }),
      "first",
    );
  });
  it("rejects an old account response after another session projection selects an account", async () => {
    let release!: (value: Response) => void;
    let selected = "a";
    const fetcher = vi.fn(async (url: string | URL | Request, _init?: RequestInit) =>
      String(url).endsWith("/auth/session")
        ? response(projection(selected))
        : new Promise<Response>((resolve) => {
            release = resolve;
          }),
    );
    const api = createVaultBackend(profile, fetcher);
    await api.session!();
    const request = api.currentVault!();
    selected = "b";
    await api.session!();
    release(response({ safe: "old" }));
    await expect(request).rejects.toThrow(/changed|stale/i);
  });
});
describe("server-authoritative account lifecycle", () => {
  it("starts a separate signup when an anonymous session already has a first passkey", async () => {
    const api = backend({
      session: vi.fn(async () => ({
        authenticated: false,
        account: account("unfinished"),
        csrfToken: "unfinished-csrf",
      })),
    });
    const { result } = renderHook(() => useVault(), { wrapper: wrapper(api) });
    await waitFor(() => expect(result.current.accountId).toBe("unfinished"));
    await act(() => result.current.createAccount());
    expect(api.signOut).toHaveBeenCalledOnce();
    expect(vi.mocked(api.signOut!).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.createAccount!).mock.invocationCallOrder[0]!,
    );
    expect(result.current.accountId).toBe("new");
  });
  it("keeps a newly created signup when a focus read overlaps its response", async () => {
    let release!: (value: Response) => void;
    let reads = 0;
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/auth/setup"))
        return response({
          authenticated: false,
          csrfToken: "signup-csrf",
          account: { id: "new", userHandle: "dXNlcg", state: "registering" },
        });
      if (++reads === 1) return response({ authenticated: false });
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    const { result } = renderHook(() => useVault(), {
      wrapper: wrapper(createVaultBackend(profile, fetcher)),
    });
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    await act(async () => {
      const creation = result.current.createAccount();
      window.dispatchEvent(new Event("focus"));
      await creation;
    });
    await act(async () => release(response({ authenticated: false })));
    expect(result.current.accountId).toBe("new");
  });
  it("ignores cached roles before sign in and opens an existing account after clearing browser storage", async () => {
    localStorage.setItem(
      walletStorageKey("ui", { id: "local", rpId: "localhost" }),
      JSON.stringify({ primaryCredentialId: "wrong", secondaryCredentialId: "wrong-second" }),
    );
    const api = backend();
    const { result } = renderHook(() => useVault(), { wrapper: wrapper(api) });
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.setup.primaryCredentialId).toBeUndefined();
    localStorage.clear();
    await act(() => result.current.signIn());
    expect(result.current.accountId).toBe("a");
    expect(result.current.setup.primaryCredentialId).toBe("a-first");
    expect(api.registerPasskey).not.toHaveBeenCalled();
    await act(() => result.current.signOut());
    expect(result.current.accountId).toBeUndefined();
    expect(result.current.setup.primaryCredentialId).toBeUndefined();
    await act(() => result.current.createAccount());
    expect(result.current.accountId).toBe("new");
  });
  it("does not let a late initial session overwrite a new selected account", async () => {
    let release!: (value: ReturnType<typeof projection>) => void;
    const api = backend({
      session: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const { result } = renderHook(() => useVault(), { wrapper: wrapper(api) });
    await act(() => result.current.signIn());
    await act(async () => release(projection("old")));
    expect(result.current.accountId).toBe("a");
  });
  it("authenticates the newly registered first credential before accepting second registration", async () => {
    const api = backend({
      registerPasskey: vi.fn(async () => ({ credentialId: "fresh-first", response: {} }) as never),
    });
    const { result } = renderHook(() => useVault(), { wrapper: wrapper(api) });
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    await act(() => result.current.createAccount());
    await act(() => result.current.registerPrimary());
    expect(api.signIn).toHaveBeenCalledWith("fresh-first");
    expect(result.current.authenticated).toBe(true);
  });
  it("passes the first key's actual provider hints through registration and sign-in", async () => {
    const api = backend({
      registerPasskey: vi.fn(
        async () =>
          ({
            credentialId: "synced-first",
            response: { response: { transports: ["hybrid", "internal"] } },
          }) as never,
      ),
    });
    const { result } = renderHook(() => useVault(), { wrapper: wrapper(api) });
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    await act(() => result.current.createAccount());
    await act(() => result.current.registerPrimary());
    expect(api.signIn).toHaveBeenCalledWith("synced-first", ["hybrid", "internal"]);
  });
});

it("invalidates prepared browser work immediately when another tab changes the cookie account", async () => {
  let selected = "a";
  const channels: {
    onmessage: ((event: MessageEvent) => void) | null;
    postMessage: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }[] = [];
  class TestChannel {
    onmessage: ((event: MessageEvent) => void) | null = null;
    postMessage = vi.fn((data: unknown) => {
      for (const channel of channels)
        if (channel !== this) channel.onmessage?.({ data } as MessageEvent);
    });
    close = vi.fn();
    constructor(_name: string) {
      channels.push(this);
    }
  }
  vi.stubGlobal("BroadcastChannel", TestChannel);
  const first = backend({
    session: vi.fn(async () => (selected ? projection(selected) : { authenticated: false })),
  });
  const second = backend({
    session: vi.fn(async () => (selected ? projection(selected) : { authenticated: false })),
    signOut: vi.fn(async () => {
      selected = "";
      return { authenticated: false };
    }),
  });
  const a = renderHook(() => useVault(), { wrapper: wrapper(first) });
  const b = renderHook(() => useVault(), { wrapper: wrapper(second) });
  await waitFor(() => expect(a.result.current.accountId).toBe("a"));
  await waitFor(() => expect(b.result.current.accountId).toBe("a"));
  await act(() => b.result.current.signOut());
  await waitFor(() => expect(a.result.current.authenticated).toBe(false));
  expect(a.result.current.accountId).toBeUndefined();
  a.unmount();
  b.unmount();
  vi.unstubAllGlobals();
});

it("keeps two independent browser clients on their own account headers", async () => {
  const fetchA = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    response(projection("a")),
  );
  const fetchB = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    response(projection("b")),
  );
  const a = createVaultBackend(profile, fetchA);
  const b = createVaultBackend(profile, fetchB);
  await Promise.all([a.session!(), b.session!()]);
  await Promise.all([a.submission("same-id"), b.submission("same-id")]);
  expect(fetchA.mock.calls.at(-1)?.[1]?.headers).toMatchObject({ "x-vault-account": "a" });
  expect(fetchB.mock.calls.at(-1)?.[1]?.headers).toMatchObject({ "x-vault-account": "b" });
});

it("registers a timestamp-named discoverable first key with the stable server handle and no attachment hint", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 6, 18, 45, 30));
  const fetcher = vi.fn(async (url: string | URL | Request, _init?: RequestInit) =>
    String(url).endsWith("/options")
      ? response({
          sessionId: "challenge",
          challenge: "YQ",
          rpId: "localhost",
          origin: profile.appOrigin,
          role: "primary",
          userHandle: "c3RhYmxl",
          userVerification: "required",
        })
      : response(projection("a")),
  );
  const api = createVaultBackend(profile, fetcher);
  await api.session!();
  await api.registerPasskey("primary");
  expect(createVaultPasskey).toHaveBeenCalledWith(
    expect.objectContaining({
      options: expect.objectContaining({
        user: {
          id: "c3RhYmxl",
          name: "tiered-guard-vault-2026-11-06-18-45-30",
          displayName: "tiered-guard-vault-2026-11-06-18-45-30",
        },
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
      }),
    }),
  );
});

it("never sends a registration response to a different account after the browser prompt", async () => {
  let selected = "a";
  let release!: (value: Awaited<ReturnType<typeof createVaultPasskey>>) => void;
  const fetcher = vi.fn(async (url: string | URL | Request, _init?: RequestInit) =>
    String(url).endsWith("/options")
      ? response({
          sessionId: "challenge",
          challenge: "YQ",
          rpId: "localhost",
          origin: profile.appOrigin,
          role: "primary",
          userHandle: "c3RhYmxl",
          userVerification: "required",
        })
      : response(projection(selected)),
  );
  const api = createVaultBackend(profile, fetcher);
  await api.session!();
  vi.mocked(createVaultPasskey).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const registration = api.registerPasskey("primary");
  await waitFor(() => expect(release).toBeDefined());
  selected = "b";
  await api.session!();
  release({ credentialId: "old-first", response: {} } as never);
  await expect(registration).rejects.toThrow(/changed|stale/i);
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/verify"))).toBe(false);
});

it("does not restrict normal discoverable login with an unsolicited server credential list", async () => {
  const fetcher = vi.fn(async (url: string | URL | Request, _init?: RequestInit) =>
    String(url).endsWith("/login/options")
      ? response({
          sessionId: "challenge",
          challenge: "YQ",
          rpId: "localhost",
          origin: profile.appOrigin,
          userVerification: "required",
          csrfToken: "csrf",
          credentialIds: ["unrequested-first"],
        })
      : response(projection("a")),
  );
  await createVaultBackend(profile, fetcher).signIn!();
  expect(vi.mocked(authenticateVaultPasskey).mock.calls[0]![0]).not.toHaveProperty("credentialIds");
  const [, verify] = fetcher.mock.calls.find(([url]) => String(url).endsWith("/login/verify"))!;
  expect(JSON.parse(verify!.body as string)).not.toHaveProperty("accountId");
});

it("explains the first-passkey sign-in gate without requesting a second signer", async () => {
  const { result } = renderHook(() => useVault(), { wrapper: wrapper(backend()) });
  await waitFor(() => expect(result.current.hydrated).toBe(true));
  await expect(
    result.current.prepareTransfer({ recipient: `0x${"11".repeat(20)}`, amount: 1n }),
  ).rejects.toThrow(/first-passkey sign-in/i);
});

it("restores server-owned submission references after cleared-browser sign-in without importing another account's cache", async () => {
  const profile = { id: "local" as const, rpId: "localhost" };
  localStorage.setItem(
    walletStorageKey("ui", profile),
    JSON.stringify({ submissionIds: ["unscoped-other"] }),
  );
  localStorage.setItem(
    walletStorageKey("ui", { ...profile, accountId: "a" }),
    JSON.stringify({ submissionIds: ["stale-a"] }),
  );
  localStorage.setItem(
    walletStorageKey("ui", { ...profile, accountId: "b" }),
    JSON.stringify({ submissionIds: ["cached-b"] }),
  );
  const api = backend({
    signIn: vi.fn(async () => ({
      ...projection("a"),
      account: { ...account("a"), submissionIds: ["own-confirmed", "own-uncertain"] },
    })),
  });
  const { result } = renderHook(() => useVault(), { wrapper: wrapper(api) });
  await waitFor(() => expect(result.current.hydrated).toBe(true));
  expect(result.current.setup.submissionIds).toEqual([]);
  localStorage.clear();
  await act(() => result.current.signIn());
  expect(result.current.setup.submissionIds).toEqual(["own-confirmed", "own-uncertain"]);
  await act(() => result.current.signOut());
  vi.mocked(api.signIn!).mockResolvedValueOnce({
    ...projection("b"),
    account: { ...account("b"), submissionIds: [] },
  });
  await act(() => result.current.signIn());
  expect(result.current.accountId).toBe("b");
  expect(result.current.setup.submissionIds).toEqual([]);
});

it("uses cached references only for the selected account when an older projection omits submission IDs", async () => {
  const profile = { id: "local" as const, rpId: "localhost" };
  localStorage.setItem(
    walletStorageKey("ui", { ...profile, accountId: "a" }),
    JSON.stringify({ submissionIds: ["own-cached"] }),
  );
  localStorage.setItem(
    walletStorageKey("ui", { ...profile, accountId: "b" }),
    JSON.stringify({ submissionIds: ["other-cached"] }),
  );
  const { result } = renderHook(() => useVault(), {
    wrapper: wrapper(backend({ session: vi.fn(async () => projection("a")) })),
  });
  await waitFor(() => expect(result.current.hydrated).toBe(true));
  expect(result.current.setup.submissionIds).toEqual(["own-cached"]);
});

it("observes background setup through session polling without re-entering deployment", async () => {
  let phase: "queued" | "provisioning" | "blocked" = "queued";
  const api = backend({
    session: vi.fn(async () => ({
      ...projection("background"),
      account: { ...account("background"), state: phase, secondaryCredentialId: "second" },
    })),
  });
  const { result } = renderHook(() => useVault(), { wrapper: wrapper(api) });
  await waitFor(() => expect(result.current.setup.provisioning).toBe("provisioning"));
  phase = "blocked";
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  await waitFor(() => expect(result.current.setup.provisioning).toBe("failed"));
  expect(api.autoProvisionVault).not.toHaveBeenCalled();
  expect(api.registerPasskey).not.toHaveBeenCalled();
});

it("requests paginated account history with bigint decoding and rejects late history after logout", async () => {
  let release!: (response: Response) => void;
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    if (String(url).includes("/history"))
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    return response(String(url).endsWith("/logout") ? { authenticated: false } : projection("a"));
  });
  const api = createVaultBackend(profile, fetcher);
  await api.session!();
  const pending = api.history!("cursor value").catch((error) => error);
  expect(fetcher.mock.calls.at(-1)?.[0]).toBe(
    `${profile.backendOrigin}/v1/vaults/current/history?limit=50&cursor=cursor%20value`,
  );
  await api.signOut!();
  release(response({ items: [], observedAt: 1, indexedThrough: "12n" }));
  expect(await pending).toBeInstanceOf(Error);
});

it("polls a committed setup job for a blocked state and stops observing after logout without submitting a job", async () => {
  vi.useFakeTimers();
  let state: "queued" | "provisioning" | "blocked" = "queued";
  const api = backend({
    session: vi.fn(async () => ({ ...projection("poll"), account: { ...account("poll"), state } })),
  });
  let mounted!: ReturnType<typeof renderHook<ReturnType<typeof useVault>, unknown>>;
  await act(async () => {
    mounted = renderHook(() => useVault(), { wrapper: wrapper(api) });
  });
  expect(mounted.result.current.setup.provisioning).toBe("provisioning");
  state = "blocked";
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(mounted.result.current.setup.provisioning).toBe("failed");
  await act(() => mounted.result.current.signOut());
  const reads = vi.mocked(api.session!).mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(9000);
  });
  expect(api.session).toHaveBeenCalledTimes(reads);
  expect(api.autoProvisionVault).not.toHaveBeenCalled();
});

it("decodes confirmed history and acknowledged setup without a long deployment response", async () => {
  const fetcher = vi.fn(async (url: string | URL | Request) =>
    response(
      String(url).includes("/history")
        ? {
            items: [{ amount: "9007199254740993n", blockNumber: "99n", queueNonce: "0n" }],
            indexedThrough: "100n",
            observedAt: 1,
          }
        : { state: "queued" },
    ),
  );
  const api = createVaultBackend(profile, fetcher);
  expect(await api.autoProvisionVault()).toEqual({ state: "queued" });
  expect(await api.history!()).toMatchObject({
    items: [{ amount: 9007199254740993n, blockNumber: 99n, queueNonce: 0n }],
    indexedThrough: 100n,
  });
});
