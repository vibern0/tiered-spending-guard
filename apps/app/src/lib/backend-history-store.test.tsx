import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  useVault,
  VaultProvider,
  type VaultBackend,
  type VaultProvisioningResult,
} from "./vault-store";
import type { HistoryPage } from "./backend-history";
import { BackendRequestError } from "./provisioning-errors";
vi.mock("./vault-chain", () => ({
  readVaultSnapshot: vi.fn(async () => ({
    chainId: 11155111,
    safe: `0x${"11".repeat(20)}`,
    queueItems: [],
    health: [],
    writable: false,
  })),
}));
afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  vi.restoreAllMocks();
});
const address = `0x${"11".repeat(20)}` as const;
const hash = `0x${"11".repeat(32)}` as const;
const vault: VaultProvisioningResult = {
  chainId: 11155111,
  safe: address,
  guard: address,
  delay: address,
  primaryPasskey: address,
  secondaryPasskey: address,
  usdc: address,
  evidence: { setupTransactionHash: hash, verificationReportHash: hash, blockNumber: "1" },
};
const page = (id: string, nextCursor?: string): HistoryPage => ({
  items: [
    {
      id,
      kind: "transfer",
      transactionHash: hash,
      blockHash: hash,
      logIndex: 0,
      blockNumber: 1n,
      timestamp: 1,
      direction: "in",
      amount: 123n,
      counterparty: address,
    },
  ],
  ...(nextCursor ? { nextCursor } : {}),
  observedAt: 2,
});
function mount(
  history: NonNullable<VaultBackend["history"]>,
  overrides: Partial<VaultBackend> = {},
) {
  const api: VaultBackend = {
    session: vi.fn(async () => ({
      authenticated: true,
      account: { id: "a", userHandle: "a", state: "verified" as const, vault },
    })),
    signOut: vi.fn(async () => ({ authenticated: false })),
    registerPasskey: vi.fn(),
    autoProvisionVault: vi.fn(),
    prepareIntent: vi.fn(),
    submit: vi.fn(),
    submission: vi.fn(),
    history,
    ...overrides,
  };
  return renderHook(() => useVault(), {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(VaultProvider, { backend: api, children }),
  });
}
it("loads deposits and appends validated cursor pages through the account store", async () => {
  const history = vi.fn(async (cursor?: string) =>
    cursor ? page("older") : page("deposit", "next"),
  );
  const { result } = mount(history);
  await waitFor(() => expect(result.current.state.activity[0]?.id).toBe("deposit"));
  expect(result.current.historyHasMore).toBe(true);
  await act(() => result.current.loadMoreHistory());
  expect(history).toHaveBeenLastCalledWith("next");
  expect(result.current.state.activity.map((item) => item.id)).toEqual(["deposit", "older"]);
  expect(result.current.historyHasMore).toBe(false);
});
it("drops a history response from the previous account generation after logout", async () => {
  let release!: (page: HistoryPage) => void;
  const { result } = mount(
    vi.fn(
      async () =>
        new Promise<HistoryPage>((resolve) => {
          release = resolve;
        }),
    ),
  );
  await waitFor(() => expect(result.current.accountId).toBe("a"));
  await act(() => result.current.signOut());
  await act(async () => {
    release(page("private-old-deposit"));
  });
  expect(result.current.state.activity).toEqual([]);
  expect(result.current.accountId).toBeUndefined();
});

it("restores exact public amounts and times for unresolved app submissions without a history event", async () => {
  const { result } = mount(async () => ({ items: [], observedAt: 2 }), {
    session: async () => ({
      authenticated: true,
      account: { id: "a", userHandle: "a", state: "verified", vault, submissionIds: ["pending"] },
    }),
    submission: async () => ({
      id: "pending",
      state: "uncertain",
      kind: "step-up-transfer",
      transactionHash: hash,
      createdAt: 123000,
      publicRequest: {
        intent: { kind: "transfer", recipient: address, amount: "9007199254740993" },
      },
    }),
  });
  await waitFor(() => expect(result.current.state.activity[0]?.id).toBe("submission:pending"));
  expect(result.current.state.activity[0]).toMatchObject({
    amount: 9007199254740993n,
    address,
    createdAt: 123000,
    status: "submitting",
    txHash: hash,
    lane: "step-up",
  });
});

