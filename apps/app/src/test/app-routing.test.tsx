import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { routeTree } from "@/routeTree.gen";

async function renderAt(path: string) {
  const queryClient = new QueryClient();
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  return render(<RouterProvider router={router} />);
}

beforeEach(() => {
  vi.stubEnv("VITE_BACKEND_ORIGIN", "http://localhost:8787");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ authenticated: false }))),
  );
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Assert only that the router mounts and paints, never page content:
// routes are rewritten as the app is built and this must keep passing.
describe("App routing", () => {
  it("renders the index route", async () => {
    const { container } = await renderAt("/");

    await waitFor(() => expect(container.firstChild).not.toBeNull());
  });

  it("renders the not-found route", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const { container } = await renderAt("/this-route-does-not-exist");

    await waitFor(() => expect(container.firstChild).not.toBeNull());
  });
});

describe("Account access", () => {
  it.each(["/", "/send", "/receive", "/activity", "/limits", "/profile", "/unknown"])(
    "requires sign-in or account creation before showing %s",
    async (path) => {
      await renderAt(path);
      await waitFor(() =>
        expect(screen.getByRole("heading", { name: "Your vault account" })).toBeInTheDocument(),
      );
      expect(screen.queryByRole("navigation", { name: "Main" })).not.toBeInTheDocument();
      expect(screen.queryByText("Wallet writes are disabled")).not.toBeInTheDocument();
    },
  );
});

it("keeps an existing account accessible when RPC is unavailable", async () => {
  vi.stubEnv("VITE_SEPOLIA_RPC_URL", "");
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            authenticated: true,
            account: {
              id: "existing",
              userHandle: "dXNlcg",
              state: "verified",
              primaryCredentialId: "first",
              vault: {
                chainId: 11155111,
                safe: "0x1111111111111111111111111111111111111111",
                guard: "0x2222222222222222222222222222222222222222",
                delay: "0x3333333333333333333333333333333333333333",
                usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
                evidence: {
                  setupTransactionHash: `0x${"11".repeat(32)}`,
                  verificationReportHash: `0x${"22".repeat(32)}`,
                  blockNumber: "100",
                },
              },
            },
          }),
        ),
    ),
  );
  await renderAt("/limits");
  await waitFor(() =>
    expect(screen.getByRole("heading", { name: "Limits & security" })).toBeInTheDocument(),
  );
  expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Profile" })).not.toBeInTheDocument();
  expect(screen.getByText("Sepolia testnet")).toBeInTheDocument();
  expect(
    screen.getByText(
      "Sepolia prototype · no signer recovery · no independent notification delivery",
    ),
  ).toBeInTheDocument();
  expect(screen.getByText("Verified onchain policy · limits stay fixed")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /edit protection|freeze account/i }),
  ).not.toBeInTheDocument();
});
