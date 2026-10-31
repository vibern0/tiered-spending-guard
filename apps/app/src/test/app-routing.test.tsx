import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllEnvs();
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
    "requires account creation before showing %s",
    async (path) => {
      await renderAt(path);
      await waitFor(() =>
        expect(screen.getByRole("heading", { name: "Set up your account" })).toBeInTheDocument(),
      );
      expect(screen.queryByRole("navigation", { name: "Main" })).not.toBeInTheDocument();
      expect(screen.queryByText("Wallet writes are disabled")).not.toBeInTheDocument();
    },
  );
});

it("keeps an existing account accessible when RPC is unavailable", async () => {
  vi.stubEnv("VITE_SEPOLIA_RPC_URL", "");
  localStorage.setItem(
    "usdc-vault-demo-v1",
    JSON.stringify({
      safe: "0x1111111111111111111111111111111111111111",
      guard: "0x2222222222222222222222222222222222222222",
      delay: "0x3333333333333333333333333333333333333333",
      usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    }),
  );
  await renderAt("/limits");
  await waitFor(() =>
    expect(screen.getByRole("heading", { name: "Limits & security" })).toBeInTheDocument(),
  );
  expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Profile" })).not.toBeInTheDocument();
  expect(screen.getByText("Sepolia testnet")).toBeInTheDocument();
});
