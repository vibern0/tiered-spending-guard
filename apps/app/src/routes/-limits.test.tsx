import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { useVaultMock } = vi.hoisted(() => ({ useVaultMock: vi.fn() }));
vi.mock("@/lib/vault-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vault-store")>()),
  useVault: useVaultMock,
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  Link: ({
    children,
    to,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to?: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));
import { emptyState } from "@/lib/vault-store";
import { Route } from "./limits";
const LimitsPage = (Route as unknown as { component: ComponentType }).component;
const candidate = "0x8888888888888888888888888888888888888888";
const existing = "0x7777777777777777777777777777777777777777";
const state = {
  ...emptyState(),
  writable: true,
  health: [],
  recipients: [{ name: "Existing recipient", address: existing }],
};

describe("delayed recipient addition", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the exact 120-second wait instead of rounding it up to one hour", () => {
    useVaultMock.mockReturnValue({
      state: { ...state, policy: { ...state.policy, delaySeconds: 120n, delayHours: 1 } },
      canWrite: true,
      loading: false,
      addRecipient: vi.fn(),
    });
    render(<LimitsPage />);
    expect(
      screen.getByText("Above this, transfers wait 120 seconds and can be cancelled."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/transfers wait 1 hours/i)).not.toBeInTheDocument();
  });

  it("shows the first-signer allowance as fully used after instant spending crosses it", () => {
    useVaultMock.mockReturnValue({
      state: { ...state, spentFirstSigner: 900_000n, spentInstant: 1_100_000n },
      canWrite: true,
      loading: false,
      addRecipient: vi.fn(),
    });

    render(<LimitsPage />);

    expect(screen.getByText("1.00 USDC of 1.00 USDC")).toBeInTheDocument();
    expect(screen.getByText("1.10 USDC of 3.00 USDC")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "First signer today" })).toHaveAttribute(
      "aria-valuenow",
      "100",
    );
  });

  it("reviews one address and both approvals before queuing, without showing it as already allowed", async () => {
    const addRecipient = vi.fn().mockResolvedValue({ id: "addition", state: "confirmed" });
    useVaultMock.mockReturnValue({ state, canWrite: true, loading: false, addRecipient });
    render(<LimitsPage />);
    fireEvent.change(screen.getByRole("textbox", { name: "New recipient address" }), {
      target: { value: candidate },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review recipient addition" }));
    expect(screen.getByText(candidate)).toBeInTheDocument();
    expect(screen.getByText(/First signer, then second signer/i)).toBeInTheDocument();
    expect(addRecipient).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Approve delayed recipient addition" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/queued/i));
    expect(addRecipient).toHaveBeenCalledWith(candidate);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "View in Activity" })).toHaveAttribute(
      "href",
      "/activity",
    );
  });

  it("rejects zero and duplicate addresses without offering approval", () => {
    useVaultMock.mockReturnValue({ state, canWrite: true, loading: false, addRecipient: vi.fn() });
    render(<LimitsPage />);
    for (const value of ["0x0000000000000000000000000000000000000000", existing]) {
      fireEvent.change(screen.getByRole("textbox", { name: "New recipient address" }), {
        target: { value },
      });
      fireEvent.click(screen.getByRole("button", { name: "Review recipient addition" }));
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Approve delayed recipient addition" }),
      ).not.toBeInTheDocument();
    }
  });

  it("keeps historical policy read-only and links to preserved fresh setup", () => {
    useVaultMock.mockReturnValue({
      state: { ...state, compatibility: { mode: "read-only" } },
      canWrite: false,
      loading: false,
    });
    render(<LimitsPage />);
    expect(
      screen.queryByRole("textbox", { name: "New recipient address" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start a new test vault" })).toHaveAttribute(
      "href",
      "/onboarding",
    );
    expect(
      screen.getByText("Required for all transfers on this earlier vault."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Everyday transfers within X may use any valid/i),
    ).not.toBeInTheDocument();
  });
});