it.each([
  ["base-transfer", "base", "uncertain"],
  ["step-up-transfer", "step-up", "reverted"],
  ["queue-transfer", "delayed", "uncertain"],
] as const)(
  "restores %s from canonical decimal metadata without guessing a generic transfer lane",
  async (preparedKind, lane, state) => {
    const { result } = mount(async () => ({ items: [], observedAt: 2 }), {
      session: async () => ({
        authenticated: true,
        account: {
          id: "a",
          userHandle: "a",
          state: "verified",
          vault,
          submissionIds: ["restored"],
        },
      }),
      submission: async () => ({
        id: "restored",
        state,
        kind: "transfer",
        transactionHash: hash,
        publicRequest: {
          kind: "transfer",
          preparedKind,
          intent: { kind: "transfer", amount: "500000", recipient: address },
        },
      }),
    });
    await waitFor(() => expect(result.current.state.activity[0]?.id).toBe("submission:restored"));
    expect(result.current.state.activity[0]).toMatchObject({
      amount: 500000n,
      lane,
      status: state === "reverted" ? "failed" : "submitting",
    });
  },
);
it.each(["1e6", "0x10", "-1", "01", "1.5", "", "9".repeat(79)])(
  "keeps malformed journal amount %j unsupported",
  async (amount) => {
    const { result } = mount(async () => ({ items: [], observedAt: 2 }), {
      session: async () => ({
        authenticated: true,
        account: { id: "a", userHandle: "a", state: "verified", vault, submissionIds: ["bad"] },
      }),
      submission: async () => ({
        id: "bad",
        state: "uncertain",
        kind: "transfer",
        publicRequest: { intent: { kind: "transfer", amount, recipient: address } },
      }),
    });
    await waitFor(() => expect(result.current.state.activity[0]?.id).toBe("submission:bad"));
    expect(result.current.state.activity[0]).toMatchObject({
      kind: "unsupported",
      lane: "blocked",
      status: "submitting",
    });
  },
);
it("does not guess a delayed lane for a generic transfer without persisted prepared kind", async () => {
  const { result } = mount(async () => ({ items: [], observedAt: 2 }), {
    session: async () => ({
      authenticated: true,
      account: { id: "a", userHandle: "a", state: "verified", vault, submissionIds: ["generic"] },
    }),
    submission: async () => ({
      id: "generic",
      state: "uncertain",
      kind: "transfer",
      publicRequest: { intent: { kind: "transfer", amount: "500000", recipient: address } },
    }),
  });
  await waitFor(() => expect(result.current.state.activity[0]?.id).toBe("submission:generic"));
  expect(result.current.state.activity[0]).toMatchObject({
    amount: 500000n,
    lane: "blocked",
    status: "submitting",
  });
});
it("refreshes the loaded history range on polling using fresh canonical cursors", async () => {
  vi.useFakeTimers();
  let revision = 0;
  const history = vi.fn(async (cursor?: string) =>
    cursor
      ? page(revision ? "canonical-older" : "older")
      : page(revision ? "canonical-newer" : "newer", revision ? "new-cursor" : "old-cursor"),
  );
  let mounted!: ReturnType<typeof renderHook<ReturnType<typeof useVault>, unknown>>;
  await act(async () => {
    mounted = mount(history);
  });
  await act(() => mounted.result.current.loadMoreHistory());
  expect(mounted.result.current.state.activity.map((item) => item.id)).toEqual(["newer", "older"]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(mounted.result.current.state.activity.map((item) => item.id)).toEqual(["newer", "older"]);
  expect(history).toHaveBeenCalledTimes(4);
  revision = 1;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(history).toHaveBeenLastCalledWith("new-cursor");
  expect(mounted.result.current.state.activity.map((item) => item.id)).toEqual([
    "canonical-newer",
    "canonical-older",
  ]);
  expect(history).toHaveBeenCalledTimes(6);
});
it("invalidates loaded cached rows when the server rejects their canonical cursor", async () => {
  const history = vi.fn(async (cursor?: string) => {
    if (cursor)
      throw new BackendRequestError({ status: 400, message: "account request failed safely" });
    return page("old", "invalidated-cursor");
  });
  const { result } = mount(history);
  await waitFor(() => expect(result.current.state.activity[0]?.id).toBe("old"));
  await act(() => result.current.loadMoreHistory());
  expect(result.current.state.activity).toEqual([]);
  expect(result.current.historyHasMore).toBe(false);
  expect(result.current.historyError).toBeDefined();
});
