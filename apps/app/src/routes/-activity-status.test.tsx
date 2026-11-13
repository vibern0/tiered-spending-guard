import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { describe, expect, it, vi } from "vitest";

const { useVaultMock } = vi.hoisted(() => ({ useVaultMock: vi.fn() }));
vi.mock("@/lib/vault-store", async (original) => ({
  ...(await original<typeof import("@/lib/vault-store")>()),
  useVault: useVaultMock,
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: object) => ({ ...options, useSearch: () => ({}) }),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
import { emptyState } from "@/lib/vault-store";
import { Route } from "./activity.index";
const ActivityPage = (Route as unknown as { component: ComponentType }).component;

describe("automatic receipt display", () => {
  it("shows a restored submission and its eventual terminal status without pressing Reconcile", () => {
    const vault = {
      state: emptyState(),
      setup: { submissionIds: ["known"] },
      reconcileSubmission: vi.fn(),
      submissions: { known: { id: "known", state: "uncertain" } },
    };
    useVaultMock.mockReturnValue(vault);
    const { rerender } = render(<ActivityPage />);
    expect(screen.getByText("uncertain")).toBeInTheDocument();
    useVaultMock.mockReturnValue({
      ...vault,
      submissions: { known: { id: "known", state: "confirmed" } },
    });
    rerender(<ActivityPage />);
    expect(screen.getByText("confirmed")).toBeInTheDocument();
    expect(screen.queryByText("uncertain")).not.toBeInTheDocument();
    expect(vault.reconcileSubmission).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Reconcile" })).toBeInTheDocument();
  });
  it("shows manual read errors while allowing a later automatic terminal status to replace them", async () => {
    const vault = {
      state: emptyState(),
      setup: { submissionIds: ["known"] },
      reconcileSubmission: vi.fn().mockRejectedValue(new Error("Status temporarily unavailable")),
      submissions: { known: { id: "known", state: "uncertain" } },
    };
    useVaultMock.mockReturnValue(vault);
    const { rerender } = render(<ActivityPage />);
    fireEvent.click(screen.getByRole("button", { name: "Reconcile" }));
    await waitFor(() =>
      expect(screen.getByText("Status temporarily unavailable")).toBeInTheDocument(),
    );
    useVaultMock.mockReturnValue({
      ...vault,
      submissions: { known: { id: "known", state: "confirmed" } },
    });
    rerender(<ActivityPage />);
    expect(screen.getByText("confirmed")).toBeInTheDocument();
    expect(screen.queryByText("Status temporarily unavailable")).not.toBeInTheDocument();
  });
});

it("distinguishes completed scheduled proposals from actual withdrawals and self transfers", () => {
  const item = {
    id: "proposal",
    kind: "transfer",
    proposal: true,
    direction: "out",
    amount: 123000000n,
    counterparty: "Recipient",
    address: "0x11",
    lane: "delayed",
    status: "executed",
    createdAt: 1,
    approvers: [],
    fingerprint: "f",
  };
  useVaultMock.mockReturnValue({
    state: {
      ...emptyState(),
      activity: [item, { ...item, id: "self", proposal: false, direction: "self" }],
    },
    setup: { submissionIds: [] },
  });
  render(<ActivityPage />);
  expect(screen.getByText("Scheduled · 123.00 USDC")).toBeInTheDocument();
  expect(screen.getByText("Self · 123.00 USDC")).toBeInTheDocument();
});
