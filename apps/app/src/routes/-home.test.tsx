import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { useVaultMock } = vi.hoisted(() => ({ useVaultMock: vi.fn() }));

vi.mock("@/lib/vault-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vault-store")>()),
  useVault: useVaultMock,
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  Link: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props}>{children}</a>
  ),
}));

import { emptyState } from "@/lib/vault-store";
import { Route as HomeRoute } from "./index";

const HomePage = (HomeRoute as unknown as { component: ComponentType }).component;

describe("home vault refresh", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lets the user explicitly refresh the verified vault snapshot", () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    useVaultMock.mockReturnValue({
      state: {
        ...emptyState(),
        safe: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        onboarding: { firstSigner: true, secondSigner: true, limits: true, rehearsed: true },
      },
      canWrite: true,
      loading: false,
      refresh,
    });

    render(<HomePage />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh account" }));

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("shows the first-signer allowance as fully used after instant spending crosses it", () => {
    useVaultMock.mockReturnValue({
      state: {
        ...emptyState(),
        safe: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        spentFirstSigner: 900_000n,
        spentInstant: 1_100_000n,
        onboarding: { firstSigner: true, secondSigner: true, limits: true, rehearsed: true },
      },
      canWrite: true,
      loading: false,
      refresh: vi.fn(),
    });

    render(<HomePage />);

    expect(screen.getByText("1.00 USDC / 1.00 USDC")).toBeInTheDocument();
    expect(screen.getByText("1.10 USDC / 3.00 USDC")).toBeInTheDocument();
    expect(screen.queryByText("0.90 USDC / 1.00 USDC")).not.toBeInTheDocument();
  });
});
