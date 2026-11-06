import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const { useVaultMock } = vi.hoisted(() => ({ useVaultMock: vi.fn() }));
vi.mock("@/lib/vault-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vault-store")>()),
  useVault: useVaultMock,
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({
    ...(options as object),
    useParams: () => ({ id: "recipient-change" }),
  }),
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
import { emptyState } from "@/lib/vault-store";
import { Route } from "./activity.$id";
const DetailPage = (Route as unknown as { component: ComponentType }).component;
const addition = {
  id: "recipient-change",
  kind: "recipient-addition",
  direction: "out",
  amount: 0n,
  counterparty: "Recipient addition",
  address: "0x8888888888888888888888888888888888888888",
  lane: "delayed",
  status: "queued",
  canonicalNow: 100_000,
  createdAt: 100_000,
  earliestExecution: 220_000,
  expiresAt: 820_000,
  queueNonce: 0,
  txHash: `0x${"ab".repeat(32)}`,
  approvers: ["First signer", "Second signer"],
  fingerprint: "public-binding",
};
describe("recipient addition lifecycle", () => {
  beforeEach(() => vi.clearAllMocks());
  it("shows a cancellable delayed policy change without describing a payment", async () => {
    const cancelQueued = vi.fn().mockResolvedValue({ state: "confirmed" });
    useVaultMock.mockReturnValue({
      state: { ...emptyState(), activity: [addition] },
      cancelQueued,
      executeReady: vi.fn(),
    });
    render(<DetailPage />);
    expect(screen.getByText("Delayed recipient addition")).toBeInTheDocument();
    expect(screen.queryByText(/USDC.transfer/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Execute recipient addition" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel recipient addition" }));
    await waitFor(() => expect(cancelQueued).toHaveBeenCalledWith(addition));
  });
  it("uses the existing canonical queue binding when a recipient addition is ready", async () => {
    const ready = { ...addition, canonicalNow: 230_000 };
    const executeReady = vi.fn().mockResolvedValue({ state: "confirmed" });
    useVaultMock.mockReturnValue({
      state: { ...emptyState(), activity: [ready] },
      cancelQueued: vi.fn(),
      executeReady,
    });
    render(<DetailPage />);
    fireEvent.click(screen.getByRole("button", { name: "Execute recipient addition" }));
    await waitFor(() => expect(executeReady).toHaveBeenCalledWith(ready));
  });
});
